/**
 * 一致性守卫:峰谷时刻表在宿主(lib/pricing.js)与客户端(lib/client.js)各存一份。
 *
 * 客户端那份是"展示用"——它必须能随墙上时钟变化,不能等会话事件,
 * 所以没法从宿主直接拿。代价是两份常量可能悄悄漂移,这个测试就是拦它的。
 *
 * 运行:node test/consistency.mjs
 */

import { readFileSync } from 'node:fs'

let failed = 0
const check = (name, actual, expected) => {
  if (Object.is(actual, expected)) { console.log('  ok   ' + name); return }
  failed += 1
  console.log('  FAIL ' + name + '\n       host   = ' + JSON.stringify(actual) + '\n       client = ' + JSON.stringify(expected))
}

const hostSrc = readFileSync(new URL('../lib/pricing.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 取单行赋值的右侧并压掉空白。 */
function lineValue(src, name) {
  const re = new RegExp('^\\s*(?:const|let|var)?\\s*' + name + '\\s*=\\s*(.+)$', 'm')
  const m = src.match(re)
  return m === null ? null : m[1].trim().replace(/\s+/g, ' ')
}

/** 取数字对数组(峰窗口),比数值而不是文本。 */
function windows(src) {
  const raw = lineValue(src, 'PEAK_WINDOWS')
  if (raw === null) return null
  const pairs = [...raw.matchAll(/start:\s*(-?\d+)\s*,\s*end:\s*(-?\d+)/g)]
  return pairs.map(m => [Number(m[1]), Number(m[2])])
}

/** 取 Date.parse('...') 里的 ISO 串。 */
function isoOf(src, name) {
  const raw = lineValue(src, name)
  if (raw === null) return null
  const m = raw.match(/Date\.parse\(\s*'([^']+)'\s*\)/)
  return m === null ? null : m[1]
}

/** 取假日数组里的所有日期串。 */
function holidays(src) {
  const m = src.match(/HOLIDAYS\s*=\s*\[([\s\S]*?)\]/)
  if (m === null) return null
  return [...m[1].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(x => x[1])
}

console.log('\n[1] 峰时段窗口')
const hostWin = windows(hostSrc)
const clientWin = windows(clientSrc)
check('两份都存在', hostWin !== null && clientWin !== null, true)
check('窗口完全一致', JSON.stringify(hostWin), JSON.stringify(clientWin))
check('窗口是 UTC 01-04 与 06-10(北京 09-12 / 14-18)',
  JSON.stringify(hostWin), JSON.stringify([[1, 4], [6, 10]]))

console.log('\n[2] 生效时刻')
check('峰谷生效时刻一致', isoOf(hostSrc, 'PEAK_EFFECTIVE_AT'), isoOf(clientSrc, 'PEAK_EFFECTIVE_AT'))
check('周末谷价生效时刻一致', isoOf(hostSrc, 'WEEKEND_OFFPEAK_AT'), isoOf(clientSrc, 'WEEKEND_OFFPEAK_AT'))

console.log('\n[3] 法定假日')
const hostHolidays = holidays(hostSrc)
const clientHolidays = holidays(clientSrc)
check('两份都有假日表', hostHolidays !== null && clientHolidays !== null, true)
check('假日列表完全一致', JSON.stringify(hostHolidays), JSON.stringify(clientHolidays))
check('假日都是合法日期', hostHolidays.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d))), true)

console.log('\n[4] 补充:宿主价目表自洽')
check('人民币 flash 峰 > 谷', 
  hostSrc.includes('cacheMiss: 2') && hostSrc.includes('cacheMiss: 1'), true)
check('美元表也在(非汇率折算)', hostSrc.includes('cacheMiss: 0.3') && hostSrc.includes('cacheMiss: 0.15'), true)
check('两度小数展示(toFixed(2))', clientSrc.includes("toFixed(2)"), true)

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
