import { createReadStream, readFileSync } from 'node:fs'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

const f = String.raw`C:\Users\52609\.dsh\sessions\--D-workspace-myAdmin--\session-3ef15461-8d27-4259-b654-376b312757c5\session.v3.jsonl.zstd`

// Approach A: async iterate the decompress transform
const chunks = []
for await (const c of createReadStream(f).pipe(createZstdDecompress())) chunks.push(c)
const textA = Buffer.concat(chunks).toString('utf8')
console.log('A lines:', textA.split('\n').filter(Boolean).length, 'chars:', textA.length)

// Approach B: manual frame split on the zstd magic 0x28B52FFD
const buf = readFileSync(f)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let i = buf.indexOf(MAGIC, 0)
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
console.log('B magic occurrences:', starts.length)
let textB = ''
let frames = 0
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    textB += new TextDecoder().decode(zstdDecompressSync(buf.subarray(starts[k], end)))
    frames++
  } catch (e) { console.log('frame', k, 'failed:', String(e).slice(0, 80)) }
}
console.log('B frames decoded:', frames, 'lines:', textB.split('\n').filter(Boolean).length, 'chars:', textB.length)
const lines = textB.split('\n').filter(Boolean)
console.log('L1:', lines[0]?.slice(0, 300))
console.log('L2:', lines[1]?.slice(0, 300))
console.log('L3:', lines[2]?.slice(0, 200))
