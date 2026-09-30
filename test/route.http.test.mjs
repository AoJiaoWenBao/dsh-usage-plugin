/**
 * Route integration test: serves the shipped handler on a real `node:http`
 * server (the WebRoute contract: handler owns the full response lifecycle) and
 * drives it over the wire with the exact header shapes the desktop carrier and
 * an attacker send.
 *
 * Run: node test/route.http.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { apply } from '../lib/index.js'

/** Local-date helper mirroring the aggregator's calendar day. */
function dayKey(offsetDays) {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays, 12)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const sessionQuery = {
  async listSessions() {
    return [{ header: { id: 'session-a' }, live: false, persisted: true }]
  },
  async readSession() {
    return {
      session: { id: 'session-a' },
      events: [
        { type: 'request/context', seq: 0, time: Date.now(), data: { provider: 'rhy', model: 'deepseek-flash' } },
        { type: 'assistant/message', seq: 1, time: Date.now(), data: { usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 1100 } } },
      ],
    }
  },
}

/** Captures the route the plugin registers, exactly like `ctx.webServer`. */
let route
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on() { return () => {} },
  effect(factory) { const dispose = factory(); return () => dispose?.() },
  inject(deps, callback) {
    const scope = { ...ctx }
    if (deps.includes('sessionQuery')) scope.sessionQuery = sessionQuery
    if (deps.includes('webServer')) {
      scope.webServer = {
        register(candidate) {
          route = candidate
          return () => { route = undefined }
        },
      }
    }
    callback(scope)
    return () => {}
  },
}

apply(ctx)
assert.ok(route, 'apply registered the data route')
assert.equal(route.kind, 'exact')
assert.equal(route.path, '/usage-stats/data')

// The real carrier: one node:http server whose handler is the registered route.
const server = createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end() })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port

/**
 * Raw request through the real HTTP stack with a verbatim Host header
 * (`fetch` forces Host to the connection authority, which is exactly the header
 * under test here).
 */
function request(headers, path = '/usage-stats/data?days=1') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const contentType = res.headers['content-type'] ?? ''
        resolve({
          status: res.statusCode,
          body,
          json: contentType.includes('json') ? JSON.parse(body) : undefined,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Wait for the background history scan to settle.
for (let attempt = 0; attempt < 50; attempt += 1) {
  const probe = await request({ host: `127.0.0.1:${port}` })
  if (probe.json?.ready === true) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const ok = await request({ host: `127.0.0.1:${port}` })
assert.equal(ok.status, 200, 'a loopback request succeeds')
assert.equal(ok.json.ready, true, 'the fold reported ready')
assert.equal(ok.json.totals.total, 11 + 5 + 1100)
assert.equal(ok.json.totals.calls, 1)
assert.equal(ok.json.days[0].date, dayKey(0))
assert.equal(ok.json.timeZone.length > 0, true, 'the payload names the fold time zone')
assert.equal(ok.json.models[0].model, 'deepseek-flash')

// The desktop carrier sends this exact shape: loopback Host, no Origin on GET.
const carrier = await request({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', accept: 'application/json' })
assert.equal(carrier.status, 200, 'the carrier request shape passes')

// Localhost spelling of the same authority.
const localhost = await request({ host: `localhost:${port}` })
assert.equal(localhost.status, 200, 'the localhost authority passes')

// A browser page on another origin using this machine as a rebinding target.
const crossSite = await request({ host: `127.0.0.1:${port}`, origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' })
assert.equal(crossSite.status, 403, 'a cross-site initiator is refused')
const foreignOrigin = await request({ host: `127.0.0.1:${port}`, origin: 'http://evil.test' })
assert.equal(foreignOrigin.status, 403, 'a foreign Origin is refused')

// A LAN peer: the fence is the loopback authority, not the source address.
const lan = await request({ host: `192.168.1.5:${port}` })
assert.equal(lan.status, 403, 'a non-loopback Host is refused')

// Window clamping over the wire.
const clamped = await request({ host: `127.0.0.1:${port}` }, '/usage-stats/data?days=0')
assert.equal(clamped.json.range.days, 30, 'days=0 falls back to the default window')
const huge = await request({ host: `127.0.0.1:${port}` }, '/usage-stats/data?days=99999')
assert.equal(huge.json.range.days, 400, 'days is clamped to the maximum window')

// The handler owns its own failures: an unusable Host must not 500.
const broken = await request({ host: 'not a host' })
assert.equal(broken.status, 403, 'an unparseable authority is refused, not crashed')

server.close()
await once(server, 'close')
console.log('route.http.test.mjs: all assertions passed')
