/**
 * Minimal asar reader (no dependencies): parse the header and dump one entry.
 * Usage: node _research/asar-read.mjs <archive> <substring-of-path> [count]
 */
import { readFileSync } from 'node:fs'

const [archive, needle, countRaw] = process.argv.slice(2)
const limit = Number.parseInt(countRaw ?? '200000', 10)
const buf = readFileSync(archive)
const headerSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const baseOffset = 8 + headerSize

const matches = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (value.files !== undefined) walk(value, path)
    else matches.push({ path, offset: Number.parseInt(value.offset, 10), size: value.size })
  }
}
walk(header, '')
const hit = matches.filter((entry) => entry.path.includes(needle))
console.log(`archive entries: ${matches.length}; matching "${needle}": ${hit.length}`)
for (const entry of hit.slice(0, 12)) {
  console.log(`--- ${entry.path} (${entry.size} bytes) ---`)
  console.log(buf.subarray(baseOffset + entry.offset, baseOffset + entry.offset + Math.min(entry.size, limit)).toString('utf8'))
}
