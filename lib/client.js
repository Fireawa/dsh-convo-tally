/**
 * dsh-convo-tally —— 浏览器侧。
 *
 * 结构(为什么这么绕,写在最前面):
 *   `sidebar.footer.action` 是 **root 作用域**插槽,框架只传 { wide },拿不到
 *   `useProjection` 这类会话级工具 —— 侧栏自己没法知道"当前是哪个对话"。
 *
 *   解法:在**会话作用域**的 `conversation.composer.dock` 注册一个不可见探针,
 *   它拿得到框架按当前会话绑定的 `useProjection('convoCost')`;探针把值写进
 *   模块级共享变量,侧栏组件读它。同一个 bundle 内共享,切会话时探针重渲染,
 *   侧栏最迟 2s 内跟上 —— 不能用"最近活动会话"这种启发式,那会在切换时显示错数字。
 *
 * 金额:人民币与美元都由宿主按各自官方价目表算好,这里只负责选一个显示,
 * 不做汇率折算(两张官方表不是按固定汇率对齐的)。
 */

window.__ModuleLoader__.load({
  id: 'dsh-convo-tally',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const SIDEBAR = 'sidebar.footer.action'
    const PROBE = 'conversation.composer.dock'
    const LS_CURRENCY = 'dsh-convo-tally/currency'
    const LS_RESET = 'dsh-convo-tally/reset'

    /** 探针写入、侧栏读取的模块级共享值(投影 wire 视图)。 */
    let shared = undefined

    /** 「账单」面板是否展开。放模块级而不是组件 state:组件只靠 bump 重渲染,这样测试里也能驱动。 */
    let billOpen = false

    /** 读取本地存储;失败一律回退,不影响渲染。 */
    function readStore(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw === null || raw === undefined || raw === '' ? fallback : JSON.parse(raw)
      } catch (err) { return fallback }
    }

    /** 写入本地存储;失败静默。 */
    function writeStore(key, value) {
      try { globalThis.localStorage?.setItem(key, JSON.stringify(value)) } catch (err) { /* 隐私模式等 */ }
    }

    /** 重置基线最多保留多少条,避免 localStorage 无限增长。 */
    const RESET_LIMIT = 50

    /** 重置基线的解析缓存:原始字符串没变就不重复 JSON.parse(组件每 2s 重渲染)。 */
    let resetRaw = null
    let resetValue = {}

    /**
     * 读重置基线。按原始字符串做记忆:另一个标签页改了也会立刻生效,但平时不重复解析。
     * @returns {Record<string, object>} 基线表。
     */
    function resets() {
      let raw = null
      try { raw = globalThis.localStorage?.getItem(LS_RESET) ?? null } catch (err) { raw = null }
      if (raw === resetRaw) return resetValue
      resetRaw = raw
      try {
        resetValue = raw === null || raw === '' ? {} : JSON.parse(raw)
      } catch (err) {
        resetValue = {}
      }
      return resetValue
    }

    /**
     * 写入一条重置基线;超出上限时按写入顺序淘汰最旧的。
     * @param {string} key - 会话键。
     * @param {object} entry - 基线快照。
     */
    function saveReset(key, entry) {
      const all = { ...resets() }
      all[key] = entry
      const keys = Object.keys(all)
      if (keys.length > RESET_LIMIT) {
        for (const stale of keys.slice(0, keys.length - RESET_LIMIT)) delete all[stale]
      }
      writeStore(LS_RESET, all)
      resetRaw = null   // 下次读取重新解析
    }

    // ── 峰谷(纯展示用,与宿主计价同一张官方时刻表)──
    const PEAK_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }]
    const PEAK_EFFECTIVE_AT = Date.parse('2026-08-01T00:00:00Z')
    const WEEKEND_OFFPEAK_AT = Date.parse('2026-08-22T16:00:00Z')
    const HOLIDAYS = [
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ]

    /** 北京时间日界键。 */
    const dayKeyOf = ms => new Date(Number(ms) + 8 * 3600000).toISOString().slice(0, 10)

    const isWeekend = ms => {
      if (!Number.isFinite(ms) || ms < WEEKEND_OFFPEAK_AT) return false
      const weekday = (Math.floor((ms + 8 * 3600000) / 86400000) + 4) % 7
      return weekday === 0 || weekday === 6
    }

    const isHoliday = ms => Number.isFinite(ms)
      && ms >= WEEKEND_OFFPEAK_AT
      && HOLIDAYS.indexOf(dayKeyOf(ms)) >= 0

    const isPeakAt = ms => {
      if (!Number.isFinite(ms) || ms < PEAK_EFFECTIVE_AT) return false
      if (isWeekend(ms) || isHoliday(ms)) return false
      const hour = new Date(ms).getUTCHours()
      return PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end)
    }

    /** 当前相位与下一次切换点。 */
    function peakPhase(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now()
      const inPeak = isPeakAt(now)
      let nextAtMs = null
      const hourMs = 3600000
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

    /**
     * 金额显示:统一两位小数(用户要求所有金额都保留两位)。
     * @param {number} v - 金额。
     * @param {string} currency - 'CNY' | 'USD'。
     * @returns {string} 显示文本。
     */
    function money(v, currency) {
      const symbol = currency === 'USD' ? '$' : '¥'
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return symbol + '0.00'
      return symbol + n.toFixed(2)
    }

    /**
     * 毫秒差 → 「1天9小时」这种紧凑中文时长。
     * @param {number} ms - 毫秒差。
     * @returns {string} 时长文本。
     */
    function dur(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 60000))
      const d = Math.floor(total / 1440)
      const hh = Math.floor((total % 1440) / 60)
      const mm = total % 60
      if (d > 0) return d + '天' + (hh > 0 ? hh + '小时' : '')
      if (hh > 0) return hh + '小时' + (mm > 0 ? mm + '分' : '')
      return mm + '分'
    }

    /** 会话 id → 重置基线的键。 */
    const resetKeyOf = state => (state && typeof state.sessionId === 'string' && state.sessionId !== '' ? state.sessionId : '_')

    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

    /**
     * 最近 n 个北京日期(含今天),升序。
     * @param {number} n - 天数。
     * @param {number} nowMs - 参考时刻。
     * @returns {string[]} YYYY-MM-DD 列表。
     */
    function lastDays(n, nowMs) {
      const base = Date.parse(dayKeyOf(nowMs) + 'T00:00:00Z')
      const out = []
      for (let i = n - 1; i >= 0; i -= 1) {
        out.push(new Date(base - i * 86400000).toISOString().slice(0, 10))
      }
      return out
    }

    /**
     * 日期 → 「10-25 周五」。
     * @param {string} day - YYYY-MM-DD。
     * @returns {string} 显示标签。
     */
    function labelOfDay(day) {
      return day.slice(5) + ' 周' + WEEKDAYS[new Date(day + 'T00:00:00Z').getUTCDay()]
    }

    /**
     * 减去重置基线后的**累计**金额。
     *
     * 只作用于「累计」:「今日」始终显示宿主算出的真实值,重置不影响它。
     * (所以重置后「今日」可能大于「累计」,这是这个语义的必然结果。)
     *
     * @param {any} state - 投影视图。
     * @returns {{totalCny:number, totalUsd:number}} 显示用的累计金额。
     */
    function afterReset(state) {
      const cny = Number(state.totalCny) || 0
      const usd = Number(state.totalUsd) || 0
      const base = resets()[resetKeyOf(state)]
      if (base === undefined || base === null) return { totalCny: cny, totalUsd: usd }
      const cut = (value, key) => {
        const v = value - (Number(base[key]) || 0)
        return v > 0 ? v : 0
      }
      return { totalCny: cut(cny, 'totalCny'), totalUsd: cut(usd, 'totalUsd') }
    }

    /**
     * 会话作用域的不可见探针:按当前对话读投影,刷新共享值。
     *
     * 卸载时必须清空 `shared`,否则离开对话页(或对话被关闭)后,
     * 侧栏会一直显示上一个对话的金额 —— 那是"看得见但不更新"的假数据。
     *
     * 判断归属用**引用相等**:每次投影变化都会得到一个不同的视图对象,
     * 若卸载时 `shared` 仍等于本次发布的对象,说明期间没有别的探针接手,
     * 它才是最后一个,可以安全清空。
     *
     * @param {any} props - 插槽注入的 props,含 useProjection。
     * @returns {null} 不渲染任何内容。
     */
    function Probe(props) {
      const value = typeof props.useProjection === 'function'
        ? props.useProjection('convoCost')
        : undefined
      shared = value
      React.useEffect(() => () => {
        if (shared === value) shared = undefined
      }, [value])
      return null
    }

    /** 侧栏:工具栏(重置 / 币种)+ 两行金额 + 峰谷角标。 */
    function Widget() {
      const [, bump] = React.useState(0)
      const [currency, setCurrency] = React.useState(() => {
        const stored = readStore(LS_CURRENCY, 'CNY')
        return stored === 'USD' ? 'USD' : 'CNY'
      })

      React.useEffect(() => {
        const timer = setInterval(() => bump(n => n + 1), 2000)
        return () => clearInterval(timer)
      }, [])

      const now = Date.now()
      const state = shared
      const has = state !== undefined && state !== null
      const sameDay = has && state.dayKey === dayKeyOf(now)
      // 今日永远显示宿主真实值(重置不影响);累计才扣重置基线。
      const shownTotal = has ? afterReset(state) : null
      const today = !has || !sameDay
        ? 0
        : (currency === 'USD' ? Number(state.todayUsd) || 0 : Number(state.todayCny) || 0)
      const total = shownTotal === null ? 0 : (currency === 'USD' ? shownTotal.totalUsd : shownTotal.totalCny)

      const phase = peakPhase(now)
      const label = phase.inPeak
        ? '高峰价'
        : phase.holiday ? '假日谷价' : phase.weekend ? '周末谷价' : '谷价'
      const tail = phase.nextAtMs === null
        ? ''
        : ' · ' + dur(phase.nextAtMs - now) + '后' + (phase.intoPeak ? '进入高峰' : '转谷价')

      const toggleCurrency = () => {
        const next = currency === 'USD' ? 'CNY' : 'USD'
        writeStore(LS_CURRENCY, next)
        setCurrency(next)
      }

      // 「账单」:最近 7 天,每天一笔,取宿主给的真实按天金额(不受重置影响)。
      // 面板收起时不算,省掉每 2s 一次的无用计算。
      const billRows = []
      let billTotal = 0
      if (billOpen && has) {
        const dayMap = new Map((Array.isArray(state.days) ? state.days : []).map(d => [d.day, d]))
        for (const day of lastDays(7, now)) {
          const entry = dayMap.get(day)
          const amount = entry === undefined ? 0 : (currency === 'USD' ? Number(entry.usd) || 0 : Number(entry.cny) || 0)
          billRows.push({
            day,
            label: labelOfDay(day),
            isToday: day === dayKeyOf(now),
            amount,
            calls: entry === undefined ? 0 : Number(entry.calls) || 0,
          })
          billTotal += amount
        }
      }

      const toggleBill = () => {
        billOpen = !billOpen
        bump(n => n + 1)
      }

      /** 只把「累计」的基线记下来:累计显示归零,今日原样保留。 */
      const reset = () => {
        if (!has) return
        saveReset(resetKeyOf(state), {
          totalCny: Number(state.totalCny) || 0,
          totalUsd: Number(state.totalUsd) || 0,
        })
        bump(n => n + 1)
      }

      return h('div', {
        className: 'ccw-stack',
        'data-dsh-convo-tally': '1',
        'data-ccw-state': has ? 'ready' : 'nodata',
      },
        h('div', { className: 'ccw-tools' },
          h('button', {
            type: 'button',
            className: 'ccw-btn',
            title: '只把「累计」显示清零,「今日」保持不变(纯显示,不改宿主记录)',
            onClick: reset,
            disabled: !has,
          }, '重置'),
          h('button', {
            type: 'button',
            className: 'ccw-btn',
            title: currency === 'USD' ? '切换到人民币(官方人民币价目表)' : '切换到美元(官方美元价目表)',
            onClick: toggleCurrency,
          }, currency === 'USD' ? '$' : '¥'),
          h('button', {
            type: 'button',
            className: 'ccw-btn' + (billOpen ? ' active' : ''),
            title: '查看本对话最近 7 天每天的费用(实际计费,不含重置)',
            onClick: toggleBill,
            disabled: !has,
          }, '账单')),
        h('div', { className: 'ccw-row' },
          h('span', { className: 'ccw-label' }, '本对话 · 今日'),
          h('span', { className: 'ccw-value' }, has ? money(today, currency) : '—')),
        h('div', { className: 'ccw-row' },
          h('span', { className: 'ccw-label' }, '本对话 · 累计'),
          h('span', { className: 'ccw-value' }, has ? money(total, currency) : '—')),
        h('div', {
          className: 'ccw-badge ' + (phase.inPeak ? 'peak' : 'off'),
          title: '按官方价目表,以每次调用的发起时刻判定峰谷',
        },
          h('span', { className: 'ccw-dot ' + (phase.inPeak ? 'peak' : 'off') }),
          h('span', { className: 'ccw-phase' }, label),
          tail ? h('span', { className: 'ccw-note' }, tail) : null),
        has && state.unpriced > 0
          ? h('div', { className: 'ccw-badge off' },
            h('span', { className: 'ccw-note' }, state.unpriced + ' 次调用模型未知,未计价'))
          : null,
        billOpen && has
          ? h('div', { className: 'ccw-bill', 'data-ccw-bill': '1' },
            h('div', { className: 'ccw-bill-head' }, '近 7 天 · 每天的花费'),
            ...billRows.map(row => h('div', {
              key: row.day,
              className: 'ccw-bill-row' + (row.isToday ? ' today' : ''),
            },
              h('span', { className: 'ccw-bill-day' },
                row.label,
                row.calls > 0 ? h('span', { className: 'ccw-bill-calls' }, ' · ' + row.calls + '次') : null),
              h('span', { className: 'ccw-bill-amt' + (row.amount > 0 ? '' : ' zero') }, money(row.amount, currency)),
            )),
            h('div', { className: 'ccw-bill-row total' },
              h('span', { className: 'ccw-bill-day' }, '合计'),
              h('span', { className: 'ccw-bill-amt' }, money(billTotal, currency))),
            // 近 7 天全为 0 但宿主持有更早的记录:说明这只是个旧对话,不是数据丢了。
            billTotal === 0 && Array.isArray(state.days) && state.days.length > 0
              ? h('div', { className: 'ccw-bill-note' }, '近 7 天没有花费')
              : null,
          )
          : null)
    }

    /** 注册两个贡献:会话作用域探针 + root 作用域侧栏挂件。 */
    function apply(ctx) {
      try {
        const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
          console.warn('[dsh-convo-tally] slots 服务不可用,挂件未注册')
          return
        }
        // 探针 order 大、自身不渲染,放在 dock 里不影响布局。
        slots.inject(PROBE, () => slots.register({
          name: PROBE,
          id: 'convo-tally-probe',
          order: 900,
        }, Probe))
        slots.inject(SIDEBAR, () => slots.register({
          name: SIDEBAR,
          id: 'convo-tally',
          order: -1,
        }, Widget))
        console.info('[dsh-convo-tally] 已注册探针与侧栏挂件')
      } catch (err) {
        console.warn('[dsh-convo-tally] 注册失败', err)
      }
    }

    // 样式只注入一次。
    try {
      if (typeof document !== 'undefined' && document.head) {
        const id = 'dsh-convo-tally-style'
        if (!document.getElementById(id)) {
          const tag = document.createElement('style')
          tag.id = id
          tag.textContent = [
            '.ccw-stack{display:flex;flex-direction:column;gap:3px;width:100%;',
            'padding:3px 0 8px;font-size:13px;line-height:1.55;',
            'font-family:inherit;-webkit-font-smoothing:antialiased;',
            'font-variant-numeric:tabular-nums;color:inherit}',
            // 工具栏:两个小胶囊按钮
            '.ccw-tools{display:flex;align-items:center;gap:6px;margin-bottom:2px}',
            '.ccw-btn{font:inherit;font-size:11px;line-height:1;padding:3px 8px;',
            'border-radius:999px;border:1px solid currentColor;background:transparent;',
            'color:inherit;opacity:.62;cursor:pointer;transition:opacity .15s,background .15s}',
            '.ccw-btn:hover{opacity:1;background:rgba(127,127,127,.12)}',
            '.ccw-btn.active{opacity:1;background:rgba(127,127,127,.18)}',
            '.ccw-btn:disabled{opacity:.3;cursor:default;background:transparent}',
            // 账单面板:7 天明细
            '.ccw-bill{margin-top:5px;padding-top:5px;border-top:1px dashed rgba(127,127,127,.4);',
            'display:flex;flex-direction:column;gap:1px;font-size:11.5px;line-height:1.5}',
            '.ccw-bill-head{opacity:.6;font-size:11px;margin-bottom:2px}',
            '.ccw-bill-row{display:flex;justify-content:space-between;gap:8px}',
            '.ccw-bill-row.today{font-weight:600}',
            '.ccw-bill-row.total{margin-top:3px;padding-top:3px;border-top:1px solid rgba(127,127,127,.35);font-weight:600}',
            '.ccw-bill-day{opacity:.85;white-space:nowrap}',
            '.ccw-bill-amt{font-variant-numeric:tabular-nums;white-space:nowrap}',
            '.ccw-bill-amt.zero{opacity:.42}',
            '.ccw-bill-calls{opacity:.5;font-weight:400}',
            '.ccw-bill-note{opacity:.5;font-size:11px;margin-top:3px}',
            '.ccw-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
            '.ccw-label{opacity:.88;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.ccw-value{font-weight:700;white-space:nowrap;letter-spacing:.01em}',
            '.ccw-badge{display:flex;align-items:center;gap:6px;margin-top:4px;',
            'font-size:12.5px;line-height:1.45;white-space:nowrap;',
            'overflow:hidden;text-overflow:ellipsis}',
            '.ccw-dot{width:7px;height:7px;border-radius:50%;flex:none}',
            '.ccw-dot.peak{background:#e8833a}',
            '.ccw-dot.off{background:#34a853}',
            '.ccw-phase{font-weight:600;letter-spacing:.01em}',
            '.ccw-badge.peak .ccw-phase{color:#d4712b}',
            '.ccw-badge.off .ccw-phase{color:#2f9e4c}',
            '.ccw-note{opacity:.62;font-weight:400}',
          ].join('')
          document.head.appendChild(tag)
        }
      }
    } catch (err) { /* 样式失败不影响功能 */ }

    return { inject: ['slots'], apply }
  },
})
