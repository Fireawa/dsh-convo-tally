/**
 * 客户端 bundle 自测。
 *
 * 覆盖:两个贡献的注册、探针→侧栏联动、切换会话跟随、
 * 两位小数、美元/人民币切换、按会话重置、以及各种降级不崩。
 */

let failed = 0
const check = (name, actual, expected) => {
  if (Object.is(actual, expected)) { console.log('  ok   ' + name); return }
  failed += 1
  console.log('  FAIL ' + name + '  actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}

// ── 假 localStorage ──────────────────────────────────────────────
const mem = new Map()
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: k => { mem.delete(k) },
}

// ── 假 DOM ───────────────────────────────────────────────────────
const styles = []
global.document = {
  head: { appendChild: t => styles.push(t) },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
}
global.setInterval = () => 0
global.clearInterval = () => {}

// ── 假 React ─────────────────────────────────────────────────────
/** 收集 effect 的清理函数,用来模拟卸载。 */
const cleanups = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: fn => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
}

let exports
const loaded = []
global.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec)
      exports = spec.factory(name => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

await import('../lib/client.js')

const textOf = tree => {
  const out = []
  const walk = n => {
    if (n === null || n === undefined || n === false) return
    if (typeof n === 'string') { out.push(n); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  return out.join(' ')
}

const buttonsOf = tree => {
  const out = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'button') out.push(n)
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  return out
}

const todayKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const view = over => ({
  sessionId: 'session-a',
  todayCny: 3.82, todayUsd: 0.53,
  totalCny: 12.34, totalUsd: 1.71,
  dayKey: todayKey, calls: 9, unpriced: 0,
  ...over,
})

console.log('\n[1] bundle 注册')
check('只注册一个模块', loaded.length, 1)
check('模块 id', loaded[0].id, 'dsh-convo-tally')
check('inject 含 slots', JSON.stringify(exports.inject), JSON.stringify(['slots']))
check('注入了一条样式', styles.length, 1)

console.log('\n[2] 两个贡献')
const regs = []
exports.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, component: c }); return () => {} } } })
check('注册 2 个', regs.length, 2)
const Probe = regs.find(r => r.spec.id === 'convo-tally-probe').component
const Widget = regs.find(r => r.spec.id === 'convo-tally').component
check('探针在 composer.dock', regs.find(r => r.spec.id === 'convo-tally-probe').spec.name, 'conversation.composer.dock')
check('挂件在 sidebar.footer', regs.find(r => r.spec.id === 'convo-tally').spec.name, 'sidebar.footer.action')

console.log('\n[3] 两位小数 + 联动')
check('探针返回 null', Probe({ useProjection: () => view() }), null)
const t1 = textOf(Widget())
check('今日 ¥3.82', t1.includes('¥3.82'), true)
check('累计 ¥12.34', t1.includes('¥12.34'), true)
check('小额也两位(0.0034 → ¥0.00)', textOf((Probe({ useProjection: () => view({ todayCny: 0.0034, totalCny: 0.0034 }) }), Widget())).includes('¥0.00'), true)

console.log('\n[4] 切换会话跟随')
Probe({ useProjection: () => view({ sessionId: 'session-b', todayCny: 9.99, totalCny: 88.88 }) })
const t2 = textOf(Widget())
check('今日 ¥9.99', t2.includes('¥9.99'), true)
check('累计 ¥88.88', t2.includes('¥88.88'), true)
check('不残留 ¥3.82', t2.includes('¥3.82'), false)

console.log('\n[5] 币种切换')
Probe({ useProjection: () => view() })
const before = textOf(Widget())
check('默认人民币', before.includes('¥12.34'), true)
const currencyBtn = buttonsOf(Widget()).find(b => ['¥', '$'].includes(b.children[0]))
check('找到币种按钮', currencyBtn !== undefined, true)
currencyBtn.props.onClick()
const after = textOf(Widget())
check('切到美元显示 $1.71', after.includes('$1.71'), true)
check('可用官方美元表的值($0.53)', after.includes('$0.53'), true)
check('币种已持久化', mem.get('dsh-convo-tally/currency'), '"USD"')
buttonsOf(Widget()).find(b => ['¥', '$'].includes(b.children[0])).props.onClick()
check('再点回人民币', textOf(Widget()).includes('¥12.34'), true)

console.log('\n[6] 重置只清「累计」,「今日」不动')
Probe({ useProjection: () => view() })   // 今日 ¥3.82 / 累计 ¥12.34
const resetBtn = buttonsOf(Widget()).find(b => b.children[0] === '重置')
check('找到重置按钮', resetBtn !== undefined, true)
resetBtn.props.onClick()
const afterReset = textOf(Widget())
check('今日保持真实值 ¥3.82', afterReset.includes('¥3.82'), true)
check('累计归零', afterReset.includes('¥0.00'), true)
check('只有累计那一处是 0.00', (afterReset.match(/¥0\.00/g) || []).length, 1)
const saved = JSON.parse(mem.get('dsh-convo-tally/reset'))
check('基线按会话保存', saved['session-a'] !== undefined, true)
check('基线只记累计', saved['session-a'].totalCny, 12.34)
check('不再记录今日基线', saved['session-a'].todayCny === undefined, true)

console.log('\n[7] 重置只影响自己的会话')
Probe({ useProjection: () => view({ sessionId: 'session-b', todayCny: 9.99, totalCny: 88.88 }) })
const other = textOf(Widget())
check('另一个会话累计不受影响(¥88.88)', other.includes('¥88.88'), true)
check('另一个会话今日也正常(¥9.99)', other.includes('¥9.99'), true)

console.log('\n[8] 重置后今日仍真实 / 旧的今日不显示')
mem.set('dsh-convo-tally/reset', JSON.stringify({
  'session-a': { totalCny: 12.34, totalUsd: 1.71 },
}))
Probe({ useProjection: () => view({ sessionId: 'session-a', dayKey: todayKey, todayCny: 5.5, totalCny: 20 }) })
const mixed = textOf(Widget())
check('今日显示真实值 ¥5.50', mixed.includes('¥5.50'), true)
check('累计 = 20-12.34 = ¥7.66', mixed.includes('¥7.66'), true)
// 情形二:投影的最后计费日不是今天 → 今日显示 0,累计照常
Probe({ useProjection: () => view({ sessionId: 'session-a', dayKey: '2000-01-01', todayCny: 5.5, totalCny: 20 }) })
const staleDay = textOf(Widget())
check('最后计费日不是今天 → 今日 ¥0.00', staleDay.includes('¥0.00'), true)
check('累计仍显示 ¥7.66', staleDay.includes('¥7.66'), true)

console.log('\n[9] 降级')
Probe({})
check('没有 useProjection → —', textOf(Widget()).includes('—'), true)
check('重置按钮在无数据时禁用', buttonsOf(Widget()).find(b => b.children[0] === '重置').props.disabled, true)

console.log('\n[10] 探针卸载后不留假数据')
cleanups.length = 0
const valueA = view({ todayCny: 4.44, totalCny: 4.44 })
Probe({ useProjection: () => valueA })
check('卸载前有值 ¥4.44', textOf(Widget()).includes('¥4.44'), true)
cleanups.forEach(fn => fn())
check('卸载后归为 —(不残留上一个对话)', textOf(Widget()).includes('—'), true)

console.log('\n[11] 旧探针卸载不影响新探针')
cleanups.length = 0
const valueOld = view({ sessionId: 'session-old', todayCny: 1.11, totalCny: 1.11 })
const valueNew = view({ sessionId: 'session-new', todayCny: 2.22, totalCny: 2.22 })
Probe({ useProjection: () => valueOld })
Probe({ useProjection: () => valueNew })
cleanups[0]()   // 旧探针卸载
check('新探针的值还在(¥2.22)', textOf(Widget()).includes('¥2.22'), true)
cleanups[1]()   // 新探针卸载
check('全部卸载后才清空', textOf(Widget()).includes('—'), true)

console.log('\n[12] 重置基线有上限,不会无限增长')
for (let i = 0; i < 60; i++) {
  Probe({ useProjection: () => view({ sessionId: 'session-' + i, todayCny: 1, totalCny: 1 }) })
  buttonsOf(Widget()).find(b => b.children[0] === '重置').props.onClick()
}
const store = JSON.parse(mem.get('dsh-convo-tally/reset'))
const keyCount = Object.keys(store).length
check('基线条目 ≤ 50', keyCount <= 50, true)
check('最新的那条还在', store['session-59'] !== undefined, true)
check('最旧的已被淘汰', store['session-0'] === undefined, true)

console.log('\n[13] 账单:近 7 天每天的费用')
/** 取账单面板里的行(7 天 + 合计)。 */
const billRowNodes = tree => {
  const out = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n.props?.className === 'string' && n.props.className.includes('ccw-bill-row')) out.push(n)
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  return out
}
const billButton = () => buttonsOf(Widget()).find(b => b.children[0] === '账单')
const shiftDay = (key, delta) => new Date(Date.parse(key + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10)

const todayK = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const yestK = shiftDay(todayK, -1)
const daysFixture = [
  { day: yestK, cny: 1.5, usd: 0.21, calls: 4 },
  { day: todayK, cny: 3.82, usd: 0.53, calls: 9 },
]

// 先确保面板关闭(前面几节可能没碰过它)
if (billButton() && billRowNodes(Widget()).length > 0) billButton().props.onClick()
check('按钮存在且默认关闭', billRowNodes(Widget()).length, 0)

Probe({ useProjection: () => view({ sessionId: 'session-a', dayKey: todayK, todayCny: 3.82, totalCny: 5.32, days: daysFixture }) })
billButton().props.onClick()
const billText = textOf(Widget())
check('面板出现', billRowNodes(Widget()).length, 8)   // 7 天 + 合计
check('标题含「近 7 天」', billText.includes('近 7 天'), true)
check('今天那行显示 ¥3.82', billText.includes('¥3.82'), true)
check('昨天那行显示 ¥1.50', billText.includes('¥1.50'), true)
check('合计 = 3.82 + 1.50 = ¥5.32', billText.includes('¥5.32'), true)
check('没有数据的日子显示 ¥0.00', billText.includes('¥0.00'), true)

// 切币种:面板跟着变
buttonsOf(Widget()).find(b => ['¥', '$'].includes(b.children[0])).props.onClick()
const billUsd = textOf(Widget())
check('面板切到美元 $0.53', billUsd.includes('$0.53'), true)
check('面板合计 $0.74', billUsd.includes('$0.74'), true)
buttonsOf(Widget()).find(b => ['¥', '$'].includes(b.children[0])).props.onClick()

// 重置只影响累计,不影响账单里的历史
buttonsOf(Widget()).find(b => b.children[0] === '重置').props.onClick()
check('重置后账单里今天仍是 ¥3.82', textOf(Widget()).includes('¥3.82'), true)

// 再点一次收起
billButton().props.onClick()
check('再点收起', billRowNodes(Widget()).length, 0)

// 老宿主没有 days 字段时,不崩、显示全 0
Probe({ useProjection: () => view({ sessionId: 'session-a', days: undefined }) })
billButton().props.onClick()
const noDays = textOf(Widget())
check('没有 days 也不崩', billRowNodes(Widget()).length, 8)
check('全部显示 ¥0.00', /近 7 天/.test(noDays) && noDays.includes('¥0.00'), true)
billButton().props.onClick()

console.log('\n[14] 容错')
for (const [label, ctx] of [['空 ctx', {}], ['slots undefined', { slots: undefined }], ['slots 形状不对', { slots: { register: 'x' } }]]) {
  let threw = false
  try { exports.apply(ctx) } catch (err) { threw = true }
  check(label + ' 不抛异常', threw, false)
}

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
