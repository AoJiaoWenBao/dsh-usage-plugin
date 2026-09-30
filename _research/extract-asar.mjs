// Extract selected files from the live Electron app.asar so the LIVE (v4) implementation
// can be cited with real line numbers.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = 'D:\\rj\\dsh\\resources\\app.asar'
const OUT = 'D:\\workspace\\dsh-plugin\\_research\\live-asar'
const buf = readFileSync(ASAR)

// asar = [pickle payloadSize u32][jsonLen u32][jsonLen u32][json bytes...][file data...]
const jsonLength = buf.readUInt32LE(12)
const jsonText = buf.subarray(16, 16 + jsonLength).toString('utf8')
const header = JSON.parse(jsonText)
const dataOffset = 8 + buf.readUInt32LE(4)
console.log('jsonLength:', jsonLength, 'dataOffset:', dataOffset, 'first key:', Object.keys(header))

const files = []
;(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (v.files) walk(v, p)
    else files.push({ path: p, offset: Number(v.offset), size: v.size })
  }
})(header, '')
console.log('total asar files:', files.length)

const wanted = files.filter(f => /session-persistence-jsonl|dsh-session-format|dsh-session\/lib|session-query/.test(f.path))
console.log('\n--- matching files ---')
for (const f of wanted) console.log(String(f.size).padStart(9), f.path)

const targets = wanted.filter(f => /\.js$|\.d\.ts$|README\.md$|package\.json$/.test(f.path) && f.size < 4_000_000)
const seen = new Set()
for (const f of targets) {
  const dest = join(OUT, f.path.replace(/[<>:"|?*]/g, '_'))
  if (seen.has(dest)) continue
  seen.add(dest)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf.subarray(dataOffset + f.offset, dataOffset + f.offset + f.size))
}
console.log('\nextracted', seen.size, 'files to', OUT)
