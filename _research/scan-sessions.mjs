// Read-only scan of DSH session logs on disk (concatenated-zstd-frame aware).
// Usage: node scan-sessions.mjs [DSH_HOME]
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.argv[2] ?? 'C:\\Users\\52609\\.dsh'
const ROOT = join(HOME, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a session log: N independent zstd frames concatenated (header frame + one per append batch). */
function decodeRaw(buf) {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8') // raw .jsonl
  const starts = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
  const parts = []
  let failed = 0
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')) }
    catch { failed++ }
  }
  return { text: parts.join(''), frames: starts.length, failed }
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.jsonl(\.zstd)?$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
console.log(`LOG FILES: ${files.length}`)
let totalBytes = 0
for (const f of files) totalBytes += statSync(f).size
console.log(`total compressed bytes: ${totalBytes} (${(totalBytes / 1048576).toFixed(1)} MiB)`)

const T = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
let usageEvents = 0, assistantMsgs = 0, totalLines = 0, decodedFrames = 0, failedFrames = 0, decodeErrors = 0
let min = Infinity, max = -Infinity
const perFile = []
const versions = new Map()
const usageShape = new Map()
let seenAssistantDataKeys = null

for (const f of files) {
  let text, frames = 0, failed = 0
  try {
    const r = decodeRaw(readFileSync(f))
    text = typeof r === 'string' ? r : r.text
    frames = typeof r === 'string' ? 0 : r.frames
    failed = typeof r === 'string' ? 0 : r.failed
  } catch (e) { decodeErrors++; perFile.push({ path: f, err: String(e).slice(0, 140) }); continue }
  decodedFrames += frames; failedFrames += failed
  const lines = text.split('\n').filter(Boolean)
  totalLines += lines.length
  let header = null
  try { header = JSON.parse(lines[0]) } catch {}
  if (header) versions.set(header.version, (versions.get(header.version) ?? 0) + 1)
  const created = header?.createdAt
  if (typeof created === 'number') { min = Math.min(min, created); max = Math.max(max, created) }
  const ut = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  let fa = 0, fu = 0
  for (const ln of lines) {
    if (ln.charCodeAt(0) !== 0x7b) continue
    if (!ln.includes('"assistant/message"')) continue
    fa++
    let ev
    try { ev = JSON.parse(ln) } catch { continue }
    if (ev.type !== 'assistant/message') continue
    if (!seenAssistantDataKeys) seenAssistantDataKeys = { event: Object.keys(ev), data: Object.keys(ev.data ?? {}) }
    const u = ev.data?.usage
    if (!u) continue
    fu++
    usageShape.set(Object.keys(u).sort().join(','), (usageShape.get(Object.keys(u).sort().join(',')) ?? 0) + 1)
    for (const k of Object.keys(ut)) ut[k] += u[k] ?? 0
  }
  assistantMsgs += fa; usageEvents += fu
  for (const k of Object.keys(T)) T[k] += ut[k]
  perFile.push({ path: f, size: statSync(f).size, frames, lines: lines.length, version: header?.version, id: header?.id, cwd: header?.cwd, createdAt: created, fa, fu, ut })
}

console.log(`decoded frames: ${decodedFrames} (failed ${failedFrames})  undecodable files: ${decodeErrors}`)
console.log(`total logical lines: ${totalLines}`)
console.log(`header versions: ${JSON.stringify([...versions.entries()])}`)
console.log(`date range (header createdAt): ${new Date(min).toISOString()} .. ${new Date(max).toISOString()}`)
console.log(`assistant/message events: ${assistantMsgs}; with usage: ${usageEvents}`)
console.log(`usage key shapes: ${JSON.stringify([...usageShape.entries()])}`)
console.log('TOKEN TOTALS:', JSON.stringify(T, null, 2))
if (seenAssistantDataKeys) console.log('assistant/message shape:', JSON.stringify(seenAssistantDataKeys))

// --- Real example lines from the largest v4 log ---
const v4 = perFile.filter(p => p.version === 4).sort((a, b) => b.size - a.size)
const pick = (v4[0] ?? perFile.slice().sort((a, b) => b.size - a.size)[0])
console.log('\n=== EXAMPLE LOG ===')
console.log(pick.path, pick.size, 'bytes,', pick.frames, 'frames,', pick.lines, 'lines')
const text = typeof decodeRaw(readFileSync(pick.path)) === 'string' ? decodeRaw(readFileSync(pick.path)) : decodeRaw(readFileSync(pick.path)).text
const lines = text.split('\n').filter(Boolean)
for (let i = 0; i < 2; i++) {
  console.log(`--- line ${i + 1} (len ${lines[i].length}) ---`)
  console.log(lines[i].slice(0, 400))
}
for (const ln of lines) {
  if (!ln.includes('"assistant/message"')) continue
  const ev = JSON.parse(ln)
  if (!ev.data?.usage) continue
  console.log('--- first assistant/message WITH usage (raw, truncated 400) ---')
  console.log(ln.slice(0, 400))
  console.log('... data keys:', JSON.stringify(Object.keys(ev.data)), 'usage:', JSON.stringify(ev.data.usage))
  break
}

// --- Per-session table, top 15 by tokens ---
console.log('\n=== TOP 15 SESSIONS BY TOTAL TOKENS ===')
for (const p of perFile.slice().sort((a, b) => (b.ut?.totalTokens ?? 0) - (a.ut?.totalTokens ?? 0)).slice(0, 15)) {
  console.log(JSON.stringify({
    dir: p.path.replace(HOME + '\\sessions\\', '').replace(/\\session\.[^\\]*$/, ''),
    v: p.version, mb: +(p.size / 1048576).toFixed(2), lines: p.lines, msgs: p.fa, withUsage: p.fu,
    created: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null,
    in: p.ut.inputTokens, out: p.ut.outputTokens, cacheRead: p.ut.cacheReadTokens, total: p.ut.totalTokens,
  }))
}
