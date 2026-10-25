/**
 * 官方计价规则 —— 人民币与美元各用官方自己那张表,不用汇率折算。
 *
 * 为什么要两张表:官方中文页与英文页的单价**不是**按固定汇率换算的
 * (例如 flash 高峰未命中:人民币 2.0、美元 0.30,而 0.30×7.2=2.16)。
 * 用一张表乘汇率会在另一种货币下产生系统性误差,所以两种币各算各的。
 *
 * 三条容易算错的规则,这里都实现了:
 *   1. 峰谷按「请求发起时刻」判定,不是按"现在"
 *   2. 周末(北京时间周六/周日)与法定假日全天谷价
 *   3. 缓存命中/未命中/输出是互斥桶,不能相加后套一个价
 */

/** 峰时段窗口:UTC 小时,半开区间 [start, end)。即北京时间 09:00-12:00、14:00-18:00。 */
const PEAK_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }]

/** 峰谷计价生效时刻(UTC)。此前按当时的平价表计费。 */
const PEAK_EFFECTIVE_AT = Date.parse('2026-08-01T00:00:00Z')

/** 峰谷时代分界:此前的调用按历史平价计费,不受峰谷影响。 */
const LEGACY_BOUNDARY = Date.parse('2026-08-16T16:00:00Z')

/** 周末全谷价生效时刻(UTC):2026-08-23 00:00 北京时间起,周末全天谷价。 */
const WEEKEND_OFFPEAK_AT = Date.parse('2026-08-22T16:00:00Z')

/** Flash 档调价边界(UTC):2026-09-10 12:00 北京时间起按新价。 */
const FLASH_EFFECTIVE_AT = Date.parse('2026-09-10T04:00:00Z')

/** 中国法定假日(北京时间日期)。调休上班的周末仍按周末谷价处理。 */
const HOLIDAYS = [
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/**
 * 两套官方价目表。每族三档:current(当前)、before(调价前)、legacy(峰谷时代前平价)。
 * 单位是「每百万 tokens」。
 */
const PRICES = {
  CNY: {
    flash: {
      current: { peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } },
      before: { peak: { cacheHit: 0.1, cacheMiss: 3, output: 9 }, offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 } },
      legacy: { cacheHit: 0.02, cacheMiss: 1, output: 2 },
    },
    pro: {
      current: { peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 } },
      before: { peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 } },
      legacy: { cacheHit: 0.025, cacheMiss: 3, output: 6 },
    },
  },
  USD: {
    flash: {
      current: { peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }, offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 } },
      before: { peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }, offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 } },
      legacy: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
    },
    pro: {
      current: { peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }, offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 } },
      before: { peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }, offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 } },
      legacy: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
    },
  },
}

/**
 * 把模型 ID 归到两个计价族。
 * 按族匹配而不是精确 ID:`deepseek-flash` / `deepseek-v4.1-flash` / `deepseek-v4-flash` 都能算。
 * @param {string} modelId - 模型 ID。
 * @returns {'flash'|'pro'|null} 计价族;无法识别返回 null(不计价)。
 */
function familyOf(modelId) {
  const id = String(modelId ?? '').toLowerCase()
  if (!id) return null
  if (id.includes('pro') && id.includes('deepseek')) return 'pro'
  if (id.includes('flash')) return 'flash'
  if (id === 'deepseek-chat' || id === 'deepseek-reasoner') return 'flash'
  return null
}

/**
 * 北京时间日界键(YYYY-MM-DD)。
 * @param {number} ms - epoch 毫秒。
 * @returns {string} 北京日历日。
 */
export function beijingDayKey(ms) {
  return new Date(Number(ms) + 8 * 3600000).toISOString().slice(0, 10)
}

/**
 * 是否处于周末全谷价区间(北京时间周六/周日,新规生效后)。
 * @param {number} ms - epoch 毫秒。
 * @returns {boolean} 周末返回 true。
 */
function isWeekend(ms) {
  if (!Number.isFinite(ms) || ms < WEEKEND_OFFPEAK_AT) return false
  const weekday = (Math.floor((ms + 8 * 3600000) / 86400000) + 4) % 7 // 0=周日 … 6=周六
  return weekday === 0 || weekday === 6
}

/**
 * 是否处于法定假日全天谷价。
 * @param {number} ms - epoch 毫秒。
 * @returns {boolean} 假日返回 true。
 */
function isHoliday(ms) {
  if (!Number.isFinite(ms) || ms < WEEKEND_OFFPEAK_AT) return false
  return HOLIDAYS.includes(beijingDayKey(ms))
}

/**
 * 某一时刻是否按峰时价计费。周末/假日先判谷,再判窗口。
 * @param {number} ms - epoch 毫秒。
 * @returns {boolean} 峰时返回 true。
 */
export function isPeakAt(ms) {
  if (!Number.isFinite(ms) || ms < PEAK_EFFECTIVE_AT) return false
  if (isWeekend(ms) || isHoliday(ms)) return false
  const hour = new Date(ms).getUTCHours()
  return PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end)
}

/**
 * 某一时刻的单价档。
 * @param {object} table - 币种价目表。
 * @param {'flash'|'pro'} family - 计价族。
 * @param {number} ms - 计费时刻。
 * @returns {{cacheHit:number, cacheMiss:number, output:number}|null} 单价;未知族返回 null。
 */
function priceAt(table, family, ms) {
  const rates = table?.[family]
  if (rates === undefined) return null
  if (Number.isFinite(ms) && ms < LEGACY_BOUNDARY) return rates.legacy
  let tier = rates.current
  if (family === 'flash' && Number.isFinite(ms) && ms < FLASH_EFFECTIVE_AT) tier = rates.before
  return isPeakAt(ms) ? tier.peak : tier.offPeak
}

/**
 * 一次调用在某一币种下的花费。
 *
 * 关键点:宿主的 inputTokens 是「缓存未命中」,cacheReadTokens 是「命中」,
 * 两个桶互不相交,不能先相加再乘一个价。reasoning tokens 官方单独上报且不计费。
 *
 * @param {object} table - 币种价目表。
 * @param {'flash'|'pro'} family - 计价族。
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number}} tokens - 用量分桶。
 * @param {number} ms - 请求发起时刻。
 * @returns {number} 花费(该币种)。
 */
function costIn(table, family, tokens, ms) {
  const price = priceAt(table, family, ms)
  if (price === null) return 0
  const input = Math.max(0, Number(tokens?.input) || 0)
  const output = Math.max(0, Number(tokens?.output) || 0)
  const cacheRead = Math.max(0, Number(tokens?.cacheRead) || 0)
  const cacheWrite = Math.max(0, Number(tokens?.cacheWrite) || 0)
  const cost = (input * price.cacheMiss
    + cacheRead * price.cacheHit
    + cacheWrite * price.cacheHit
    + output * price.output) / 1_000_000
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

/**
 * 一次调用的花费,同时给出人民币与美元(各用官方表,不互相折算)。
 * @param {string} modelId - 模型 ID。
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number}} tokens - 用量分桶。
 * @param {number} ms - 请求发起时刻。
 * @returns {{cny:number, usd:number, priced:boolean, family:string|null}} 花费与计价状态。
 */
export function costOf(modelId, tokens, ms) {
  const family = familyOf(modelId)
  if (family === null) return { cny: 0, usd: 0, priced: false, family: null }
  return {
    cny: costIn(PRICES.CNY, family, tokens, ms),
    usd: costIn(PRICES.USD, family, tokens, ms),
    priced: true,
    family,
  }
}

/**
 * 当前峰谷相位与下一次切换点(供角标与倒计时显示)。
 *
 * 窗口边界都落在整点,周末/假日的日界也在整点,所以按整点步进扫描就是精确的。
 *
 * @param {number} nowMs - 参考时刻。
 * @returns {{inPeak:boolean, weekend:boolean, holiday:boolean, nextAtMs:number|null, intoPeak:boolean}} 相位信息。
 */
export function peakPhase(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const inPeak = isPeakAt(now)
  const hourMs = 3600000
  let nextAtMs = null
  for (let at = Math.floor(now / hourMs) * hourMs + hourMs; at <= now + 10 * 86400000; at += hourMs) {
    if (isPeakAt(at) !== inPeak) { nextAtMs = at; break }
  }
  return {
    inPeak,
    weekend: isWeekend(now),
    holiday: isHoliday(now),
    nextAtMs,
    intoPeak: nextAtMs === null ? false : isPeakAt(nextAtMs),
  }
}
