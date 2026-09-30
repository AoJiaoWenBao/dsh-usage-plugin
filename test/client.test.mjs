/**
 * Browser-half test: executes `lib/client.js` against a stand-in
 * `window.__ModuleLoader__` and a minimal React, then drives the exported
 * plugin exactly like the shell does (slots.inject + slots.register) and
 * renders the dashboard from a fixture payload.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** Hook values the render under test should observe, consumed positionally. */
let useStateOverrides = []

/** Minimal React: `createElement` returns a plain tree plus a hook runtime. */
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat()
    // Mirror React: children also arrive on props, flattened the same way.
    return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat }, children: flat }
  },
  useState(initial) {
    const override = useStateOverrides.shift()
    return [override === undefined ? initial : override, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

/** Capture the loader handoff. */
let loaded
const sandbox = { window: {}, document: undefined, fetch: () => Promise.reject(new Error('no network in test')) }
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    loaded = entry
  },
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

assert.ok(loaded, 'the bundle registers a module with the loader')
assert.equal(loaded.id, 'dsh-plugin-usage-stats', 'the registered id is the package name')
assert.equal(typeof loaded.factory, 'function', 'the handoff carries a CJS factory')

const plugin = loaded.factory((specifier) => {
  assert.equal(specifier, 'react', 'react is the only external the bundle requires')
  return React
})

assert.equal(plugin.name, 'usage-stats-client')
assert.deepEqual([...plugin.inject], ['slots'], 'the client plugin injects the slots service')
assert.equal(typeof plugin.apply, 'function')

/** Record the seat registrations an apply call produces. */
const injected = []
const registered = []
const fakeCtx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)

assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'both seats wait on their owner declaration')
assert.equal(registered.length, 2)
const [icon, panel] = registered
assert.deepEqual(
  { name: icon.options.name, id: icon.options.id, label: icon.options.label },
  { name: 'sidebar.panellist', id: 'usage-stats', label: 'Token 用量' },
  'the sidebar icon uses the id that addresses the main panel',
)
assert.deepEqual(
  { name: panel.options.name, key: panel.options.key },
  { name: 'main', key: 'usage-stats' },
  'the dashboard occupies the matching main panel key',
)

/** Collect every string in a rendered element tree, invoking function components. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    textOf(node.type(node.props), out)
    return out
  }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/** Collect every `title` attribute in a rendered element tree (hover text). */
function titlesOf(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) titlesOf(child, out)
    return out
  }
  if (typeof node.props?.title === 'string') out.push(node.props.title)
  if (typeof node.type === 'function') {
    titlesOf(node.type(node.props), out)
    return out
  }
  for (const child of node.children ?? []) titlesOf(child, out)
  return out
}

// The icon renders from owner props alone.
const iconText = textOf(icon.component({ size: 16, active: true }))
assert.deepEqual(iconText, [], 'the rail icon renders an svg without text')

const fixture = {
  plugin: 'dsh-plugin-usage-stats',
  generatedAt: Date.now(),
  timeZone: 'Asia/Shanghai',
  ready: true,
  range: { days: 2, from: '2026-09-29', to: '2026-09-30' },
  kinds: ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'],
  days: [
    { date: '2026-09-29', calls: 2, sessions: 1, input: 300, output: 130, cacheRead: 3000, cacheWrite: 0, reasoning: 30, total: 3430 },
    { date: '2026-09-30', calls: 1, sessions: 1, input: 7, output: 3, cacheRead: 700, cacheWrite: 0, reasoning: 0, total: 710 },
  ],
  totals: { date: 'total', calls: 3, sessions: 2, input: 307, output: 133, cacheRead: 3700, cacheWrite: 0, reasoning: 30, total: 4140 },
  series: [
    { provider: 'rhy', model: 'deepseek-flash', total: 3430, values: [3430, 0] },
    { provider: 'deepseek', model: 'deepseek-v4-pro', total: 710, values: [0, 710] },
  ],
  models: [
    { model: 'deepseek-flash', provider: 'rhy', calls: 2, input: 300, output: 130, cacheRead: 3000, cacheWrite: 0, reasoning: 30, total: 3430 },
    { model: 'deepseek-v4-pro', provider: 'deepseek', calls: 1, input: 7, output: 3, cacheRead: 700, cacheWrite: 0, reasoning: 0, total: 710 },
  ],
  activity: [
    { date: '2026-09-14', total: 0, calls: 0 },
    { date: '2026-09-15', total: 1200, calls: 3 },
    { date: '2026-09-16', total: 0, calls: 0 },
    { date: '2026-09-17', total: 34000, calls: 9 },
    { date: '2026-09-18', total: 0, calls: 0 },
    { date: '2026-09-19', total: 0, calls: 0 },
    { date: '2026-09-20', total: 500, calls: 1 },
    { date: '2026-09-21', total: 0, calls: 0 },
    { date: '2026-09-22', total: 0, calls: 0 },
    { date: '2026-09-23', total: 0, calls: 0 },
    { date: '2026-09-24', total: 0, calls: 0 },
    { date: '2026-09-25', total: 0, calls: 0 },
    { date: '2026-09-26', total: 0, calls: 0 },
    { date: '2026-09-27', total: 0, calls: 0 },
    { date: '2026-09-28', total: 4000, calls: 2 },
    { date: '2026-09-29', total: 3430, calls: 2 },
    { date: '2026-09-30', total: 710, calls: 1 },
  ],
  stats: {
    cumulative: 21800000000,
    peak: { date: '2026-09-15', total: 660000000 },
    longestSessionMs: 11 * 3600000 + 21 * 60000,
    streak: { current: 3, longest: 5 },
    sessions: 59,
  },
  horizon: { first: '2026-08-14', last: '2026-09-30', days: 17 },
  folded: { usageEvents: 3, sessions: 2 },
}

// Hook order in UsagePanel: window, heat-map mode, trend mode, then useUsage.
useStateOverrides = [undefined, undefined, undefined, { status: 'ready', data: fixture }]
const rendered = panel.component({})
const strings = textOf(rendered)
const text = strings.join(' | ')

assert.ok(text.includes('Token 用量'), 'the panel renders its title')
assert.ok(text.includes('Asia/Shanghai'), 'the header reports the fold time zone')

// Top figures row, mirroring the reference board.
assert.ok(text.includes('累积 Token 数'), 'the top row names the cumulative figure')
assert.ok(text.includes('峰值 Token 数') && text.includes('最长聊天时长'), 'the top row names the peak and duration figures')
assert.ok(text.includes('当前连续天数') && text.includes('最长连续天数'), 'the top row names both streaks')
assert.ok(text.includes('218亿'), 'the cumulative figure is shortened to 亿')
assert.ok(text.includes('6.6亿'), 'the peak figure is shortened to 亿')
assert.ok(text.includes('11 小时 21 分钟'), 'the duration figure is human readable')
assert.ok(text.includes('3 天') && text.includes('5 天'), 'both streaks render')

// Token types stay visible with exact numbers for the selected window.
assert.ok(text.includes('输入') && text.includes('输出') && text.includes('缓存命中') && text.includes('缓存写入') && text.includes('思维链'), 'every token type is named')
assert.ok(text.includes('4,140') && text.includes('3,700'), 'the type strip shows exact window totals')

// Big counts are shown in 万 / 亿 everywhere, never as a wall of digits.
const bigPayload = {
  ...fixture,
  days: fixture.days.map((day, index) => (index === 0
    ? { ...day, cacheRead: 84752512, input: 2349101, output: 556808, total: 87658421 }
    : { ...day, cacheRead: 68738651, total: 68738651 })),
  totals: { ...fixture.totals, cacheRead: 84752512, input: 2349101, output: 556808, total: 87658421 },
  series: [{ provider: 'rhy', model: 'deepseek-flash', total: 87658421, values: [87658421, 0] }],
  activity: fixture.activity.map((cell, index) => (index === fixture.activity.length - 1
    ? { ...cell, total: 68738651, calls: 395 }
    : cell)),
  stats: { ...fixture.stats, cumulative: 245726594, peak: { date: '2026-09-30', total: 104158188 } },
}
useStateOverrides = [undefined, undefined, undefined, { status: 'ready', data: bigPayload }]
const bigTree = panel.component({})
const bigText = textOf(bigTree).join(' | ')
assert.ok(bigText.includes('2.46亿'), 'the cumulative figure uses 亿')
assert.ok(bigText.includes('1.04亿'), 'the peak figure uses 亿')
assert.ok(bigText.includes('8766万'), 'the type strip uses 万')
assert.ok(bigText.includes('6574万'), 'the y axis uses one 万 unit for the whole scale')
assert.ok(bigText.includes('8766万'), 'the trend legend and axis tick share the 万 unit')
assert.ok(!bigText.includes('87,658,421'), 'no raw eight-digit token count is rendered')
assert.ok(!bigText.includes('68,738,651'), 'no raw eight-digit day count is rendered')
// The exact value stays reachable on hover.
const bigTitles = titlesOf(bigTree)
assert.ok(bigTitles.some((title) => title.includes('87,658,421')), 'hovering the type strip reveals the exact total')
assert.ok(bigTitles.some((title) => title.includes('6874万 tokens')), 'the heat-map tooltip uses 万 as well')
assert.equal(useStateOverrides.length, 0, 'every hook read its override')

// Hovering a day opens the chart tooltip with that day's per-series values.
function countHoverTargets(node, total = 0) {
  if (node === null || typeof node !== 'object') return total
  if (Array.isArray(node)) {
    for (const child of node) total = countHoverTargets(child, total)
    return total
  }
  if (typeof node.props?.onMouseEnter === 'function') total += 1
  if (typeof node.type === 'function') return countHoverTargets(node.type(node.props), total)
  for (const child of node.children ?? []) total = countHoverTargets(child, total)
  return total
}

useStateOverrides = [7, undefined, undefined, { status: 'ready', data: fixture }]
const noHover = panel.component({})
assert.equal(countHoverTargets(noHover), fixture.days.length, 'every day gets a hover hit band')
useStateOverrides = [7, undefined, undefined, { status: 'ready', data: fixture }, 1]
const hoverTree = panel.component({})
const hoverText = textOf(hoverTree).join(' | ')
assert.ok(hoverText.includes('2026年9月30日'), 'the chart tooltip names the hovered day')
assert.ok(hoverText.includes('deepseek-v4-pro'), 'the tooltip lists the series that ran that day')
assert.ok(hoverText.includes('710'), 'the tooltip shows the hovered day value')
assert.ok(hoverText.includes('合计 710 · 1 次调用'), 'the tooltip footers the day total and call count')
assert.ok(!hoverText.includes('3430'), 'a series with no usage that day is omitted')
assert.equal(useStateOverrides.length, 0, 'every hook read its override')

// Heat map card with its three modes and month rail.
assert.ok(text.includes('Token 活动'), 'the heat map is titled')
assert.ok(text.includes('每日') && text.includes('每周') && text.includes('累计'), 'the heat map offers all three modes')
assert.ok(text.includes('9月'), 'the heat map renders its month rail')
assert.ok(text.includes('少') && text.includes('多'), 'the heat map renders its scale legend')

// Range switch and trend chart.
assert.ok(text.includes('时间范围'), 'the range row is titled')
assert.ok(text.includes('近 7 天') && text.includes('近 30 天'), 'both remaining windows are offered')
assert.ok(!text.includes('当天'), 'the single-day window is gone')
assert.ok(!text.includes('近 90 天'), 'the 90-day window is gone')
assert.ok(text.includes('每日 Token 趋势图'), 'the trend card is titled')
assert.ok(!text.includes('今日构成'), 'the single-day composition view is gone')
assert.ok(text.includes('按模型') && text.includes('按类型'), 'the trend card offers both slices')
assert.ok(text.includes('deepseek-flash') && text.includes('rhy'), 'the model legend names the route')
assert.ok(text.includes('9月29日') && text.includes('9月30日'), 'the x axis is labelled with dates')
assert.ok(!text.includes('每日明细'), 'the daily detail table is gone')
assert.equal(useStateOverrides.length, 0, 'every hook read its override')

// Layout: the dashboard is capped and centred, and the heat-map grid is centred
// inside its card, so a full-screen window leaves symmetric whitespace.
function stylesOf(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) stylesOf(child, out)
    return out
  }
  if (node.props?.style !== undefined) out.push(node.props.style)
  if (typeof node.type === 'function') {
    stylesOf(node.type(node.props), out)
    return out
  }
  for (const child of node.children ?? []) stylesOf(child, out)
  return out
}

useStateOverrides = [30, undefined, undefined, { status: 'ready', data: fixture }]
const layoutStyles = stylesOf(panel.component({}))
assert.ok(
  layoutStyles.some((style) => style.maxWidth === 1120 && style.margin === '0 auto'),
  'the dashboard column is width-capped and centred',
)
assert.ok(
  layoutStyles.some((style) => style.width === 'fit-content' && style.margin === '0 auto'),
  'the heat-map grid is centred inside its card',
)

// Slicing by token type swaps the legend to the token vocabulary.
useStateOverrides = [undefined, undefined, 'type', { status: 'ready', data: fixture }]
const byType = textOf(panel.component({})).join(' | ')
assert.ok(byType.includes('缓存命中') && byType.includes('思维链'), 'the type slice keeps the token legend')
assert.ok(!byType.includes('deepseek-flash'), 'the type slice hides model names')

// An older Host payload (no stats / activity / series) must degrade, not crash.
const legacy = { ...fixture }
delete legacy.stats
delete legacy.activity
delete legacy.series
useStateOverrides = [undefined, undefined, 'model', { status: 'ready', data: legacy }]
const legacyText = textOf(panel.component({})).join(' | ')
assert.ok(legacyText.includes('重启 DSH'), 'a Host without the new fields asks for a restart instead of crashing')
assert.ok(!legacyText.includes('Token 活动'), 'the heat map is omitted without activity data')
assert.ok(!legacyText.includes('按模型'), 'the model slice is hidden without per-day model series')
assert.ok(legacyText.includes('输入') && legacyText.includes('4,140'), 'the type slice still renders from the day buckets')
assert.ok(legacyText.includes('每日 Token 趋势图'), 'the trend card still renders')

// Heat-map modes change the grid shape (weekly collapses to one row).
useStateOverrides = [undefined, 'week', undefined, { status: 'ready', data: fixture }]
const weekly = panel.component({})
assert.ok(textOf(weekly).join(' | ').includes('Token 活动'), 'the weekly heat map still renders')

// The longer window renders the chart straight away, with a point per day.
useStateOverrides = [30, undefined, undefined, { status: 'ready', data: fixture }]
const month = textOf(panel.component({})).join(' | ')
assert.ok(month.includes('每日 Token 趋势图') && month.includes('deepseek-flash'), 'the 30-day window draws the chart')

// Zero usage renders the empty hint rather than a broken chart.
const zeroTotals = { ...fixture.totals, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
useStateOverrides = [30, undefined, undefined, { status: 'ready', data: { ...fixture, totals: zeroTotals } }]
const emptyRange = textOf(panel.component({})).join(' | ')
assert.ok(emptyRange.includes('所选区间没有模型调用'), 'an empty window explains itself')

// An error state renders its message instead of crashing.
useStateOverrides = [30, undefined, undefined, { status: 'error', message: 'HTTP 500' }]
const errored = textOf(panel.component({})).join(' | ')
assert.ok(errored.includes('读取失败') && errored.includes('HTTP 500'), 'the error branch reports the failure')

console.log('client.test.mjs: all assertions passed')
