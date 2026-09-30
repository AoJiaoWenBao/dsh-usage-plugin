// Research helper: extract selected files from the live Electron app.asar so LIVE
// (0.2.0-rc.2) slot contracts can be cited with real line numbers.
// asar layout: [0..4) u32=4, [4..8) u32=headerPickleSize, [8..12) u32=4,
//              [12..16) u32=jsonLength, [16..16+jsonLength) JSON, data at 8+headerPickleSize.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = process.argv[2] ?? 'D:\\rj\\dsh\\resources\\app.asar'
const OUT = process.argv[3] ?? 'D:\\workspace\\dsh-plugin\\_research\\live-asar'
const patterns = process.argv.slice(4).map(p => new RegExp(p, 'i'))

const buf = readFileSync(ASAR)
const jsonLength = buf.readUInt32LE(12)
const dataOffset = 8 + buf.readUInt32LE(4)
const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'))
console.log('jsonLength:', jsonLength, 'dataOffset:', dataOffset)

const files = []
;(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (v.files) walk(v, p)
    else files.push({ path: p, offset: Number(v.offset), size: v.size })
  }
})(header, '')
console.log('total asar files:', files.length)

const wanted = files.filter(f => patterns.length === 0 || patterns.some(re => re.test(f.path)))
console.log('matched:', wanted.length)
const targets = wanted.filter(f => f.size < 6_000_000)
for (const f of targets) {
  const dest = join(OUT, f.path.replace(/[<>:"|?*]/g, '_'))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf.subarray(dataOffset + f.offset, dataOffset + f.offset + f.size))
  console.log(String(f.size).padStart(9), f.path)
}
console.log('extracted', targets.length, 'to', OUT)
