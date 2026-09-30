# DSH historical token-usage — EXACT on-disk contract

Researched: 2026-09-30 ~09:40–09:50 +08:00 · DSH_HOME = `C:\Users\52609\.dsh`

---

## 0. ⚠️ FIRST: three different runtimes exist — only one is LIVE

| # | Source | Path | `dsh-session` | `SESSION_FORMAT_VERSION` | filename written |
|---|---|---|---|---|---|
| **A** | *task checkout* | `D:\workspace\deepseek-harness-master` | `0.1.0-rc.5` | **0** | `session.jsonl[.zstd]` |
| B | profile pnpm install | `C:\Users\52609\.dsh\profiles\node_modules\@deepseek-ai\*` | `0.1.6-alpha.1` | **3** | `session.v3.jsonl[.zstd]` |
| **C** | **LIVE desktop app** | `D:\rj\dsh\resources\app.asar` → `dsh/node_modules/@deepseek-ai/*` | **`0.2.0-rc.2`** | **4** | `session.v4.jsonl[.zstd]` |

**The live runtime is C.** Proof: this very session's log is
`...\--D-workspace-dsh-plugin--\session-54cb3370-...\session.v4.jsonl.zstd`.

Live constant (extracted from the asar):

```js
// .../dsh-session/lib/types/types.js:54
export const SESSION_FORMAT_VERSION = 4;
```

The checkout says the opposite:

```ts
// D:\workspace\deepseek-harness-master\packages\core\session\src\types.ts:56
export const SESSION_FORMAT_VERSION = 0
```

```ts
// D:\workspace\deepseek-harness-master\packages\session\session-persistence-jsonl\src\format.ts:24-26
export function logSuffix(compression: JsonlCompression): '.jsonl.zstd' | '.jsonl' {
  return compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
}
```

**The checkout cannot read 32 of the 66 real logs (the v3 + v4 ones).** Use it only as background.
Live sources were extracted read-only to `D:\workspace\dsh-plugin\_research\live-asar\`.

---

## 1. Where logs live on this machine

`DSH_HOME` env is unset → default `~/.dsh` (`dsh-home-paths/lib/index.js:49-51,73-75`).
Root config (live bundle):

```yaml
# .../dsh-base/cordis.patch.yml:130-133
    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
```

→ **`C:\Users\52609\.dsh\sessions`** — **HOME-scoped, NOT profile-scoped.**
`compression` is unset → default `'zstd'`; `packChunks` is gone in the live version.

```
C:\Users\52609\.dsh\
  sessions\                                  <-- THE LOGS
    --<normalized-cwd>--\                    e.g. --D-workspace-dsh-plugin--
      <encoded-id>\                          e.g. session-54cb3370-72cd-4cf8-9ac3-067588fdb66d
        session.v4.jsonl.zstd                current (live) generation
        session.v3.jsonl.zstd                historical
        session.jsonl.zstd                   historical v0 (no .vN component)
  storages\                                  storage hub, NOT logs
    workspace.json, session_projcache.json, session_projcache\sessions\<id>.json
  profiles\web\, profiles\desktop\           profile roots (bundles, patch yml, package.json)
  profiles\node_modules\@deepseek-ai\        pnpm-installed plugins (stale, 0.1.6-alpha.1)
  attachments\, speech-to-text\, .agent-presets\
```

Filename rule (live):

```js
// .../dsh-session-format/lib/index.js:464
const CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u;
// :472-475
function sessionFormatLogFilename(version) {
	const generation = sessionFormatVersion(version, "Session log generation version");
	return generation === 0 ? "session.jsonl" : `session.v${generation}.jsonl`;
}
```

```js
// .../dsh-session-persistence-jsonl/lib/index.js:747-752, 761-763
function logSuffix(compression) { return `.jsonl${compressionSuffix(compression)}`; }
function compressionSuffix(compression) { return compression === "zstd" ? ".zstd" : ""; }
function generationLogFilename(version, compression) {
	return `${sessionFormatLogFilename(version)}${compressionSuffix(compression)}`;
}
```

**Glob `sessions\*\*\session*.jsonl*` — a single-generation glob misses 49 of 66 logs.**

---

## 2. Exact on-disk record format

### 2.1 Physical encoding — concatenated zstd frames (critical gotcha)

One checksummed zstd frame containing only the header line, then **one frame per durable append batch**, concatenated in one file (`README.md:100`).

> **VERIFIED GOTCHA:** on Node **v22.22.0**, `zlib.zstdDecompressSync(buf)` and the
> `zlib.createZstdDecompress()` stream **both stop after the first frame**. My first scan
> decoded exactly 1 line per file (the header) and reported 0 tokens. You must iterate
> frames — split on magic `28 B5 2F FD` and decompress each — or use the backend.

Also: **planned `compression: 'none'` is not in effect**, so raw `.jsonl` line-reading does not work here.

### 2.2 Line 1 — header (no `seq`, no `data`)

Real, largest v4 log (`--D-workspace-cusuan-job-system--\session-bb878798-...\session.v4.jsonl.zstd`, 654,692 B, 341 frames, 637 lines):

```json
{"type":"session","version":4,"id":"session-bb878798-229b-4390-9b8f-a75498aea3df","createdAt":1790661627734,"cwd":"D:\\workspace\\cusuan-job-system","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

Header keys: `type, version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset` (+`parentSession`, `origin` optional). `type` is the slash-less tag `"session"`. `createdAt` is **epoch ms**.

### 2.3 Line 2+ — one event per line

```json
{"type":"permission/preset","seq":0,"time":1790661627738,"data":{"preset":"workspace-write"}}
```

Envelope (live inspect, `SessionEvent`):

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
        type: K; seq: SessionSeq; time: number; data: SessionEventMap[K]; ignorable?: true;
    } & (K extends SurfaceEventType ? SurfaceIntent<K> : { surfaceOp?: never; sourceEventSeqs?: never });
}[T];
```

- field names are exactly **`seq`, `time`, `type`, `data`** — there is **no `timestamp`**
- **`time` is epoch MILLISECONDS as a JSON number** (verified: `1790661651219` → `2026-09-29T06:00:51.219Z`)
- surface events additionally carry **`surfaceOp`** (`"append"` or `{op:'replace',startSeq,endSeq}`)

### 2.4 The assistant-message event

Type spelled **`"assistant/message"`** (with the slash, verbatim in the JSON).

Real line, first 400 chars (`seq:15`, `time:1790661651219`):

```json
{"type":"assistant/message","seq":15,"time":1790661651219,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"The user wants me to review a markdown file for omissions. Let me find it first."},{"type":"tool-call","id":"call_00_0kynrhzar7poxkewj0vq6wn6","name":"glob","arguments":"{\"pattern\":\"**/*受限空间超期结票*\"}"},{"type":"tool-call","id":"call_01_b7iofdl3e
```

Parsed shape (live, from the running Host's own type registry):

```ts
'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    stream: AssistantStreamRecord[];
    usage?: TokenUsage;
    interrupted?: true;
};
```

```ts
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```

**Correction to the stated premise:** `data` is `{turn, step, message, usage?, stream, interrupted?}` —
**`stream` is a REQUIRED, non-optional array in v3 and v4** (it is absent only in v0). The stated
`{turn, step, message, usage?}` is correct **for v0 only**.

Raw proof from that log:

```
top-level keys: [ 'type', 'seq', 'time', 'data', 'surfaceOp' ]
data keys:      [ 'turn', 'step', 'message', 'usage', 'stream' ]
data.usage:     {"inputTokens":7483,"outputTokens":127,"totalTokens":7610}
data.stream:    11 records, first = {"type":"chunk","time":1790661650330,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}
```

### 2.5 Grep evidence (`node` over the decoded text — the file is not text-greppable)

```
lines containing "assistant/message": 91
lines containing "usage":             91
```

Every `assistant/message` carries `usage` in v3/v4 (610/610 and 502/502). In v0, 612 of 615.

### 2.6 Row vocabulary differs by generation — a naive parser breaks

| generation | files | `assistant/message` | has `stream` | packed rows present |
|---|---|---|---|---|
| v0 | 34 | 615 (612 w/ usage) | **no** | `text-chunks`, `reasoning-chunks`, `tool-call-chunks`, `assistant/chunk` |
| v3 | 15 | 610 (610 w/ usage) | yes | none |
| v4 | 17 | 515 (515 w/ usage) | yes | none |

v0 logs contain **73 173 slash-less packed rows and `assistant/chunk` events** that are *not*
`SessionEvent`s. Any line reader must skip rows whose `type` is not a known event tag
(or simply match on `"assistant/message"`).

---

## 3. Robust plugin API

**Use `ctx.sessionQuery`** — the exact Service key is `sessionQuery` (mounted from
`@deepseek-ai/dsh-session-query` via `@deepseek-ai/dsh-session-query-sqlite`).

```yaml
# .../dsh-base/cordis.patch.yml:141-153  (comment: "openAt: never keeps ctx.sessionQuery mounted —
# exact reads, titles, and lineage traces ... stay available — while search calls fail with
# SESSION_QUERY_SEARCH_DISABLED and SQLite is never opened")
    - id: session-query-sqlite
      name: '@deepseek-ai/dsh-session-query-sqlite'
      config:
        path: ':memory:'
        openAt: never
```

Access: `ctx.sessionQuery` (hard inject `['sessionQuery']`) or `ctx.get("sessionQuery")` (optional).

| Method | Contract |
|---|---|
| `listSessions(signal?): Promise<SessionRecord[]>` | complete logical corpus, newest-first; `SessionRecord = {header, live, persisted}` |
| `filterSessions(filters, signal?)` | ANDed `SessionResultFilter`s (`id`/`cwd`/`created-at`/`parent`/`availability`) |
| `readSession(id): Promise<SessionLogSnapshot>` | `{session: SessionHeader, inheritedEventCount, events: SessionEvent[]}` — replay-validated, does **not** make it live |
| `listEvents(id): Promise<SessionEventRecord[]>` | `{sessionId, seq, type, time, surface}` ascending — **cheap, ideal for token backfill** |
| `readEvent({sessionId, seq, before?, after?})` | one full event + bounded window (`readWindowMax` 50) |
| `filterEvents(id, filters)` | semantic docs + literal-text predicate |
| `observeSession(id, opts)` / `readSurface(id)` / `readTitle*` / `traceSession` / `traceEvent` | as named |
| `searchSessions` / `searchEvents` | ⚠️ **throw `SESSION_QUERY_SEARCH_DISABLED`** on this profile |

`readSession`/`listEvents` handle generation selection + v0/v3→v4 migration internally, so they are
**generation-agnostic** — the single biggest reason to prefer the Service over raw file parsing.

Lower-level alternatives (both confirmed live):
- `ctx.sessionPersistence` — `list(options?)`, `stat(id)`, `open(id, 'read'|'write')` → `SessionHandle.read(offset?, length?)`. Hands you raw `SessionEvent[]`.
- `ctx.sessions` — **in-memory store only** (`list()` = live sessions, `get(id)`); useless for disk history. Persistence is deliberately not implemented here.

---

## 4. Live subscription

```ts
// exact contract from cordis_inspect_query platform=host provider=Event method=listEvents {event:"session/event"}
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void   // mode: emit
```

Listener args are **`(session, event)`** — `session` first, the appended `event` second.
Semantics: *"Post-commit, fire-and-forget append feed… callbacks run after [the log push];
observer failures are logged and contained without making the committed append fail.
Scope-filtered dispatch: agent-scoped listeners receive only events from sessions entered
through that agent's context."*

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'assistant/message') return
  const usage = event.data.usage            // TokenUsage | undefined
  ...
})
```

Related: `'session/flush'(this: Scoped<Session>, session: Session)` is a **parallel** durability
checkpoint — use it before reading storage in the same tick. `ctx.sessions.flush(session)` is the
sanctioned entry point. `'session/created'` / `'session/disposed'` also emit with `(session)`.

---

## 5. Real corpus on this machine

Snapshot 2026-09-30T09:47:21+08:00 (via the script in §6):

- **66 log files**, 14.1 MiB compressed, **15,197+ zstd frames**, ~29,300 event rows
- generations: **v0 ×34, v3 ×15, v4 ×17** — all three coexist
- **date range** (header `createdAt`): `2026-08-14T00:48:48.527Z` → `2026-09-30T01:40:40Z`
- `assistant/message` events: ~1,740; with `usage`: ~1,737
- **59 sessions** have ≥1 usage-bearing assistant message

**Token totals** (sum over `data.usage` of every `assistant/message`):

| field | total |
|---|---|
| `inputTokens` | **9,680,565** |
| `outputTokens` | **1,466,491** |
| `cacheReadTokens` | **188,054,141** |
| `cacheWriteTokens` | **0** — the key never appears once in the entire corpus |
| `reasoningTokens` | **2,122** — present in only 23 v0 events |
| derived `input+output+cacheRead` | **199,201,197** |
| `totalTokens` (sum of the field, present in ~1,120 events) | **154,711,620** |

⚠️ **The corpus is live-growing.** Two runs 10 minutes apart differed by ~640 lines and ~2.6 M
tokens because *this* session was being appended while scanning. Numbers are a moving target.
`totalTokens` (when present) ≈ `input+output+cacheRead`; it is absent from ~600 events, so
**compute the total yourself rather than summing `totalTokens`**.

Top sessions by tokens: `--D-workspace-myAdmin--\session-3ef15461-...` (v3, 75.4 M),
`f612085c-...` (v3, 26.6 M), `--D-workspace-cusuan-job-system--\session-33da93d6-...` (v3, 12.8 M).

---

## 6. Script used

`D:\workspace\dsh-plugin\_research\scan-sessions.mjs` — full decode + aggregation (run: `node scan-sessions.mjs`).
`D:\workspace\dsh-plugin\_research\analyze-versions.mjs` — per-generation vocabulary + totals.
`D:\workspace\dsh-plugin\_research\proof.mjs` — first-2-lines / grep proof.

Core of the decoder (the part that matters):

```js
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeRaw(buf) {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8') // raw .jsonl
  const starts = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'))
  }
  return parts.join('')   // <-- NOT zstdDecompressSync(wholeFile): that yields only the header line
}

// per file: lines[0] is the header; every later line is
// {type, seq, time, data, surfaceOp?}; only 'assistant/message' has data.usage
```

---

## 7. Recommended backfill strategy

**Primary: `ctx.sessionQuery` (inside the plugin).** Simplest *and* most robust:

```
listSessions()  →  filter to {persisted:true} (∪ live)
for each id:    →  listEvents(id)  →  keep type === 'assistant/message'  →  read data.usage
```

Why: it is generation-agnostic (v0/v3 rows are migrated and decoded for you), it validates replay,
it prefers live over persisted automatically, and it never touches zstd or the 3 filename
generations. For the full event body use `readSession(id)` instead of `listEvents(id)`.

**Fallback: streaming fs JSONL parse** — only when the code must run outside the Host (external
tooling, offline export, or a plugin that must not depend on `sessionQuery`). Then you must
reproduce all four gotchas: (1) iterate concatenated zstd frames, (2) glob `session*.jsonl*`,
(3) skip the header line and non-event packed rows, (4) accept that `data.usage` is optional.
Keep it streaming (per-frame, bounded memory) rather than whole-file: the biggest log is 2.1 MiB
compressed / 9.5 MB decompressed today but grows with no deletion API.

Also note the upsert key: `(sessionId, seq)`. `seq` is contiguous from 0 and events are never
rewritten, so a backfill keyed on `(id, seq)` is idempotent and append-safe.

---

## 8. Explicitly unverified / flagged

1. **`ctx.sessionQuery` behaviour was not executed.** `cordis_inspect_*` is read-only; I confirmed
   the mount, config, exact signatures, and the package README, but did not call
   `listSessions()`/`listEvents()` at runtime. `searchSessions`/`searchEvents` being disabled is
   inferred from the `openAt: never` comment, not observed.
2. **Live bundled README is self-inconsistent:** `dsh-session-persistence-jsonl/README.md:62-69`
   (in the 0.2.0-rc.2 bundle) still documents "released v3/current" while the live constant is
   `SESSION_FORMAT_VERSION = 4` and 17 real v4 files exist. Trust the constant + disk, not that table.
3. **Which package tree the live Host actually loads is not fully proven.** The profile-installed
   `0.1.6-alpha.1` packages (v3) and the asar-bundled `0.2.0-rc.2` (v4) both exist. The
   v4 logs written *today*, including this session, are consistent with the asar bundle only.
4. **`reasoningTokens` semantics unverified** (23 events, v0 only); `cacheWriteTokens` is
   `0`/absent everywhere — do not build UI around either.
5. Token totals are a **snapshot at a moving target** (§5).
6. I could not read the live Host's internal file paths directly (`app.asar` is an archive); live
   sources were extracted read-only to `_research/live-asar/` and cited from there.
