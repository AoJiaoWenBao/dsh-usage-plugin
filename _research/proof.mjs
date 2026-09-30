// Proof for the report: largest v4 log, first 2 lines, assistant/message + usage grep counts.
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const ROOT = 'C:\\Users\\52609\\.dsh\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decode(buf) {
  const starts = []; let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
  return starts.map((s, k) => zstdDecompressSync(buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length)).toString('utf8')).join('')
}
function walk(d, out = []) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p, out) : /\.jsonl(\.zstd)?$/.test(e.name) && out.push(p) } return out }
const v4 = walk(ROOT).filter(f => f.includes('session.v4.jsonl')).map(f => ({ f, size: statSync(f).size })).sort((a, b) => b.size - a.size)
console.log('v4 logs:', v4.length, 'largest:', v4[0].f, v4[0].size, 'bytes')
const text = decode(readFileSync(v4[0].f))
const lines = text.split('\n').filter(Boolean)
console.log('\n== FIRST 2 LINES (each truncated to 400 chars) ==')
for (let i = 0; i < 2; i++) console.log(`L${i + 1} (${lines[i].length} chars): ${lines[i].slice(0, 400)}`)
console.log('\n== GREP over that decoded log ==')
console.log('lines containing "assistant/message":', lines.filter(l => l.includes('"assistant/message"')).length)
console.log('lines containing "usage":', lines.filter(l => l.includes('usage')).length)
console.log('line 2 verbatim (whole line, 93 chars):', lines[1])
const hit = lines.find(l => l.includes('"assistant/message"') && l.includes('usage'))
console.log('\n== ONE REAL assistant/message LINE WITH usage (first 400 chars) ==')
console.log(hit.slice(0, 400))
console.log('\n== that record parsed ==')
const ev = JSON.parse(hit)
console.log('top-level keys:', Object.keys(ev))
console.log('type:', ev.type, '| seq:', ev.seq, '| time:', ev.time, '->', new Date(ev.time).toISOString())
console.log('data keys:', Object.keys(ev.data))
console.log('data.usage:', JSON.stringify(ev.data.usage))
console.log('data.stream is array of', ev.data.stream.length, 'records, first:', JSON.stringify(ev.data.stream[0]).slice(0, 200))
console.log('typeof time:', typeof ev.time, '| typeof seq:', typeof ev.seq)
console.log('\n== header line keys ==', Object.keys(JSON.parse(lines[0])))
