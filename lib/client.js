/**
 * dsh-plugin-usage-stats — browser half.
 *
 * Contributes two seats to the Web GUI:
 *   - `sidebar.panellist` id `usage-stats`: the sidebar rail icon. A list id in
 *     that slot addresses the matching `main` panel, which is how the shell
 *     knows which panel the button opens.
 *   - `main` key `usage-stats`: the dashboard body.
 *
 * The dashboard mirrors the familiar usage-board layout: an all-time figures
 * row, a year-long contribution heat map, a range switch, and a per-day trend
 * chart that slices the window by model route or by token type. Everything is
 * drawn from the Host half's same-origin JSON route with plain React elements
 * and inline SVG — no chart library, no CSS modules.
 *
 * Bundle contract: this file is emitted as a classic script that only registers
 * a CJS factory with the shell's module loader; `react` is the single external
 * it requires (the loader's frozen module table answers it).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage-stats',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Host JSON route, same origin as the page. */
    const DATA_URL = '/usage-stats/data'

    /** Poll interval for the dashboard while it is mounted. */
    const POLL_MS = 15000

    /** Token types, their labels, and their colors. */
    const KINDS = [
      { key: 'input', label: '输入', color: '#4c8dff' },
      { key: 'output', label: '输出', color: '#1f9d63' },
      { key: 'cacheRead', label: '缓存命中', color: '#8b5cf6' },
      { key: 'cacheWrite', label: '缓存写入', color: '#d98b1f' },
      { key: 'reasoning', label: '思维链', color: '#94a3b8' },
    ]

    /** Palette for the per-model trend lines. */
    const MODEL_COLORS = ['#4c8dff', '#1f9d63', '#8b5cf6', '#e0533d', '#d98b1f', '#0ea5b7', '#94a3b8']

    /** The two windows the panel offers (the trend chart needs a multi-day series). */
    const RANGES = [
      { days: 7, label: '近 7 天' },
      { days: 30, label: '近 30 天' },
    ]

    /** Window selected on first open: the longer one, so the chart opens with data. */
    const DEFAULT_DAYS = 30

    /** Heat-map aggregation modes. */
    const ACTIVITY_MODES = [
      { key: 'day', label: '每日' },
      { key: 'week', label: '每周' },
      { key: 'cumulative', label: '累计' },
    ]

    /** Heat-map ramp, index 0 = no activity. */
    const HEAT_COLORS = ['rgba(127,127,127,0.14)', 'rgba(76,141,255,0.25)', 'rgba(76,141,255,0.45)', 'rgba(76,141,255,0.72)', '#4c8dff']

    /* ── formatting helpers ─────────────────────────────────────────────── */

    const MUTED = 'var(--dsw-alias-label-secondary, #8a8f98)'
    const STRONG = 'var(--dsw-alias-label-primary, inherit)'
    const CARD = {
      background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
      borderRadius: 12,
    }

    /** Exact count with thousands separators. */
    function exact(value) {
      return Number(value ?? 0).toLocaleString('zh-CN')
    }

    /** Drop trailing zeros from a fixed-precision number string. */
    function trimNumber(text) {
      return text.includes('.') ? text.replace(/\.?0+$/, '') : text
    }

    /**
     * Short Chinese-unit form: `亿` from 1e8, `万` from 1e4, plain digits below
     * (with thousands separators). At most four significant digits, so figures,
     * legends and axis labels stay scannable instead of turning into a wall of
     * digits.
     */
    function unit(value) {
      const n = Number(value ?? 0)
      if (!Number.isFinite(n) || n === 0) return '0'
      const abs = Math.abs(n)
      if (abs >= 1e8) return `${trimNumber((n / 1e8).toFixed(2))}亿`
      if (abs >= 1e4) {
        const scaled = abs / 1e4
        const digits = scaled >= 1000 ? 0 : scaled >= 100 ? 1 : 2
        return `${trimNumber((n / 1e4).toFixed(digits))}万`
      }
      return exact(Math.round(n))
    }

    /**
     * Axis labels sharing ONE unit for the whole scale (mixing `万` and `亿`
     * across ticks reads as noise), with four significant digits at most.
     */
    function axisLabels(max) {
      if (max >= 1e8) return (value) => (value === 0 ? '0' : `${trimNumber((value / 1e8).toFixed(2))}亿`)
      if (max >= 1e4) return (value) => (value === 0 ? '0' : `${trimNumber((value / 1e4).toFixed(0))}万`)
      return (value) => exact(Math.round(value))
    }

    /** Local midnight of a `YYYY-MM-DD` key. */
    function parseDay(key) {
      const [year, month, day] = String(key).split('-').map(Number)
      return new Date(year, month - 1, day)
    }

    /** `M月D日` label of a `YYYY-MM-DD` key. */
    function monthDay(key) {
      const date = parseDay(key)
      return `${date.getMonth() + 1}月${date.getDate()}日`
    }

    /** `YYYY年M月D日` label used by heat-map tooltips. */
    function longDay(key) {
      const date = parseDay(key)
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    }

    /** Human duration for the longest-session figure. */
    function duration(ms) {
      const total = Number(ms ?? 0)
      if (!(total > 0)) return '0 分钟'
      const minutes = Math.round(total / 60000)
      if (minutes < 60) return `${minutes || 1} 分钟`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
      return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
    }

    /** Heat-map level index (0..4) for one cell value. */
    function heatLevel(value, max) {
      if (!(value > 0) || !(max > 0)) return 0
      return 1 + Math.min(3, Math.floor((value / max) * 4))
    }

    /* ── data ───────────────────────────────────────────────────────────── */

    /**
     * Subscribe to the Host route for one window size.
     * @returns `[state, reload]`; state is `{status, data?, message?}`.
     */
    function useUsage(days) {
      const [state, setState] = React.useState({ status: 'loading' })
      const requestRef = React.useRef(0)

      const load = React.useCallback(async () => {
        const ticket = requestRef.current + 1
        requestRef.current = ticket
        try {
          const response = await fetch(`${DATA_URL}?days=${days}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (requestRef.current === ticket) setState({ status: 'ready', data })
        } catch (error) {
          if (requestRef.current === ticket) {
            setState((previous) => (previous.status === 'ready'
              ? { ...previous, stale: true }
              : { status: 'error', message: error instanceof Error ? error.message : String(error) }))
          }
        }
      }, [days])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) void load() }
        setState({ status: 'loading' })
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      return [state, load]
    }

    /* ── small pieces ───────────────────────────────────────────────────── */

    /** Segmented chip used by every switch in the panel. */
    function Chip(props) {
      const active = props.active === true
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        style: {
          padding: props.compact === true ? '2px 9px' : '3px 12px',
          fontSize: props.compact === true ? 11.5 : 12,
          lineHeight: '18px',
          borderRadius: 999,
          cursor: 'pointer',
          border: `1px solid ${active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))'}`,
          background: active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'transparent',
          color: active ? '#fff' : MUTED,
        },
      }, props.label)
    }

    /** A row of mutually exclusive chips. */
    function ChipRow(props) {
      return h('div', { style: { display: 'flex', gap: 6 } },
        props.options.map((option) => h(Chip, {
          key: String(option.value),
          label: option.label,
          active: option.value === props.value,
          compact: props.compact,
          onClick: () => { props.onChange(option.value) },
        })))
    }

    /** One figure of the top row. */
    function Figure(props) {
      return h('div', {
        title: props.title,
        style: {
          flex: '1 1 120px',
          minWidth: 120,
          padding: '0 20px',
          borderLeft: props.first === true ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        },
      },
      h('div', { style: { fontSize: 22, fontWeight: 600, color: STRONG, lineHeight: 1.2, whiteSpace: 'nowrap' } }, props.value),
      h('div', { style: { fontSize: 12, color: MUTED, marginTop: 6 } }, props.label))
    }

    /** The all-time figures row (hover a figure for its exact value). */
    function TopStats(props) {
      const stats = props.stats
      const figures = [
        { label: '累积 Token 数', value: unit(stats.cumulative), exact: `${exact(stats.cumulative)} tokens` },
        { label: '峰值 Token 数', value: unit(stats.peak.total), exact: `${stats.peak.date ?? ''} · ${exact(stats.peak.total)} tokens` },
        { label: '最长聊天时长', value: duration(stats.longestSessionMs), exact: `${exact(Math.round(stats.longestSessionMs / 1000))} 秒` },
        { label: '当前连续天数', value: `${stats.streak.current} 天` },
        { label: '最长连续天数', value: `${stats.streak.longest} 天` },
      ]
      return h('div', {
        style: { ...CARD, display: 'flex', flexWrap: 'wrap', rowGap: 16, padding: '18px 6px' },
      }, figures.map((figure, index) => h(Figure, {
        key: figure.label,
        first: index === 0,
        value: figure.value,
        label: figure.label,
        title: figure.exact,
      })))
    }

    /** One muted line with the selected window's per-type totals in 万 / 亿. */
    function TypeStrip(props) {
      const totals = props.totals
      const cell = (key, text, hint) => h('span', { key, title: hint }, text)
      const parts = [
        cell('total', `合计 ${unit(totals.total)}`, `${exact(totals.total)} tokens`),
        ...KINDS.map((kind) => cell(kind.key, `${kind.label} ${unit(totals[kind.key])}`, `${exact(totals[kind.key])} tokens`)),
        cell('calls', `调用 ${exact(totals.calls)} 次`),
      ]
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 12, color: MUTED, margin: '12px 4px 0' },
      }, parts)
    }

    /* ── contribution heat map ──────────────────────────────────────────── */

    /**
     * Turn the day cells into rendered columns.
     * `day`/`cumulative` keep seven rows per column; `week` collapses each
     * column to its weekly total.
     */
    function heatColumns(activity, mode) {
      const lead = (parseDay(activity[0].date).getDay() + 6) % 7 // Monday-first grid
      const cells = []
      for (let index = 0; index < lead; index += 1) cells.push(null)
      for (const cell of activity) cells.push(cell)
      while (cells.length % 7 !== 0) cells.push(null)

      const columns = []
      for (let index = 0; index < cells.length; index += 7) columns.push(cells.slice(index, index + 7))

      if (mode === 'week') {
        const weekly = columns.map((column) => {
          let total = 0
          let calls = 0
          let last
          for (const cell of column) {
            if (cell === null) continue
            total += cell.total
            calls += cell.calls
            last = cell
          }
          return { date: last?.date, total, calls }
        })
        return { rows: 1, columns: weekly.map((entry) => [entry]), max: Math.max(1, ...weekly.map((entry) => entry.total)) }
      }

      let max = 1
      let cellValue
      if (mode === 'cumulative') {
        let running = 0
        for (const column of columns) {
          for (const cell of column) {
            if (cell === null) continue
            running += cell.total
            cell.running = running
          }
        }
        max = Math.max(1, running)
        cellValue = (cell) => cell.running
      } else {
        for (const column of columns) {
          for (const cell of column) if (cell !== null) max = Math.max(max, cell.total)
        }
        cellValue = (cell) => cell.total
      }
      return { rows: 7, columns, max, cellValue }
    }

    /** `Token 活动` card: a year of local days, one square per day (or week). */
    function Heatmap(props) {
      const mode = props.mode
      const { rows, columns, max, cellValue } = heatColumns(props.activity, mode)
      const cellSize = 11
      const gap = 3
      const value = cellValue ?? ((cell) => cell.total)

      const monthLabels = []
      let lastMonth = -1
      columns.forEach((column, index) => {
        const first = column.find((cell) => cell !== null)
        if (first === undefined) return
        const month = parseDay(first.date).getMonth()
        if (month !== lastMonth) {
          lastMonth = month
          monthLabels.push({ index, label: `${month + 1}月` })
        }
      })

      return h('div', { style: { ...CARD, padding: '16px 18px 12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
          h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, 'Token 活动'),
          h('div', { style: { flex: 1 } }),
          h(ChipRow, {
            value: mode,
            compact: true,
            options: ACTIVITY_MODES.map((entry) => ({ value: entry.key, label: entry.label })),
            onChange: props.onModeChange,
          })),
        // The grid is a fixed-width artifact: centre it in the card so a wide
        // window leaves symmetric whitespace instead of a lopsided gap.
        h('div', { style: { width: 'fit-content', margin: '0 auto' } },
          h('div', { style: { position: 'relative', height: 16, marginBottom: 4 } },
            monthLabels.map((entry) => h('span', {
              key: `month-${entry.index}`,
              style: { position: 'absolute', left: entry.index * (cellSize + gap), fontSize: 11, color: MUTED, whiteSpace: 'nowrap' },
            }, entry.label))),
          h('div', { style: { display: 'flex', gap } },
            columns.map((column, columnIndex) => h('div', {
              key: `col-${columnIndex}`,
              style: { display: 'flex', flexDirection: 'column', gap },
            }, column.map((cell, rowIndex) => h('div', {
              key: `cell-${rowIndex}`,
              title: cell === null || typeof cell.date !== 'string'
                ? undefined
                : `${longDay(cell.date)} · ${unit(cell.total)} tokens · ${exact(cell.calls)} 次调用`,
              style: {
                width: cellSize,
                height: rows === 1 ? cellSize * 2 : cellSize,
                borderRadius: 3,
                background: cell === null ? 'transparent' : HEAT_COLORS[heatLevel(value(cell), max)],
              },
            }))))),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 12, fontSize: 11, color: MUTED } },
            h('span', null, '少'),
            HEAT_COLORS.map((color, index) => h('span', {
              key: `legend-${index}`,
              style: { width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block' },
            })),
            h('span', null, '多'))))
    }

    /* ── trend chart ────────────────────────────────────────────────────── */

    /**
     * Catmull-Rom smoothed path through the points, clamped to the plot band so
     * a flat zero series cannot curve below the axis.
     */
    function smoothPath(points, minY, maxY) {
      if (points.length === 0) return ''
      if (points.length === 1) return `M${points[0][0]},${points[0][1]}`
      const clamp = (value) => Math.max(minY, Math.min(maxY, value))
      let path = `M${points[0][0]},${points[0][1]}`
      for (let index = 0; index < points.length - 1; index += 1) {
        const previous = points[index - 1] ?? points[index]
        const current = points[index]
        const next = points[index + 1]
        const after = points[index + 2] ?? next
        const c1x = current[0] + (next[0] - previous[0]) / 6
        const c1y = clamp(current[1] + (next[1] - previous[1]) / 6)
        const c2x = next[0] - (after[0] - current[0]) / 6
        const c2y = clamp(next[1] - (after[1] - current[1]) / 6)
        path += ` C${c1x},${c1y} ${c2x},${c2y} ${next[0]},${next[1]}`
      }
      return path
    }

    /**
     * Multi-series smooth line chart drawn as inline SVG.
     *
     * Hovering a day shows a guide line, a dot per series on that day, and a
     * tooltip with every series' value for it. The SVG scales uniformly (no
     * `preserveAspectRatio: none`), so its labels are never stretched; the
     * tooltip is a positioned HTML overlay sharing the chart's percentage
     * geometry.
     */
    function LineChart(props) {
      const series = props.series
      const days = props.days
      const width = 1000
      const height = 300
      const pad = { left: 62, right: 16, top: 12, bottom: 30 }
      const innerWidth = width - pad.left - pad.right
      const innerHeight = height - pad.top - pad.bottom
      const count = days.length
      const max = Math.max(1, ...series.flatMap((entry) => entry.values))
      const x = (index) => (count <= 1 ? pad.left + innerWidth / 2 : pad.left + (index / (count - 1)) * innerWidth)
      const y = (value) => pad.top + innerHeight - (Number(value ?? 0) / max) * innerHeight
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({ value: max * fraction, y: y(max * fraction) }))
      const labelStep = Math.max(1, Math.ceil(count / 6))
      const formatTick = axisLabels(max)

      const [hovered, setHovered] = React.useState(null)
      const active = typeof hovered === 'number' && hovered >= 0 && hovered < count ? hovered : null
      const day = active === null ? undefined : days[active]
      const rows = active === null
        ? []
        : series
          .map((entry) => ({ key: entry.key, label: entry.label, color: entry.color, value: Number(entry.values[active] ?? 0) }))
          .filter((row) => row.value > 0)
          .sort((left, right) => right.value - left.value)

      // One transparent band per day: the hit target for the guide + tooltip.
      const band = (index) => {
        const left = index === 0 ? pad.left : (x(index - 1) + x(index)) / 2
        const right = index === count - 1 ? width - pad.right : (x(index) + x(index + 1)) / 2
        return { left, width: Math.max(1, right - left) }
      }

      const tooltipLeft = active === null ? 50 : Math.max(12, Math.min(88, (x(active) / width) * 100))

      return h('div', { style: { position: 'relative' } },
        h('svg', {
          viewBox: `0 0 ${width} ${height}`,
          style: { width: '100%', height: 'auto', display: 'block' },
          role: 'img',
          onMouseLeave: () => { setHovered(null) },
        },
        ticks.map((tick, index) => h('line', {
          key: `tick-${index}`,
          x1: pad.left,
          x2: width - pad.right,
          y1: tick.y,
          y2: tick.y,
          stroke: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
          strokeWidth: 1,
          strokeDasharray: index === ticks.length - 1 ? undefined : '3 4',
        })),
        ticks.map((tick, index) => h('text', {
          key: `tick-label-${index}`,
          x: pad.left - 8,
          y: tick.y + 3.5,
          textAnchor: 'end',
          fontSize: 11,
          fill: MUTED,
        }, formatTick(tick.value))),
        days.map((entry, index) => (index % labelStep === 0 || index === count - 1
          ? h('text', {
            key: `x-${entry.date}`,
            x: x(index),
            y: height - 10,
            textAnchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
            fontSize: 11,
            fill: MUTED,
          }, monthDay(entry.date))
          : null)),
        series.map((entry) => h('path', {
          key: `line-${entry.key}`,
          d: smoothPath(entry.values.map((value, index) => [x(index), y(value)]), pad.top, pad.top + innerHeight),
          fill: 'none',
          stroke: entry.color,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })),
        active === null ? null : h('line', {
          key: 'guide',
          x1: x(active),
          x2: x(active),
          y1: pad.top,
          y2: pad.top + innerHeight,
          stroke: 'var(--dsw-alias-brand-primary, #4c8dff)',
          strokeWidth: 1,
          strokeDasharray: '3 3',
          opacity: 0.7,
        }),
        count <= 14 ? series.flatMap((entry) => entry.values.map((value, index) => h('circle', {
          key: `dot-${entry.key}-${index}`,
          cx: x(index),
          cy: y(value),
          r: 2.6,
          fill: entry.color,
        }))) : null,
        active === null ? null : series.map((entry) => h('circle', {
          key: `hover-${entry.key}`,
          cx: x(active),
          cy: y(entry.values[active]),
          r: 3.6,
          fill: entry.color,
          stroke: 'var(--dsw-alias-bg-layer-1, #212429)',
          strokeWidth: 1.5,
        })),
        count === 0 ? null : days.map((entry, index) => {
          const hit = band(index)
          return h('rect', {
            key: `hit-${entry.date}`,
            x: hit.left,
            y: 0,
            width: hit.width,
            height,
            fill: 'transparent',
            onMouseEnter: () => { setHovered(index) },
            onMouseMove: () => { setHovered(index) },
          })
        })),
        active === null ? null : h('div', {
          style: {
            position: 'absolute',
            left: `${tooltipLeft}%`,
            top: 0,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            minWidth: 132,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.32))',
            background: 'var(--dsw-alias-bg-overlay, #24272c)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
            fontSize: 11.5,
            color: STRONG,
            whiteSpace: 'nowrap',
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, day === undefined ? '' : longDay(day.date)),
        rows.length === 0
          ? h('div', { style: { color: MUTED } }, '该日无调用')
          : rows.map((row) => h('div', {
            key: row.key,
            style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
          },
          h('span', { style: { width: 8, height: 8, borderRadius: 2, background: row.color, display: 'inline-block', flex: 'none' } }),
          h('span', { style: { color: MUTED, flex: 1, paddingRight: 10 } }, row.label),
          h('span', { style: { fontWeight: 600 } }, unit(row.value)))),
        h('div', { style: { marginTop: 5, paddingTop: 5, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))', color: MUTED } },
          day === undefined ? '' : `合计 ${unit(day.total)} · ${exact(day.calls)} 次调用`)))
    }

    /** Trend card: legend plus the per-day line chart for the selected window. */
    function TrendCard(props) {
      const data = props.data
      const totals = data.totals
      // `series` only exists once the Host half that computes it is loaded; an
      // older Host still serves `days`, so fall back to the type slice instead
      // of drawing an empty model chart.
      const canSliceByModel = Array.isArray(data.series) && data.series.length > 0
      const byModel = props.mode === 'model' && canSliceByModel

      // A React key has to be unique per series. The visible label is the model
      // name alone, but two providers can serve the same model id (on this
      // machine sensenova and deepseek-official both expose `deepseek-v4-flash`),
      // so the route — provider plus model — is what identifies a line.
      const series = byModel
        ? data.series.map((entry, index) => ({
          key: `${entry.provider}/${entry.model}`,
          label: entry.model || `模型 ${index + 1}`,
          hint: entry.provider,
          color: MODEL_COLORS[index % MODEL_COLORS.length],
          values: entry.values,
          total: entry.total,
        }))
        : KINDS.map((kind) => ({
          key: kind.key,
          label: kind.label,
          color: kind.color,
          values: data.days.map((day) => day[kind.key]),
          total: totals[kind.key],
        }))

      const empty = totals.total === 0

      return h('div', { style: { ...CARD, padding: '16px 18px 18px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
          h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, '每日 Token 趋势图'),
          h('div', { style: { flex: 1 } }),
          canSliceByModel ? h(ChipRow, {
            value: props.mode,
            compact: true,
            options: [{ value: 'model', label: '按模型' }, { value: 'type', label: '按类型' }],
            onChange: props.onModeChange,
          }) : null),
        empty
          ? h('div', { style: { height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MUTED, fontSize: 12.5 } },
            '所选区间没有模型调用')
          : h('div', null,
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px 18px', margin: '12px 0 6px' } },
              series.map((entry) => h('div', {
                key: entry.key,
                style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: MUTED },
              },
              h('span', { style: { width: 9, height: 9, borderRadius: 3, background: entry.color, display: 'inline-block', flex: 'none' } }),
              h('span', { style: { color: STRONG } }, entry.label),
              entry.hint ? h('span', { style: { opacity: 0.75 } }, entry.hint) : null,
              h('span', { title: `${exact(entry.total)} tokens` }, unit(entry.total))))),
            series.length === 0
              ? h('div', { style: { height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MUTED, fontSize: 12.5 } }, '所选区间没有模型调用')
              : h(LineChart, { series, days: data.days })))
    }

    /* ── panel ──────────────────────────────────────────────────────────── */

    /** The dashboard body registered under `main` key `usage-stats`. */
    function UsagePanel() {
      const [days, setDays] = React.useState(DEFAULT_DAYS)
      const [activityMode, setActivityMode] = React.useState('day')
      const [trendMode, setTrendMode] = React.useState('model')
      const [state, reload] = useUsage(days)
      const data = state.status === 'ready' ? state.data : undefined

      const status = data === undefined
        ? (state.status === 'error' ? `读取失败：${state.message}` : '正在读取…')
        : `${data.range.from === data.range.to ? data.range.from : `${data.range.from} ~ ${data.range.to}`}`
          + ` · 时区 ${data.timeZone}`
          + (data.ready === true ? '' : ' · 历史日志仍在统计中')
          + (state.stale === true ? ' · 数据可能已过期' : '')

      return h('div', {
        style: {
          height: '100%',
          overflowY: 'auto',
          padding: '18px 24px 40px',
          boxSizing: 'border-box',
          color: STRONG,
          fontSize: 13,
        },
      },
      // Cap the dashboard width and centre it: on a full-screen window the
      // cards keep a comfortable measure and the chart is not stretched across
      // the whole viewport.
      h('div', { style: { width: '100%', maxWidth: 1120, margin: '0 auto' } },
      h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
        h('div', { style: { fontSize: 15.5, fontWeight: 600 } }, 'Token 用量'),
        h('div', { style: { flex: 1 } }),
        h(Chip, { label: '刷新', active: false, onClick: () => { void reload() } })),
      h('div', { style: { fontSize: 11.5, color: MUTED, margin: '6px 0 16px' } }, status),

      data === undefined ? null : (data.stats === undefined
        ? h('div', {
          style: { ...CARD, padding: '14px 18px', fontSize: 12.5, color: MUTED },
        }, '宿主端已更新：重启 DSH 后显示累积 / 峰值 / 连续天数与全年活动热力图。')
        : h(TopStats, { stats: data.stats })),
      data === undefined ? null : h(TypeStrip, { totals: data.totals }),

      data === undefined || !Array.isArray(data.activity) || data.activity.length === 0 ? null
        : h('div', { style: { marginTop: 18 } },
          h(Heatmap, { activity: data.activity, mode: activityMode, onModeChange: setActivityMode })),

      h('div', { style: { display: 'flex', alignItems: 'center', margin: '20px 4px 10px' } },
        h('div', { style: { fontSize: 12.5, fontWeight: 600, color: MUTED } }, '时间范围'),
        h('div', { style: { flex: 1 } }),
        h(ChipRow, {
          value: days,
          options: RANGES.map((range) => ({ value: range.days, label: range.label })),
          onChange: setDays,
        })),

      data === undefined ? null : h(TrendCard, {
        data,
        days,
        mode: trendMode,
        onModeChange: setTrendMode,
      })))
    }

    /** The sidebar rail icon (owner props: `size`, `active`). */
    function UsageIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      const color = props?.active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('rect', { x: 2, y: 9, width: 3, height: 5, rx: 1, fill: color, opacity: 0.55 }),
      h('rect', { x: 6.5, y: 5.5, width: 3, height: 8.5, rx: 1, fill: color, opacity: 0.8 }),
      h('rect', { x: 11, y: 2.5, width: 3, height: 11.5, rx: 1, fill: color }))
    }

    /** Client plugin body. */
    function apply(ctx) {
      // `sidebar.panellist` ids address the matching `main` panel; both seats go
      // through `slots.inject` because the shell owns their declarations and
      // either may not exist yet when this plugin loads.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'usage-stats',
        order: 20,
        label: 'Token 用量',
      }, UsageIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'usage-stats',
      }, UsagePanel))
    }

    module.exports = { name: 'usage-stats-client', inject: ['slots'], apply }
    return module.exports
  },
})
