/**
 * dsh-convo-tally —— 宿主侧。
 *
 * 只做一件事:注册会话投影 `convoCost`,把本会话的「今日 / 累计」花费
 * 按每次调用的发起时刻算准,并同时给出人民币与美元两份金额
 * (两种货币各用官方自己那张价目表,不做汇率折算)。
 *
 * 折叠语义照搬宿主官方 tokenUsage 投影,这是准确性的关键:
 *   · 同一 turn/step 的新结算**替换**旧值 —— 流式中间结果不重复累加
 *   · 只有 `llm/retry-started` 才开新槽位 —— 重试那次真正算钱
 *   · 同 turn/step 且分桶相同直接短路 —— 重放日志幂等
 *   · init 的 inheritedEventCount 跳过 fork 继承前缀 —— 不重复计父会话的钱
 *   · 模型取自 request/header —— assistant 结算事件本身不带模型
 */

import { z } from 'zod'
import { costOf, beijingDayKey } from './pricing.js'

const bucketsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
})

const moneySchema = z.object({
  cny: z.number().nonnegative(),
  usd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
})

const stateSchema = z.object({
  /** 会话 id(客户端用来按会话记录重置基线) */
  sessionId: z.string(),
  /** 最近一次计费事件所属的北京时间日期 */
  dayKey: z.string(),
  /** 按天累计(只保留最近几天,供「账单」看一周)。今天的金额由 days[dayKey] 派生 */
  days: z.record(z.string(), moneySchema),
  total: moneySchema,
  /** 上一个结算槽(替换语义用) */
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: bucketsSchema,
    cny: z.number().nonnegative(),
    usd: z.number().nonnegative(),
    day: z.string(),
    priced: z.boolean(),
  }).nullable(),
  /** 无法计价(未知模型)的调用数 */
  unpriced: z.number().int().nonnegative(),
  /** fork 继承的事件前缀长度(不计费) */
  inherited: z.number().int().nonnegative(),
  /** 最近一次 request/header 的模型 */
  model: z.string(),
})

const viewSchema = z.object({
  sessionId: z.string(),
  todayCny: z.number().nonnegative(),
  todayUsd: z.number().nonnegative(),
  totalCny: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
  dayKey: z.string(),
  unpriced: z.number().int().nonnegative(),
  /** 最近几天的按天明细,按日期升序 */
  days: z.array(z.object({
    day: z.string(),
    cny: z.number().nonnegative(),
    usd: z.number().nonnegative(),
    calls: z.number().int().nonnegative(),
  })),
})

/** 按天明细保留多少天。界面只显示 7 天,多留一天作为边界缓冲。 */
const DAYS_KEPT = 8

const zeroMoney = () => ({ cny: 0, usd: 0, calls: 0 })

/**
 * 在 stream 里从后往前找最后一个 usage chunk。
 * 复刻 @deepseek-ai/dsh-llm 的 lastAssistantStreamChunk(stream, 'usage')。
 * @param {any} stream - 事件里的流记录数组。
 * @returns {any} usage 对象,或 undefined。
 */
function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

/**
 * 取出一个事件携带的用量分桶。
 * `assistant/message` 直接带 usage;`assistant/attempt` 要回到 stream 里找。
 * @param {any} event - 会话事件。
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}|undefined} 分桶。
 */
function usageOf(event) {
  const usage = event.type === 'assistant/message'
    ? event.data?.usage
    : lastUsageChunk(event.data?.stream)
  if (usage === undefined || usage === null) return undefined
  return {
    input: Number(usage.inputTokens) || 0,
    output: Number(usage.outputTokens) || 0,
    cacheRead: Number(usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage.cacheWriteTokens) || 0,
  }
}

/**
 * 替换式累加:减去同一槽位的旧值,加上新值。两种货币同步累加。
 * @param {{cny:number, usd:number, calls:number}} money - 累计对象。
 * @param {any} previous - 该槽位旧值(可能没有)。
 * @param {{cny:number, usd:number}} next - 新值。
 * @returns {{cny:number, usd:number, calls:number}} 新累计。
 */
function addReplacing(money, previous, next) {
  const cny = money.cny - (previous?.cny ?? 0) + next.cny
  const usd = money.usd - (previous?.usd ?? 0) + next.usd
  return {
    cny: cny > 0 ? cny : 0,
    usd: usd > 0 ? usd : 0,
    calls: money.calls + 1 - (previous === undefined ? 0 : 1),
  }
}

const bucketsEqual = (a, b) => a !== undefined && b !== undefined
  && a.input === b.input && a.output === b.output
  && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite

/**
 * 往某一天的桶里加减金额与调用数。
 * @param {Record<string, {cny:number, usd:number, calls:number}>} days - 按天表。
 * @param {string} day - 北京日期。
 * @param {{cny:number, usd:number}} delta - 金额增量(可为负,用于替换)。
 * @param {number} callDelta - 调用数增量。
 * @returns {Record<string, {cny:number, usd:number, calls:number}>} 新表。
 */
function addToDay(days, day, delta, callDelta) {
  const cur = days[day] ?? zeroMoney()
  const cny = cur.cny + delta.cny
  const usd = cur.usd + delta.usd
  const calls = cur.calls + callDelta
  return {
    ...days,
    [day]: { cny: cny > 0 ? cny : 0, usd: usd > 0 ? usd : 0, calls: calls > 0 ? calls : 0 },
  }
}

/**
 * 只保留最新的 N 天。日期键是 YYYY-MM-DD,字典序即时间序,结果确定可重放。
 * @param {Record<string, any>} days - 按天表。
 * @param {number} keep - 保留天数。
 * @returns {Record<string, any>} 裁剪后的表。
 */
function pruneDays(days, keep) {
  const keys = Object.keys(days).sort()
  if (keys.length <= keep) return days
  const kept = keys.slice(keys.length - keep)
  const out = {}
  for (const key of kept) out[key] = days[key]
  return out
}

/** state → view 的弱引用缓存(不进 state,保持 state 是纯 JSON)。 */
const viewCache = new WeakMap()

/** 会话投影定义。 */
const definition = {
  key: 'convoCost',
  // v4:按天明细改为 days 表(供「账单」看一周),今天的金额由 days[dayKey] 派生。
  // 升版本会让旧缓存作废并整条重折叠,避免恢复出结构不符的旧状态。
  stateVersion: 4,
  stateSchema,
  init(header, inheritedEventCount) {
    return {
      sessionId: typeof header?.id === 'string' ? header.id : '',
      dayKey: '',
      days: {},
      total: zeroMoney(),
      last: null,
      unpriced: 0,
      inherited: Number.isFinite(inheritedEventCount) ? Number(inheritedEventCount) : 0,
      model: header?.config?.model ?? header?.model ?? '',
    }
  },
  apply(state, event) {
    // 模型只出现在 request/header 上;这一步不产生费用,不受 fork 前缀影响。
    if (event.type === 'request/header') {
      const model = event.data?.header?.config?.model
      if (typeof model !== 'string' || model === '' || model === state.model) return state
      return { ...state, model }
    }

    // fork 继承的前缀不计费(父会话已付过)。
    if (Number.isFinite(event?.seq) && event.seq < (Number(state.inherited) || 0)) return state

    // 重试:关掉当前槽位,下一次结算算新增的一次。
    if (event.type === 'llm/retry-started') {
      return state.last !== null
        && state.last.turn === event.data?.turn
        && state.last.step === event.data?.step
        ? { ...state, last: null }
        : state
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

    const buckets = usageOf(event)
    if (buckets === undefined) return state

    const turn = Number(event.data?.turn) || 0
    const step = Number(event.data?.step) || 0
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step
      ? state.last
      : undefined
    // 同一槽位、同样的分桶:重放日志时短路,保持幂等。
    if (bucketsEqual(previous?.buckets, buckets)) return state

    const atMs = Number(event.time) || 0
    const day = beijingDayKey(atMs)
    const result = costOf(state.model, buckets, atMs)
    const cost = { cny: result.cny, usd: result.usd }

    // 按天累计。替换语义:同一个结算槽被重新上报时,先把它从原来那天的桶里扣掉;
    // 若这次上报落在另一天(极少数:同一槽位跨了零点),两天的桶都要动。
    let days = state.days
    if (previous !== undefined && previous.day !== day) {
      days = addToDay(days, previous.day, { cny: -previous.cny, usd: -previous.usd }, -1)
    }
    const sameDay = previous !== undefined && previous.day === day
    days = addToDay(
      days,
      day,
      {
        cny: cost.cny - (sameDay ? previous.cny : 0),
        usd: cost.usd - (sameDay ? previous.usd : 0),
      },
      sameDay ? 0 : 1,
    )
    days = pruneDays(days, DAYS_KEPT)

    return {
      ...state,
      // 日志是顺序的;万一遇到乱序事件,别把「最近一天」往回拨。
      dayKey: day >= state.dayKey ? day : state.dayKey,
      days,
      total: addReplacing(state.total, previous, cost),
      last: { turn, step, buckets, cny: result.cny, usd: result.usd, day, priced: result.priced },
      unpriced: Math.max(0, state.unpriced
        + (result.priced ? 0 : 1)
        - (previous !== undefined && previous.priced === false ? 1 : 0)),
    }
  },
  wire: {
    viewSchema,
    view: state => {
      // 引用稳定:同一 state 复用同一视图,避免"只换了模型"这类内部变化触发前端重渲染。
      const cached = viewCache.get(state)
      if (cached !== undefined) return cached
      const keys = Object.keys(state.days).sort()
      const today = state.days[state.dayKey] ?? zeroMoney()
      const view = {
        sessionId: state.sessionId,
        todayCny: today.cny,
        todayUsd: today.usd,
        totalCny: state.total.cny,
        totalUsd: state.total.usd,
        dayKey: state.dayKey,
        unpriced: state.unpriced,
        days: keys.map(day => ({
          day,
          cny: state.days[day].cny,
          usd: state.days[day].usd,
          calls: state.days[day].calls,
        })),
      }
      viewCache.set(state, view)
      return view
    },
  },
}

/** 供本地自测使用(宿主只认 default export)。 */
export { definition as convoCostProjection }

export default {
  name: 'convo-tally',
  apply(ctx) {
    ctx.inject(['sessionProjections'], c => {
      const registry = c.get?.('sessionProjections') ?? c.sessionProjections
      if (registry === undefined || typeof registry.register !== 'function') {
        console.warn('[dsh-convo-tally] sessionProjections 不可用,费用投影未注册')
        return
      }
      registry.register(definition)
    })
  },
}
