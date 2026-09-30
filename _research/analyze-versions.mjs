// Final analysis: event vocabulary per format generation + usage presence + totals.
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = 'C:\\Users\\52609\\.dsh'
const ROOT = join(HOME, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(buf) {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8')
  const starts = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'))
  }
  return parts.join('')
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.jsonl(\.zstd)?$/.test(e.name)) out.push(p)
  }
  return out
}

const stats = { } // version -> { files, lines, types: Map, usage: n, auom: n, hasStream }
const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const perSession = new Map()
let allLines = 0, allFrames = 0, bad = 0

for (const f of walk(ROOT)) {
  const buf = readFileSync(f)
  const text = decode(buf)
  const lines = text.split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  const key = header.version
  const st = stats[key] ??= { files: 0, lines: 0, types: new Map(), auom: 0, withUsage: 0, withStream: 0, usageKeys: new Map() }
  st.files++
  allLines += lines.length
  const dir = f.slice(0, f.lastIndexOf('\\'))
  for (const ln of lines.slice(1)) {
    if (ln.charCodeAt(0) !== 0x7b) continue
    st.lines++
    let ev
    try { ev = JSON.parse(ln) } catch { bad++; continue }
    st.types.set(ev.type, (st.types.get(ev.type) ?? 0) + 1)
    if (ev.type === 'assistant/message') {
      st.auom++
      if ('stream' in (ev.data ?? {})) st.withStream++
      const u = ev.data?.usage
      if (u) {
        st.withUsage++
        st.usageKeys.set(Object.keys(u).sort().join(','), (st.usageKeys.get(Object.keys(u).sort().join(',')) ?? 0) + 1)
        for (const k of Object.keys(totals)) totals[k] += u[k] ?? 0
        const s = perSession.get(dir) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, msgs: 0 }
        s.inputTokens += u.inputTokens ?? 0; s.outputTokens += u.outputTokens ?? 0
        s.cacheReadTokens += u.cacheReadTokens ?? 0; s.msgs++
        perSession.set(dir, s)
      }
    }
  }
}

console.log(`files: ${[...Object.values(stats)].reduce((a, s) => a + s.files, 0)}  event lines: ${allLines}  unparsable: ${bad}`)
console.log(`sessions with >=1 usage-bearing assistant/message: ${perSession.size}`)
for (const [v, s] of Object.entries(stats).sort((a, b) => a[0] - b[0])) {
  console.log(`\n=== format v${v}: ${s.files} files, ${s.lines} event rows ===`)
  console.log(`  assistant/message: ${s.auom} (with usage ${s.withUsage}, with 'stream' ${s.withStream})`)
  console.log(`  usage key shapes: ${JSON.stringify([...s.usageKeys])}`)
  console.log(`  event types: ${[...s.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(' ')}`)
}
console.log('\nTOKEN TOTALS (sum of usage on assistant/message):', JSON.stringify(totals))
console.log('derived grand total input+output+cacheRead+cacheWrite =',
  totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)
