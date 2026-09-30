/**
 * Regression test for the history/live race found in review.
 *
 * The live feed joins a session mid-stream, so the first `seq` it delivers sits
 * well above that session's history. The original deduplication rule — "drop
 * anything at or below the highest folded seq" — therefore discarded the entire
 * pre-load history of any session that was active when the plugin loaded, and
 * silently: the payload still reported `ready: true` with the tokens simply
 * missing.
 *
 * This suite pins the fix. The history scan is held open on a gate so that "the
 * live event arrived before the scan folded this session" is a fact about the
 * test, not a timing accident.
 *
 * Run: node test/race.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** A durable `assistant/message` event carrying usage. */
function message(seq, usage) {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn: 1, step: seq, message: { role: 'assistant' }, usage } }
}

/** A route-context event naming the provider route. */
function context(seq, provider, model) {
  return { type: 'request/context', seq, time: Date.now(), data: { provider, model } }
}

/**
 * One plugin instance whose history scan blocks on a gate, plus the handles the
 * test needs to drive it.
 * @param {Record<string, object[]>} history - session id -> events.
 */
function harness(history) {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let route
  const listeners = new Map()

  const sessionQuery = {
    async listSessions() {
      return Object.keys(history).map((id) => ({ header: { id }, live: false, persisted: true }))
    },
    async readSession(id) {
      await gate
      return { session: { id }, events: history[id] ?? [] }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    effect(factory) { return factory() },
    inject(deps, callback) {
      const scope = { ...ctx }
      if (deps.includes('sessionQuery')) scope.sessionQuery = sessionQuery
      if (deps.includes('webServer')) scope.webServer = { register(candidate) { route = candidate; return () => {} } }
      callback(scope)
      return () => {}
    },
  }

  apply(ctx)

  /** Call the registered route and parse its body. */
  const snapshot = () => new Promise((resolve) => {
    assert.ok(route, 'apply() registered the data route')
    route.handler(
      { url: '/usage-stats/data?days=1', headers: { host: '127.0.0.1:1' } },
      { writeHead() {}, end(text) { resolve(JSON.parse(text)) } },
    )
  })

  return {
    /** Deliver one event on the live `session/event` feed. */
    emitLive(sessionId, event) {
      for (const handler of listeners.get('session/event') ?? []) handler({ id: sessionId }, event)
    },
    /** Let the blocked history scan run. */
    openGate: () => release(),
    /** Poll until the scan reports ready, then return that payload. */
    async settled() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const body = await snapshot()
        if (body.ready === true) return body
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('the history scan never reported ready')
    },
  }
}

// Case 1: the live event lands first; the session must keep its history.
{
  const { emitLive, openGate, settled } = harness({
    'session-a': [
      context(1, 'rhy', 'deepseek-flash'),
      message(2, { inputTokens: 100, outputTokens: 10 }),
    ],
  })
  // The session is already active: a committed event arrives on the feed while
  // the history scan is still reading the log (seq 3 > the history's max seq 2).
  emitLive('session-a', message(3, { inputTokens: 7, outputTokens: 3 }))
  openGate()

  const body = await settled()
  assert.equal(body.folded.usageEvents, 2, 'the history event and the live event are both folded')
  assert.equal(body.totals.calls, 2, 'both calls are counted')
  assert.equal(body.totals.total, 100 + 10 + 7 + 3, 'no history token is lost to the live watermark')
  const model = body.models.find((entry) => entry.model === 'deepseek-flash')
  assert.ok(model, 'the route only the history scan saw is still learned')
  assert.equal(model.total, 110, 'the history call keeps its model attribution')
}

// Case 2: an event both paths see must be counted exactly once.
{
  const { emitLive, openGate, settled } = harness({
    'session-a': [
      context(1, 'rhy', 'deepseek-flash'),
      message(2, { inputTokens: 100, outputTokens: 10 }),
    ],
  })
  // The same event reaches the live feed and then the history scan.
  emitLive('session-a', message(2, { inputTokens: 100, outputTokens: 10 }))
  openGate()

  const body = await settled()
  assert.equal(body.folded.usageEvents, 1, 'an event both paths see is folded once')
  assert.equal(body.totals.calls, 1, 'the shared event is not double counted')
  assert.equal(body.totals.total, 110, 'the shared event contributes exactly once')
}

// Case 3: a session the feed never mentions still folds its whole history.
{
  const { openGate, settled } = harness({
    'session-a': [
      context(1, 'rhy', 'deepseek-flash'),
      message(2, { inputTokens: 5, outputTokens: 5 }),
    ],
  })
  openGate()

  const body = await settled()
  assert.equal(body.folded.usageEvents, 1, 'an idle session keeps its history')
  assert.equal(body.totals.total, 10, 'the idle session total is intact')
}

// Case 4: a live event for a session with no history at all is still folded.
{
  const { emitLive, openGate, settled } = harness({})
  emitLive('session-new', context(1, 'rhy', 'deepseek-flash'))
  emitLive('session-new', message(2, { inputTokens: 4, outputTokens: 6 }))
  openGate()

  const body = await settled()
  assert.equal(body.folded.usageEvents, 1, 'a session absent from history still folds its live events')
  assert.equal(body.totals.total, 10, 'the live-only session is counted')
}

console.log('race.test.mjs: all assertions passed')
