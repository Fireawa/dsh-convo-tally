/**
 * 属性测试:随机生成会话事件流,用**结构不同的独立参考实现**逐字段对账。
 *
 * 目的:真实日志覆盖不到的边界(跨天替换、重试、fork 前缀、重复查询、失败的搜索、
 * 未知模型、8 天裁剪)在这里高频出现,能抓出折叠逻辑的回归。
 *
 * 参考实现刻意用「turn:step → 槽位表」而不是插件那种「只记最后一个槽」的写法,
 * 只对金额类字段做严格比对;unpriced 口径容易与实现纠缠,只检查范围不变量。
 *
 * 随机源是**固定种子的 mulberry32**,所以每次运行完全可复现。
 */

import { convoCostProjection as P } from '../lib/index.js'
import { costOf } from '../lib/pricing.js'

const FEE_START = Date.parse('2026-11-01T00:00:00+08:00')
const KEPT = 8
const PENDING_CAP = 32
const SESSIONS = 200

let failed = 0
function check(name, actual, expected) {
  if (Object.is(actual, expected)) { console.log('  ok   ' + name); return }
  failed += 1
  console.log('  FAIL ' + name + '\n       actual   = ' + JSON.stringify(actual) + '\n       expected = ' + JSON.stringify(expected))
}

/** 固定种子随机数(mulberry32),保证可复现。 */
function makeRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const zero = () => ({ cny: 0, usd: 0, calls: 0 })
const bjDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
const clamp = x => (x > 0 ? x : 0)
const pruneDays = days => {
  const keys = Object.keys(days).sort()
  if (keys.length <= KEPT) return days
  const out = {}
  for (const key of keys.slice(keys.length - KEPT)) out[key] = days[key]
  return out
}

/** 独立参考实现:槽位用 Map 按 turn:step 存,不用「最后一个槽」。 */
function reference(events, header, inherited) {
  let total = zero()
  let web = zero()
  let days = {}
  let model = header?.config?.model ?? ''
  const slots = new Map()
  const pending = new Map()
  const addDay = (day, dCny, dUsd, dCalls) => {
    const cur = days[day] ?? zero()
    days[day] = {
      cny: clamp(cur.cny + dCny),
      usd: clamp(cur.usd + dUsd),
      calls: Math.max(0, cur.calls + dCalls),
    }
  }
  for (const ev of events) {
    if (ev.type === 'request/header') {
      const m = ev.data?.header?.config?.model
      if (typeof m === 'string' && m) model = m
      continue
    }
    if (Number(ev.seq) < inherited) continue
    if (ev.type === 'llm/retry-started') { slots.delete(ev.data?.turn + ':' + ev.data?.step); continue }
    if (ev.type === 'tool/call') {
      if (ev.data?.name !== 'web_search') continue
      const id = ev.data?.callId
      if (typeof id !== 'string' || id === '') continue
      let n = 1
      try {
        const q = JSON.parse(ev.data.arguments ?? '{}').queries
        if (Array.isArray(q)) {
          const distinct = new Set(q.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))
          if (distinct.size > 0) n = distinct.size
        }
      } catch (err) { /* 参数非法按 1 次 */ }
      pending.set(id, { at: Number(ev.time) || 0, n })
      while (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value)
      continue
    }
    if (ev.type === 'tool/result') {
      const id = ev.data?.message?.toolCallId
      if (!pending.has(id)) continue
      const { at, n } = pending.get(id)
      pending.delete(id)
      const failure = ev.data?.message?.isError === true || ev.data?.error !== undefined
      if (failure || at < FEE_START) continue
      const cny = 0.005 * n
      const usd = 0.00075 * n
      total = { ...total, cny: total.cny + cny, usd: total.usd + usd }
      web = { ...web, cny: web.cny + cny, usd: web.usd + usd, calls: web.calls + n }
      addDay(bjDay(at), cny, usd, 0)
      continue
    }
    if (ev.type === 'web/deepseek-search-llm-request') {
      const at = Number(ev.time) || 0
      const body = ev.data?.body
      let input = 0
      if (body !== null && body !== undefined) {
        const text = JSON.stringify({ messages: body.messages, tools: body.tools })
        let cjk = 0
        let other = 0
        for (let i = 0; i < text.length; i += 1) {
          const c = text.charCodeAt(i)
          const isCjk = (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf)
            || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)
          if (isCjk) cjk += 1
          else other += 1
        }
        input = Math.ceil(cjk / 1.5 + other / 4)
      }
      const bodyModel = typeof body?.model === 'string' && body.model !== '' ? body.model : ''
      const tokens = { input, output: 80, cacheRead: 0, cacheWrite: 0 }
      let priced = costOf(bodyModel !== '' ? bodyModel : model, tokens, at)
      if (!priced.priced && bodyModel !== '' && model !== '') priced = costOf(model, tokens, at)
      if (priced.cny <= 0 && priced.usd <= 0) continue
      total = { ...total, cny: total.cny + priced.cny, usd: total.usd + priced.usd }
      web = { ...web, cny: web.cny + priced.cny, usd: web.usd + priced.usd }
      addDay(bjDay(at), priced.cny, priced.usd, 0)
      continue
    }
    if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') continue
    const usage = ev.type === 'assistant/message' ? ev.data?.usage : (() => {
      const stream = ev.data?.stream ?? []
      for (let i = stream.length - 1; i >= 0; i -= 1) {
        const rec = stream[i]
        if (rec && rec.type === 'chunk' && rec.chunk && rec.chunk.type === 'usage') return rec.chunk.usage
      }
      return undefined
    })()
    if (!usage) continue
    const buckets = {
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      cacheWrite: Number(usage.cacheWriteTokens) || 0,
    }
    const key = ev.data?.turn + ':' + ev.data?.step
    const previous = slots.get(key)
    if (previous !== undefined
      && previous.buckets.input === buckets.input && previous.buckets.output === buckets.output
      && previous.buckets.cacheRead === buckets.cacheRead && previous.buckets.cacheWrite === buckets.cacheWrite) continue
    const at = Number(ev.time) || 0
    const cost = costOf(model, buckets, at)
    const day = bjDay(at)
    if (previous !== undefined && previous.day !== day) addDay(previous.day, -previous.cny, -previous.usd, -1)
    addDay(day,
      cost.cny - (previous !== undefined && previous.day === day ? previous.cny : 0),
      cost.usd - (previous !== undefined && previous.day === day ? previous.usd : 0),
      previous === undefined ? 1 : 0)
    total = {
      cny: clamp(total.cny + cost.cny - (previous ? previous.cny : 0)),
      usd: clamp(total.usd + cost.usd - (previous ? previous.usd : 0)),
      calls: total.calls + (previous === undefined ? 1 : 0),
    }
    slots.set(key, { cny: cost.cny, usd: cost.usd, day, buckets })
  }
  return { total, web, days: pruneDays(days) }
}

const MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'mystery-model']

/** 生成一个随机会话。 */
function generate(random) {
  const int = n => Math.floor(random() * n)
  const inherited = random() < 0.2 ? 1 + int(20) : 0
  const header = { id: 'property', config: { model: MODELS[int(3)] } }
  const events = []
  let seq = 0
  let clock = Date.parse('2026-10-28T00:00:00+08:00') + int(20) * 86400000
  const nextTime = () => { clock += int(3) * 3600000 + int(60) * 60000; return clock }
  const usage = () => ({
    inputTokens: Math.abs(int(2000000)),
    outputTokens: int(5000),
    cacheReadTokens: int(400000),
    cacheWriteTokens: random() < 0.1 ? int(1000) : 0,
  })
  for (let turn = 1; turn <= 1 + int(3); turn += 1) {
    seq += 1
    events.push({ type: 'request/header', seq, time: nextTime(), data: { header: { config: { model: MODELS[int(4)] } } } })
    if (random() < 0.4) {
      const callId = 'c' + seq
      const queries = Array.from({ length: 1 + int(4) }, () => 'q' + int(3))
      seq += 1
      events.push({ type: 'tool/call', seq, time: nextTime(), data: { turn, step: 0, callId, name: 'web_search', arguments: JSON.stringify({ queries }) } })
      if (random() < 0.3) {
        seq += 1
        events.push({ type: 'web/deepseek-search-llm-request', seq, time: nextTime(), data: {
          body: { model: MODELS[int(4)], messages: [{ role: 'user', content: 'Perform a web search for the query: ' + '查询'.repeat(int(10)) }], tools: [{ type: 'web_search_20250305' }] },
        } })
      }
      seq += 1
      const failure = random() < 0.25
      events.push({ type: 'tool/result', seq, time: nextTime(), data: {
        turn, step: 0, message: { toolCallId: callId, isError: failure }, ...(failure ? { error: { code: 'WEB_PROVIDER_ERROR' } } : {}),
      } })
    }
    for (let step = 1; step <= 1 + int(4); step += 1) {
      seq += 1
      events.push({ type: 'assistant/message', seq, time: nextTime(), data: { turn, step, usage: usage() } })
      if (random() < 0.15) { seq += 1; events.push({ type: 'assistant/message', seq, time: nextTime(), data: { turn, step, usage: usage() } }) }
      if (random() < 0.1) { seq += 1; events.push({ type: 'llm/retry-started', seq, time: nextTime(), data: { turn, step } }) }
    }
  }
  return { header, events, inherited }
}

const random = makeRandom(20261114)
const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-9
let mismatches = 0
let negatives = 0
let unpricedOutOfRange = 0

for (let index = 0; index < SESSIONS; index += 1) {
  const { header, events, inherited } = generate(random)
  let state = P.init(header, inherited)
  for (const ev of events) state = P.apply(state, ev)
  const want = reference(events, header, inherited)
  const web = state.web ?? zero()
  const days = state.days ?? {}

  if (!near(state.total.cny, want.total.cny) || !near(state.total.usd, want.total.usd)
    || state.total.calls !== want.total.calls || !near(web.cny, want.web.cny)
    || web.calls !== want.web.calls) {
    mismatches += 1
    if (mismatches <= 3) {
      console.log('  ✗ #' + index + ' total ' + state.total.cny.toFixed(9) + '/' + want.total.cny.toFixed(9)
        + ' web ' + web.cny.toFixed(9) + '/' + want.web.cny.toFixed(9)
        + ' calls ' + state.total.calls + '/' + want.total.calls)
    }
  }
  for (const key of new Set([...Object.keys(days), ...Object.keys(want.days)])) {
    if (!near(days[key]?.cny, want.days[key]?.cny)) {
      mismatches += 1
      if (mismatches <= 3) console.log('  ✗ #' + index + ' day ' + key)
      break
    }
  }
  if (state.total.cny < 0 || state.total.usd < 0 || state.total.calls < 0) negatives += 1
  for (const row of Object.values(days)) if (row.cny < 0 || row.usd < 0 || row.calls < 0) { negatives += 1; break }
  const settlements = events.filter(e => e.type === 'assistant/message' || e.type === 'assistant/attempt').length
  if (!(state.unpriced >= 0 && state.unpriced <= settlements)) unpricedOutOfRange += 1
}

console.log('\n[1] 与独立参考实现一致')
check('金额/调用数/按天明细全部一致(' + SESSIONS + ' 个随机会话)', mismatches, 0)
console.log('\n[2] 不变量')
check('从不出现负数', negatives, 0)
check('unpriced 在合理范围', unpricedOutOfRange, 0)

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
