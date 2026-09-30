/**
 * Host-half test: drives `apply()` with a hand-built context (no Cordis
 * runtime), then reads the registered JSON route and asserts the fold.
 *
 * Run: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** Local-date helper: an epoch millisecond inside today minus `offset` days. */
function at(offsetDays, hour = 12) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays, hour, 0, 0).getTime()
}

/** The local `YYYY-MM-DD` key of an epoch millisecond. */
function key(time) {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A durable `assistant/message` event carrying usage. */
function message(seq, time, usage) {
  return { type: 'assistant/message', seq, time, data: { turn: 1, step: seq, message: { role: 'assistant' }, usage } }
}

/** A route-context event naming the provider route. */
function context(seq, time, provider, model) {
  return { type: 'request/context', seq, time, data: { provider, model } }
}

/** Two sessions with history: session A on day -2 and -1, session B on day -1. */
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const history = {
  [SESSION_A]: [
    context(1, at(2, 9), 'rhy', 'deepseek-flash'),
    message(2, at(2, 9), { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 }),
    message(3, at(1, 10), { inputTokens: 200, outputTokens: 80, cacheReadTokens: 2000, reasoningTokens: 30 }),
  ],
  [SESSION_B]: [
    context(1, at(1, 11), 'deepseek', 'deepseek-v4-pro'),
    message(2, at(1, 11), { inputTokens: 10, outputTokens: 5 }),
  ],
}

const listeners = new Map()
const routes = new Map()
const logs = []

const webServer = {
  register(route) {
    routes.set(`${route.kind}:${route.path}`, route)
    return () => routes.delete(`${route.kind}:${route.path}`)
  },
}

const sessionQuery = {
  async listSessions() {
    return Object.keys(history).map((id) => ({ header: { id }, live: false, persisted: true }))
  },
  async readSession(id) {
    return { session: { id }, events: history[id] ?? [] }
  },
}

/** Minimal stand-in for the Cordis context surface this plugin touches. */
function makeCtx() {
  return {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    on(eventName, handler) {
      const list = listeners.get(eventName) ?? []
      list.push(handler)
      listeners.set(eventName, list)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return () => dispose?.()
    },
    inject(deps, callback) {
      const scope = makeCtx()
      for (const dep of deps) {
        if (dep === 'sessionQuery') scope.sessionQuery = sessionQuery
        if (dep === 'webServer') scope.webServer = webServer
      }
      callback(scope)
      return () => {}
    },
  }
}

/** Emit one live session event to every `session/event` listener. */
function emitLive(sessionId, event) {
  for (const handler of listeners.get('session/event') ?? []) handler({ id: sessionId }, event)
}

/** Call the JSON route and parse its body. */
async function get(query = '', headers = { host: '127.0.0.1:19387' }) {
  const route = routes.get('exact:/usage-stats/data')
  assert.ok(route, 'the data route is registered')
  let status
  let body
  const res = {
    writeHead(code) { status = code },
    end(text) { body = text },
  }
  await route.handler({ url: `/usage-stats/data${query}`, headers }, res)
  return { status, json: JSON.parse(body) }
}

const ctx = makeCtx()
apply(ctx)

// The startup scan is asynchronous; let it settle.
await new Promise((resolve) => setTimeout(resolve, 20))

const { status, json } = await get('?days=7')
assert.equal(status, 200)
assert.equal(json.ready, true, 'history scan completed')
assert.equal(json.days.length, 7, 'the window is padded to full days')

const dayOfHistory = json.days.find((day) => day.date === key(at(2, 9)))
assert.deepEqual(
  { input: dayOfHistory.input, output: dayOfHistory.output, cacheRead: dayOfHistory.cacheRead, calls: dayOfHistory.calls, sessions: dayOfHistory.sessions },
  { input: 100, output: 50, cacheRead: 1000, calls: 1, sessions: 1 },
  'day -2 folds exactly one call',
)
assert.equal(dayOfHistory.total, 1150, 'total = input + output + cache reads')

const dayOfYesterday = json.days.find((day) => day.date === key(at(1, 9)))
assert.equal(dayOfYesterday.input, 210, 'both sessions folded into day -1')
assert.equal(dayOfYesterday.reasoning, 30, 'reasoning is reported separately')
assert.equal(dayOfYesterday.total, 200 + 80 + 2000 + 10 + 5, 'reasoning stays outside the billed total')
assert.equal(dayOfYesterday.sessions, 2)

assert.equal(json.totals.total, 1150 + 2295)
assert.equal(json.totals.calls, 3)
assert.equal(json.totals.sessions, 2)

const models = Object.fromEntries(json.models.map((m) => [m.model, m]))
assert.equal(models['deepseek-flash'].total, 1000 + 2000 + 100 + 50 + 200 + 80, 'model route folded from request/context')
assert.equal(models['deepseek-v4-pro'].total, 15)

// Per-day per-model series feeds the trend chart: one entry per route, values
// aligned with the window's day array (day -2 is index 4 of a 7-day window).
const flash = json.series.find((entry) => entry.model === 'deepseek-flash')
const pro = json.series.find((entry) => entry.model === 'deepseek-v4-pro')
assert.equal(json.series.length, 2, 'one series per route inside the window')
assert.equal(json.series[0].model, 'deepseek-flash', 'series are sorted by window total')
assert.deepEqual(flash.values, [0, 0, 0, 0, 1150, 2280, 0], 'the flash series carries each day separately')
assert.deepEqual(pro.values, [0, 0, 0, 0, 0, 15, 0], 'the second route keeps its own series')
assert.equal(flash.total, 3430)

// Heat map: a full year of local days, ending today.
assert.equal(json.activity.length, 371, 'the heat map spans 53 weeks')
assert.equal(json.activity[json.activity.length - 1].date, key(at(0, 12)), 'the heat map ends today')

// Top figures: all-time cumulative, busiest day, longest session, day streaks.
assert.equal(json.stats.cumulative, 1150 + 2295, 'cumulative covers the folded history')
assert.equal(json.stats.peak.total, 2295)
assert.equal(json.stats.peak.date, key(at(1, 9)))
assert.equal(json.stats.streak.current, 2, 'day -2 and day -1 are consecutive; today has no usage yet')
assert.equal(json.stats.streak.longest, 2)
assert.equal(json.stats.longestSessionMs, at(1, 10) - at(2, 9), 'session A spans day -2 to day -1')
assert.equal(json.stats.sessions, 2)

// Live tail after the history scan.
emitLive(SESSION_A, message(4, at(0, 15), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 700 }))
const afterLive = await get('?days=7')
assert.equal(afterLive.json.totals.total, 1150 + 2295 + 710, 'live events extend the fold')
assert.equal(afterLive.json.stats.cumulative, 1150 + 2295 + 710, 'cumulative follows the live tail')
assert.equal(afterLive.json.stats.streak.current, 3, 'today joins the current streak')
assert.equal(afterLive.json.stats.peak.total, 2295, 'the busiest day is unchanged')
assert.equal(afterLive.json.activity[afterLive.json.activity.length - 1].total, 710, 'the last heat cell is today')
assert.equal(afterLive.json.series[0].values[6], 710, 'the live call joins the last trend point')

// Replaying an already-folded seq must not double count.
emitLive(SESSION_A, message(4, at(0, 15), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 700 }))
const afterReplay = await get('?days=7')
assert.equal(afterReplay.json.totals.total, afterLive.json.totals.total, 'the seq watermark deduplicates replays')

// A second history scan must also stay idempotent.
await ctx.inject(['sessionQuery'], () => {})
const afterRescan = await get('?days=7')
assert.equal(afterRescan.json.totals.total, afterLive.json.totals.total, 're-scanning history does not double count')

// Window narrowing keeps the same data but a shorter series.
const short = await get('?days=1')
assert.equal(short.json.days.length, 1)
assert.equal(short.json.days[0].date, key(at(0, 15)))
assert.equal(short.json.totals.total, 710, 'the window clips older days')

// A malformed payload must not throw out of the fire-and-forget feed.
emitLive(SESSION_A, null)
emitLive({}, { type: 'assistant/message', seq: 99, time: at(0), data: { usage: 'nope' } })

// Access rule: a cross-site initiator is refused...
const crossSite = await get('?days=7', { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })
assert.equal(crossSite.status, 403, 'cross-site reads are refused')
// ...an Origin that is not the request's own authority is refused...
const foreignOrigin = await get('?days=7', { host: '127.0.0.1:19387', origin: 'http://evil.test' })
assert.equal(foreignOrigin.status, 403, 'a foreign Origin is refused')
// ...a request with no Host cannot be judged...
const noHost = await get('?days=7', {})
assert.equal(noHost.status, 403, 'a request without Host is refused')
// ...a non-loopback authority is refused (the LAN case)...
const lanHost = await get('?days=7', { host: '192.168.1.5:19387' })
assert.equal(lanHost.status, 403, 'a non-loopback authority is refused')
// ...and the shapes the desktop carrier actually sends pass.
const sameOrigin = await get('?days=7', { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })
assert.equal(sameOrigin.status, 200, 'a same-origin request passes')
const bare = await get('?days=7', { host: 'localhost:19387' })
assert.equal(bare.status, 200, 'a same-origin navigation without Origin passes')

console.log('host.test.mjs: all assertions passed')
void logs
