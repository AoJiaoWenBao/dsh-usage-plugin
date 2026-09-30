/**
 * dsh-plugin-usage-stats — Host half.
 *
 * Folds provider-reported token accounting into per-day buckets and serves the
 * result as JSON so the browser half can draw a dashboard.
 *
 * Data source: the durable `assistant/message` session event, whose payload is
 * `{ turn, step, message, usage?: TokenUsage }`. `TokenUsage` is DISJOINT:
 * `inputTokens` excludes cache hits, which are reported separately as
 * `cacheReadTokens` / `cacheWriteTokens`; `reasoningTokens` is a subset of
 * `outputTokens`, so it is reported for information but never added to a total.
 *
 * Two feeding paths, one deduplication rule:
 *   - history: `sessionQuery` reads every known session log once at startup;
 *   - live: the `session/event` fire-and-forget feed appends new events.
 * Every session keeps the highest `seq` already folded, so a late history scan
 * cannot double count an event the live feed already counted (and vice versa).
 *
 * The payload serves one dashboard shaped as: a top figures row (all-time
 * cumulative / peak day / longest session / day streaks), a contribution heat
 * map over the last year, and a per-day trend chart for the selected window
 * sliced either by token type or by model route.
 *
 * @module dsh-plugin-usage-stats
 */

/** JSON route the browser half fetches. */
const ROUTE_PATH = '/usage-stats/data'

/** Days returned when the request names no window. */
const DEFAULT_DAYS = 30

/** Upper bound for the `days` query parameter. */
const MAX_DAYS = 400

/** Heat-map span: 53 weeks of local calendar days. */
const ACTIVITY_DAYS = 371

/** Model routes kept as their own trend line before the rest collapse into `其他`. */
const TOP_MODELS = 6

/** Stable plugin name. */
export const name = 'usage-stats'

/** Token-type field names carried by one bucket, in display order. */
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

/** Local calendar day of an epoch-millisecond timestamp (`YYYY-MM-DD`). */
function dayKey(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return undefined
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local midnight of a `YYYY-MM-DD` key. */
function parseDayKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Shift a `YYYY-MM-DD` key by whole local days. */
function shiftDayKey(key, delta) {
  const date = parseDayKey(key)
  return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta).getTime())
}

/** Coerce one provider count to a finite non-negative integer. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** A zeroed per-day bucket. */
function emptyBucket(date) {
  const bucket = { date, calls: 0, sessions: 0 }
  for (const kind of KINDS) bucket[kind] = 0
  return bucket
}

/** A zeroed per-model aggregate. */
function emptyModel(model, provider) {
  const bucket = { model, provider, calls: 0 }
  for (const kind of KINDS) bucket[kind] = 0
  return bucket
}

/**
 * Add the disjoint counts of one model call into a bucket-shaped target.
 * `reasoning` is recorded but stays outside the billed sum (it is part of
 * `output`).
 */
function accumulate(target, usage) {
  target.input += count(usage.inputTokens)
  target.output += count(usage.outputTokens)
  target.cacheRead += count(usage.cacheReadTokens)
  target.cacheWrite += count(usage.cacheWriteTokens)
  target.reasoning += count(usage.reasoningTokens)
  target.calls += 1
}

/** Billed tokens of one bucket-shaped target (`output` already includes reasoning). */
function totalOf(target) {
  return target.input + target.output + target.cacheRead + target.cacheWrite
}

/** Public projection of one bucket-shaped target. */
function project(target) {
  return { ...target, total: totalOf(target) }
}

/**
 * The per-process usage fold. Holds every day bucket, the per-day per-model
 * buckets, the per-session time span, and the per-session `seq` watermark that
 * makes history and live ingestion idempotent.
 */
class UsageAggregator {
  constructor() {
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} local day -> bucket */
    this.days = new Map()
    /** @type {Map<string, Set<string>>} local day -> session ids that contributed */
    this.daySessions = new Map()
    /** @type {Map<string, ReturnType<typeof emptyModel>>} `provider/model` -> aggregate */
    this.models = new Map()
    /** @type {Map<string, Map<string, ReturnType<typeof emptyModel>>>} local day -> route -> aggregate */
    this.dayModels = new Map()
    /** @type {Map<string, {first: number, last: number}>} session id -> first/last event time */
    this.spans = new Map()
    /** @type {Map<string, number>} session id -> highest folded seq */
    this.watermark = new Map()
    /** @type {Map<string, string>} session id -> last seen `provider/model` route */
    this.route = new Map()
    /** @type {number} folded `assistant/message` events carrying usage */
    this.usageEvents = 0
    /** @type {boolean} whether the initial history scan completed */
    this.ready = false
  }

  /**
   * Fold one session event. Returns whether it carried usage.
   * @param {string} sessionId - owning session.
   * @param {{type?: string, seq?: number, time?: number, data?: unknown}} event - session event.
   */
  ingest(sessionId, event) {
    if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return false
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    if (seq !== undefined) {
      const seen = this.watermark.get(sessionId)
      if (seen !== undefined && seq <= seen) return false
      this.watermark.set(sessionId, seq)
    }

    // Session span: every event counts, not only the usage-bearing ones.
    const time = typeof event.time === 'number' ? event.time : undefined
    if (time !== undefined) {
      const span = this.spans.get(sessionId)
      if (span === undefined) this.spans.set(sessionId, { first: time, last: time })
      else {
        if (time < span.first) span.first = time
        if (time > span.last) span.last = time
      }
    }

    const data = event.data
    if (event.type === 'request/context' && data !== null && typeof data === 'object') {
      const provider = typeof data.provider === 'string' ? data.provider : ''
      const model = typeof data.model === 'string' ? data.model : ''
      if (provider !== '' || model !== '') this.route.set(sessionId, `${provider}/${model}`)
      return false
    }
    if (event.type !== 'assistant/message') return false
    const usage = data !== null && typeof data === 'object' ? data.usage : undefined
    if (usage === null || typeof usage !== 'object') return false
    const date = dayKey(time ?? Date.now())
    if (date === undefined) return false

    let bucket = this.days.get(date)
    if (bucket === undefined) {
      bucket = emptyBucket(date)
      this.days.set(date, bucket)
    }
    accumulate(bucket, usage)

    let sessions = this.daySessions.get(date)
    if (sessions === undefined) {
      sessions = new Set()
      this.daySessions.set(date, sessions)
    }
    sessions.add(sessionId)

    const route = this.route.get(sessionId)
    if (route !== undefined) {
      let model = this.models.get(route)
      if (model === undefined) {
        const slash = route.indexOf('/')
        model = emptyModel(route.slice(slash + 1), route.slice(0, slash))
        this.models.set(route, model)
      }
      accumulate(model, usage)

      let perDay = this.dayModels.get(date)
      if (perDay === undefined) {
        perDay = new Map()
        this.dayModels.set(date, perDay)
      }
      let dayModel = perDay.get(route)
      if (dayModel === undefined) {
        dayModel = emptyModel(model.model, model.provider)
        perDay.set(route, dayModel)
      }
      accumulate(dayModel, usage)
    }

    this.usageEvents += 1
    return true
  }

  /**
   * Fold the live `session/event` feed.
   * @param {{id?: string}} session - the owning session.
   * @param {unknown} event - the appended session event.
   */
  onLiveEvent(session, event) {
    try {
      const id = session !== null && typeof session === 'object' ? session.id : undefined
      if (typeof id !== 'string') return
      this.ingest(id, event)
    } catch {
      // The feed is fire-and-forget: one malformed payload must never escape
      // into the session's own append path.
    }
  }

  /**
   * Fold every event of every known session log through `sessionQuery`.
   * @param {object} query - the `sessionQuery` service.
   */
  async rebuild(query) {
    const records = await query.listSessions()
    for (const record of records ?? []) {
      const id = record?.header?.id
      if (typeof id !== 'string') continue
      let snapshot
      try {
        snapshot = await query.readSession(id)
      } catch {
        // A single unreadable log must not abort the whole scan.
        continue
      }
      for (const event of snapshot?.events ?? []) this.ingest(id, event)
    }
    this.ready = true
  }

  /** Ascending local day keys from the earliest bucket through today. */
  horizon() {
    const keys = [...this.days.keys()].sort()
    return { first: keys[0], last: keys[keys.length - 1], days: keys.length }
  }

  /**
   * All-time figures for the top row: cumulative tokens, the busiest day, the
   * longest session span, and day streaks.
   */
  stats() {
    let cumulative = 0
    let peakDate
    let peakTotal = 0
    const active = new Set()
    for (const [date, bucket] of this.days) {
      const total = totalOf(bucket)
      cumulative += total
      if (total > peakTotal) {
        peakTotal = total
        peakDate = date
      }
      if (total > 0) active.add(date)
    }
    let longestSessionMs = 0
    for (const span of this.spans.values()) {
      const duration = span.last - span.first
      if (duration > longestSessionMs) longestSessionMs = duration
    }
    return {
      cumulative,
      peak: { date: peakDate, total: peakTotal },
      longestSessionMs,
      streak: this.streaks(active),
      sessions: this.spans.size,
    }
  }

  /**
   * Current and longest runs of consecutive days with usage.
   * The current run counts back from today, or from yesterday when today has no
   * usage yet, so an ongoing streak stays visible during a quiet morning.
   */
  streaks(active) {
    const today = dayKey(Date.now())
    let cursor = active.has(today) ? today : shiftDayKey(today, -1)
    let current = 0
    while (active.has(cursor)) {
      current += 1
      cursor = shiftDayKey(cursor, -1)
    }
    let longest = 0
    let run = 0
    let previous
    for (const date of [...active].sort()) {
      run = previous !== undefined && shiftDayKey(previous, 1) === date ? run + 1 : 1
      if (run > longest) longest = run
      previous = date
    }
    return { current, longest }
  }

  /** Contribution-heat-map cells: the last `ACTIVITY_DAYS` local days. */
  activity() {
    const out = []
    const now = new Date()
    for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
      const date = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime())
      const bucket = this.days.get(date)
      out.push({ date, total: bucket === undefined ? 0 : totalOf(bucket), calls: bucket?.calls ?? 0 })
    }
    return out
  }

  /**
   * Per-day series per model route over `dates`, biggest routes first; the tail
   * beyond {@link TOP_MODELS} collapses into one `其他` line.
   * @param {readonly string[]} dates - ascending day keys of the window.
   */
  modelSeries(dates) {
    const index = new Map(dates.map((date, position) => [date, position]))
    const routes = new Map()
    for (const date of dates) {
      const perDay = this.dayModels.get(date)
      if (perDay === undefined) continue
      for (const [route, bucket] of perDay) {
        let entry = routes.get(route)
        if (entry === undefined) {
          entry = { provider: bucket.provider, model: bucket.model, total: 0, values: new Array(dates.length).fill(0) }
          routes.set(route, entry)
        }
        const value = totalOf(bucket)
        entry.total += value
        entry.values[index.get(date)] += value
      }
    }
    const sorted = [...routes.values()].sort((left, right) => right.total - left.total)
    if (sorted.length <= TOP_MODELS) return sorted
    const head = sorted.slice(0, TOP_MODELS)
    const other = { provider: '', model: '其他', total: 0, values: new Array(dates.length).fill(0) }
    for (const entry of sorted.slice(TOP_MODELS)) {
      other.total += entry.total
      for (let position = 0; position < other.values.length; position += 1) other.values[position] += entry.values[position]
    }
    return [...head, other]
  }

  /**
   * Build the JSON payload for the last `days` local calendar days.
   * @param {number} days - window size in days (already clamped).
   */
  snapshot(days) {
    const now = new Date()
    const dates = []
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      dates.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime()))
    }
    const series = dates.map((date) => {
      const bucket = this.days.get(date)
      const projected = project(bucket ?? emptyBucket(date))
      projected.sessions = this.daySessions.get(date)?.size ?? 0
      return projected
    })

    const totals = emptyBucket('total')
    for (const day of series) {
      for (const kind of KINDS) totals[kind] += day[kind]
      totals.calls += day.calls
    }
    totals.sessions = new Set(series.flatMap((day) => [...(this.daySessions.get(day.date) ?? [])])).size

    const models = [...this.models.values()]
      .map(project)
      .sort((left, right) => right.total - left.total)

    return {
      plugin: 'dsh-plugin-usage-stats',
      generatedAt: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ready: this.ready,
      range: { days, from: dates[0], to: dates[dates.length - 1] },
      kinds: KINDS,
      days: series,
      totals: project(totals),
      series: this.modelSeries(dates),
      models,
      activity: this.activity(),
      stats: this.stats(),
      horizon: this.horizon(),
      folded: { usageEvents: this.usageEvents, sessions: this.watermark.size },
    }
  }
}

/** Clamp the `days` query parameter. */
function clampDays(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAYS
  return Math.min(parsed, MAX_DAYS)
}

/**
 * Whether a Host authority names the local machine.
 * Mirrors the platform's loopback vocabulary: `localhost`, `[::1]`, any
 * `127.0.0.0/8` literal.
 */
function isLoopbackAuthority(authority) {
  const hostname = authority.hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || hostname.startsWith('127.')
}

/**
 * Access rule for the data route.
 *
 * A route registered directly on `webServer` carries none of the trust fence
 * the shipped `/api` route applies, so this repeats its browser-facing half:
 * the request must address the loopback authority, must not declare a
 * cross-site initiator, and a present `Origin` must be the request's own
 * authority. Loopback-only is deliberate — the desktop carrier loads the GUI
 * from `http://127.0.0.1:<port>`, so the panel always passes, while a
 * LAN-bound deployment can reach the GUI but not this aggregate. This is a
 * trust fence, not authentication.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns whether the request may read the snapshot.
 */
function isLoopbackBrowserRequest(req) {
  const headers = req.headers ?? {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackAuthority(authority)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Host plugin body: build the fold, wire both ingestion paths, and serve the
 * JSON route. Every dependency is optional, so the plugin also loads in a
 * composition without sessions or without a web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const aggregator = new UsageAggregator()

  // Live tail: the post-commit session event feed.
  ctx.on('session/event', (session, event) => { aggregator.onLiveEvent(session, event) })

  // History: one background scan at startup. The plugin does not wait for it;
  // the route reports `ready: false` until the fold has caught up.
  ctx.inject(['sessionQuery'], (queryCtx) => {
    const query = queryCtx.sessionQuery
    Promise.resolve()
      .then(() => aggregator.rebuild(query))
      .catch((error) => { ctx.logger.warn(error instanceof Error ? error : new Error(String(error))) })
  })

  // Data route: same origin as the GUI, no Auth beyond the loopback fence above.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        try {
          if (!isLoopbackBrowserRequest(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'usage-stats: request refused' }))
            return
          }
          const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost')
          const body = JSON.stringify(aggregator.snapshot(clampDays(url.searchParams.get('days'))))
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (error) {
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'usage-stats: failed to build the snapshot' }))
        }
      },
    }), 'usage-stats: data route')
  })

  ctx.logger.info('usage-stats: aggregating token usage (route %s)', ROUTE_PATH)
}
