/**
 * 宿主侧自测:计价(人民币 + 美元)与投影折叠语义。
 * 运行:node test/selftest.mjs
 */

import { convoCostProjection as P } from '../lib/index.js'
import { costOf, isPeakAt, peakPhase, beijingDayKey } from '../lib/pricing.js'

let failed = 0
function check(name, actual, expected, tol = 1e-12) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol
    : Object.is(actual, expected)
  if (!ok) {
    failed += 1
    console.log('  FAIL ' + name + '\n       actual   = ' + JSON.stringify(actual) + '\n       expected = ' + JSON.stringify(expected))
  } else {
    console.log('  ok   ' + name)
  }
}

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
})
const msg = (seq, time, usageObj, model, turn, step) => ({
  type: 'assistant/message', seq, time,
  data: { usage: usageObj, turn, step, header: { config: { model } } },
})
const retry = (seq, time, turn, step) => ({ type: 'llm/retry-started', seq, time, data: { turn, step } })

const init = (inherited = 0) => P.init({ id: 'session-test', config: { model: 'deepseek-flash' } }, inherited)
const fold = (state, events) => events.reduce((s, e) => P.apply(s, e), state)
const view = state => P.wire.view(state)

// 谷时:2026-10-24 是周六(周末全谷价);峰时取周五 10:00 北京
const OFFPEAK = Date.parse('2026-10-24T14:00:00Z')
const PEAK = Date.parse('2026-10-23T02:00:00Z')

// ── 1. 峰谷判定 ─────────────────────────────────────────────────
console.log('\n[1] 峰谷判定(北京 09–12 / 14–18,周末与假日全天谷价)')
check('周五 10:00 北京 = 峰', isPeakAt(Date.parse('2026-10-23T02:00:00Z')), true)
check('周五 13:00 北京 = 谷', isPeakAt(Date.parse('2026-10-23T05:00:00Z')), false)
check('周五 15:00 北京 = 峰', isPeakAt(Date.parse('2026-10-23T07:00:00Z')), true)
check('周六 10:00 北京 = 谷', isPeakAt(Date.parse('2026-10-24T02:00:00Z')), false)
check('周一 09:00 北京 = 峰(起点含)', isPeakAt(Date.parse('2026-10-26T01:00:00Z')), true)
check('周一 12:00 北京 = 谷(终点不含)', isPeakAt(Date.parse('2026-10-26T04:00:00Z')), false)

// ── 2. 两套官方价目表 ───────────────────────────────────────────
console.log('\n[2] 单价(每百万 tokens;人民币表与美元表各自独立)')
const t1 = costOf('deepseek-flash', { input: 1000, output: 1000 }, OFFPEAK)
check('flash 谷 1k+1k → ¥0.005', t1.cny, 0.005)
check('flash 谷 1k+1k → $0.00075', t1.usd, 0.00075)
const t2 = costOf('deepseek-flash', { input: 1_000_000, output: 0 }, PEAK)
check('flash 峰 1M 未命中 → ¥2', t2.cny, 2)
check('flash 峰 1M 未命中 → $0.3', t2.usd, 0.3)
check('flash 谷 1M 缓存命中 → ¥0.02',
  costOf('deepseek-flash', { input: 0, output: 0, cacheRead: 1_000_000 }, OFFPEAK).cny, 0.02)
check('flash 谷 1M 缓存命中 → $0.003',
  costOf('deepseek-flash', { input: 0, output: 0, cacheRead: 1_000_000 }, OFFPEAK).usd, 0.003)
check('pro 谷 1M 未命中 → ¥4.5',
  costOf('deepseek-v4-pro', { input: 1_000_000, output: 0 }, OFFPEAK).cny, 4.5)
check('pro 谷 1M 未命中 → $0.66',
  costOf('deepseek-v4-pro', { input: 1_000_000, output: 0 }, OFFPEAK).usd, 0.66)
check('未知模型不计价', costOf('gpt-6-astra', { input: 1_000_000, output: 0 }, OFFPEAK).priced, false)
check('两套表不是固定汇率(2/0.3 明显≠7.2)', Math.abs(2 / 0.3 - 7.2) > 0.3, true)

// ── 3. 折叠:累加 ───────────────────────────────────────────────
console.log('\n[3] 折叠:累加与「今日」')
const s = fold(init(), [
  msg(1, OFFPEAK, usage(1000, 1000), 'deepseek-flash', 1, 1),
  msg(2, OFFPEAK, usage(1000, 1000), 'deepseek-flash', 1, 2),
])
check('两次累加 totalCny = 0.01', view(s).totalCny, 0.01)
check('两次累加 totalUsd = 0.0015', view(s).totalUsd, 0.0015)
check('今日同额 todayCny = 0.01', view(s).todayCny, 0.01)
check('dayKey 为北京日 2026-10-24', view(s).dayKey, '2026-10-24')
check('调用数 2', view(s).calls, 2)
check('sessionId 透传', view(s).sessionId, 'session-test')

// ── 4. 幂等 ────────────────────────────────────────────────────
console.log('\n[4] 幂等:流式中间结果重复回报')
const e1 = msg(5, OFFPEAK, usage(1000, 500), 'deepseek-flash', 2, 1)
const s2 = P.apply(init(), e1)
const s3 = P.apply(s2, e1)
check('重复 apply 返回同一 state 引用', s3, s2)
check('金额没翻倍', view(s3).totalCny, view(s2).totalCny)
const s4 = P.apply(s2, msg(6, OFFPEAK, usage(1000, 1000), 'deepseek-flash', 2, 1))
check('旧值 ¥0.003', view(s2).totalCny, 0.003)
check('新值 ¥0.005(替换)', view(s4).totalCny, 0.005)
check('不是累加值 ¥0.008', view(s4).totalCny !== 0.008, true)

// ── 5. retry ───────────────────────────────────────────────────
console.log('\n[5] retry:新槽位,两次都计费')
const s5 = fold(init(), [
  msg(10, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 3, 1),
  retry(11, OFFPEAK, 3, 1),
  msg(12, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 3, 1),
])
check('重试后 totalCny = 2', view(s5).totalCny, 2)
check('重试后 totalUsd = 0.3', view(s5).totalUsd, 0.3)

// ── 6. 跨天 ────────────────────────────────────────────────────
console.log('\n[6] 跨天:今日重置、累计不清零')
const s6 = fold(init(), [
  msg(20, PEAK, usage(1_000_000, 0), 'deepseek-flash', 1, 1),
  msg(21, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 2, 1),
])
check('累计 = ¥3(峰 2 + 谷 1)', view(s6).totalCny, 3)
check('今日 = ¥1', view(s6).todayCny, 1)
check('dayKey 停在最后计费日', view(s6).dayKey, '2026-10-24')

// ── 7. fork ────────────────────────────────────────────────────
console.log('\n[7] fork 继承前缀不计费')
const s7 = fold(init(3), [
  msg(0, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 1, 1),
  msg(1, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 1, 2),
  msg(2, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 1, 3),
  msg(3, OFFPEAK, usage(1_000_000, 0), 'deepseek-flash', 2, 1),
])
check('只有 seq>=3 计费 → ¥1', view(s7).totalCny, 1)

// ── 8. 相位 ────────────────────────────────────────────────────
console.log('\n[8] 峰谷相位')
const p1 = peakPhase(Date.parse('2026-10-24T12:00:00Z'))
check('周六判周末', p1.weekend, true)
check('周末非峰', p1.inPeak, false)
check('下次切换 = 周一 09:00 北京', p1.nextAtMs === Date.parse('2026-10-26T01:00:00Z'), true)
const p2 = peakPhase(Date.parse('2026-10-23T02:30:00Z'))
check('峰时段 inPeak', p2.inPeak, true)
check('下次切换 = 12:00 北京', p2.nextAtMs === Date.parse('2026-10-23T04:00:00Z'), true)

// ── 9. 模型来源 ─────────────────────────────────────────────────
console.log('\n[9] 模型来自 request/header')
const reqHeader = (seq, time, model) => ({
  type: 'request/header', seq, time, data: { header: { config: { provider: 'deepseek-official', model } } },
})
const bareMsg = (seq, time, u, turn, step) => ({ type: 'assistant/message', seq, time, data: { usage: u, turn, step } })
const s9 = fold(P.init({ id: 'x' }, 0), [
  reqHeader(1, OFFPEAK, 'deepseek-flash'),
  bareMsg(2, OFFPEAK, usage(1_000_000, 0), 1, 1),
])
check('靠 request/header 拿到模型后能计价', view(s9).totalCny, 1)
check('没有未计价调用', view(s9).unpriced, 0)
const s9c = fold(P.init({ id: 'x' }, 0), [bareMsg(1, OFFPEAK, usage(1_000_000, 0), 1, 1)])
check('无模型信息 → 未计价 1', view(s9c).unpriced, 1)
check('无模型信息 → 金额 0', view(s9c).totalCny, 0)

// ── 10. schema ─────────────────────────────────────────────────
console.log('\n[10] 按天明细(供「账单」看一周)')
// 三个不同的北京日,各一笔 1M 未命中(谷价 ¥1 / $0.15)
const d1 = Date.parse('2026-10-22T14:00:00Z') // 北京 10-22 周四 22:00(谷)
const d2 = Date.parse('2026-10-23T14:00:00Z') // 10-23 周五 22:00(谷)
const d3 = Date.parse('2026-10-24T14:00:00Z') // 10-24 周六 22:00(谷)
const sDays = fold(init(), [
  msg(1, d1, usage(1_000_000, 0), 'deepseek-flash', 1, 1),
  msg(2, d2, usage(1_000_000, 0), 'deepseek-flash', 2, 1),
  msg(3, d3, usage(1_000_000, 0), 'deepseek-flash', 3, 1),
])
const vDays = view(sDays)
check('3 天各一条', vDays.days.length, 3)
check('日期升序', JSON.stringify(vDays.days.map(d => d.day)), JSON.stringify(['2026-10-22', '2026-10-23', '2026-10-24']))
check('每天 ¥1', JSON.stringify(vDays.days.map(d => d.cny)), JSON.stringify([1, 1, 1]))
check('每天 $0.15', JSON.stringify(vDays.days.map(d => d.usd)), JSON.stringify([0.15, 0.15, 0.15]))
check('每天 1 次调用', JSON.stringify(vDays.days.map(d => d.calls)), JSON.stringify([1, 1, 1]))
check('今日 = 最后一天', vDays.todayCny, 1)
check('累计 = 三天之和', vDays.totalCny, 3)

// 只有 8 天的余量:连打 10 天,最旧的两天应被裁掉
let sPrune = init()
for (let i = 1; i <= 10; i++) {
  const at = Date.parse('2026-10-' + String(i).padStart(2, '0') + 'T14:00:00Z')
  sPrune = P.apply(sPrune, msg(i, at, usage(1_000_000, 0), 'deepseek-flash', i, 1))
}
const vPrune = view(sPrune)
check('只保留 8 天', vPrune.days.length, 8)
check('保留的是最近 8 天', vPrune.days[0].day, '2026-10-03')
check('最旧的两天被裁掉', vPrune.days.some(d => d.day === '2026-10-01' || d.day === '2026-10-02'), false)
check('累计不受裁剪影响(仍是 10 天)', Math.round(vPrune.totalCny), 10)

// 同一结算槽换到另一天:两天的桶都要动
// 第二次必须有**不同**的用量,否则会被幂等规则短路(那才是正确行为)。
const sMove = fold(init(), [
  msg(1, d2, usage(1_000_000, 0), 'deepseek-flash', 1, 1),
  msg(2, d3, usage(1_000_000, 1000), 'deepseek-flash', 1, 1),
])
const vMove = view(sMove)
const dayOf = (v, key) => v.days.find(d => d.day === key)
check('前一天被扣回 0', dayOf(vMove, '2026-10-23').cny, 0)
check('前一天调用数也扣回 0', dayOf(vMove, '2026-10-23').calls, 0)
check('后一天拿到新值 ¥1.004', dayOf(vMove, '2026-10-24').cny, 1.004)
check('后一天调用数 1', dayOf(vMove, '2026-10-24').calls, 1)
check('累计 = 1.004', vMove.totalCny, 1.004)

console.log('\n[11] schema 校验')
check('state 通过', P.stateSchema.safeParse(s6).success, true)
check('view 通过', P.wire.viewSchema.safeParse(view(s6)).success, true)
check('北京日界', beijingDayKey(Date.parse('2026-10-24T15:59:59Z')), '2026-10-24')
check('stateVersion = 4', P.stateVersion, 4)

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
