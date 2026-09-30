/**
 * Generate `docs/panel.svg`: a static mock of the usage dashboard layout
 * (figures row, contribution heat map, range switch, trend chart). Run:
 * `node _research/make-panel-svg.mjs`.
 */
import { writeFileSync } from 'node:fs'

const W = 800
const H = 560
const out = []
const push = (line) => out.push(line)

const MUTED = '#8a8f98'
const STRONG = '#f2f3f5'
const CARD = 'fill="#212429" stroke="#33373d"'
const KINDS = [
  { label: '输入', color: '#4c8dff' },
  { label: '输出', color: '#1f9d63' },
  { label: '缓存命中', color: '#8b5cf6' },
  { label: '缓存写入', color: '#d98b1f' },
  { label: '思维链', color: '#94a3b8' },
]
const MODELS = [
  { label: 'deepseek-flash', color: '#4c8dff' },
  { label: 'deepseek-v4.1-flash', color: '#1f9d63' },
  { label: 'deepseek-v4-flash-0731', color: '#8b5cf6' },
  { label: 'agnes-3.0-flash', color: '#d98b1f' },
]

/** Deterministic pseudo-random in [0,1) so the mock is stable between runs. */
function rnd(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI','Microsoft YaHei',sans-serif">`)
push(`<rect width="${W}" height="${H}" fill="#1b1d21"/>`)
push('<rect x="0" y="0" width="52" height="' + H + '" fill="#15171a"/>')
push('<rect x="18" y="40" width="16" height="16" rx="3" fill="#4a4d52"/>')
push('<rect x="18" y="76" width="16" height="16" rx="3" fill="#4a4d52"/>')
push('<rect x="16" y="108" width="20" height="24" rx="5" fill="none" stroke="#4c8dff" stroke-width="1.2"/>')
push('<g fill="#4c8dff"><rect x="20" y="120" width="3" height="8" rx="1" opacity="0.55"/><rect x="24.5" y="116" width="3" height="12" rx="1" opacity="0.8"/><rect x="29" y="112" width="3" height="16" rx="1"/></g>')

// header
push(`<text x="76" y="40" fill="${STRONG}" font-size="15.5" font-weight="600">Token 用量</text>`)
push(`<rect x="712" y="24" width="56" height="22" rx="11" fill="none" stroke="#4a4d52"/><text x="740" y="39" fill="${MUTED}" font-size="12" text-anchor="middle">刷新</text>`)
push(`<text x="76" y="62" fill="${MUTED}" font-size="11.5">2026-09-01 ~ 2026-09-30 · 时区 Asia/Shanghai</text>`)

// figures row
const stats = [
  { value: '2.66亿', label: '累积 Token 数' },
  { value: '1.04亿', label: '峰值 Token 数' },
  { value: '10 天 23 小时', label: '最长聊天时长' },
  { value: '3 天', label: '当前连续天数' },
  { value: '5 天', label: '最长连续天数' },
]
push(`<rect x="76" y="76" width="700" height="76" rx="12" ${CARD}/>`)
stats.forEach((stat, index) => {
  const x = 76 + 12 + index * 138
  if (index > 0) push(`<line x1="${x - 10}" y1="90" x2="${x - 10}" y2="138" stroke="#33373d"/>`)
  push(`<text x="${x}" y="114" fill="${STRONG}" font-size="17" font-weight="600">${stat.value}</text>`)
  push(`<text x="${x}" y="134" fill="${MUTED}" font-size="11.5">${stat.label}</text>`)
})

// type strip
push(`<text x="78" y="174" font-size="11.5" fill="${MUTED}"><tspan fill="${STRONG}" font-weight="600">合计 2.37亿</tspan>　输入 388.2万　输出 143.9万　缓存命中 2.32亿　缓存写入 0　思维链 0　调用 1,437 次</text>`)

// heat map card
push(`<rect x="76" y="190" width="700" height="176" rx="12" ${CARD}/>`)
push(`<text x="94" y="216" fill="${STRONG}" font-size="13.5" font-weight="600">Token 活动</text>`)
;['每日', '每周', '累计'].forEach((label, index) => {
  const x = 604 + index * 56
  push(`<rect x="${x}" y="202" width="50" height="20" rx="10" fill="${index === 0 ? '#4c8dff' : 'none'}" stroke="${index === 0 ? 'none' : '#4a4d52'}"/>`)
  push(`<text x="${x + 25}" y="216" fill="${index === 0 ? '#fff' : MUTED}" font-size="11.5" text-anchor="middle">${label}</text>`)
})
const cell = 9
const gap = 3
const columns = 26
const heat = ['rgba(127,127,127,0.14)', 'rgba(76,141,255,0.25)', 'rgba(76,141,255,0.45)', 'rgba(76,141,255,0.72)', '#4c8dff']
const gridX = 94
const gridY = 236
;['11月', '12月', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月'].forEach((label, index) => {
  push(`<text x="${gridX + index * 2.4 * (cell + gap)}" y="${gridY - 6}" fill="${MUTED}" font-size="10.5">${label}</text>`)
})
for (let column = 0; column < columns; column += 1) {
  for (let row = 0; row < 7; row += 1) {
    const seed = column * 7 + row
    const activity = column > 18 ? rnd(seed) : rnd(seed) * 0.55
    const level = activity < 0.25 ? 0 : activity < 0.45 ? 1 : activity < 0.62 ? 2 : activity < 0.8 ? 3 : 4
    push(`<rect x="${gridX + column * (cell + gap)}" y="${gridY + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" fill="${heat[level]}"/>`)
  }
}
heat.forEach((color, index) => {
  push(`<rect x="${576 + index * 14}" y="338" width="10" height="10" rx="3" fill="${color}"/>`)
})
push(`<text x="560" y="347" fill="${MUTED}" font-size="10.5" text-anchor="end">少</text>`)
push(`<text x="658" y="347" fill="${MUTED}" font-size="10.5">多</text>`)

// range row
push(`<text x="80" y="392" fill="${MUTED}" font-size="12.5" font-weight="600">时间范围</text>`)
;['近 7 天', '近 30 天'].forEach((label, index) => {
  const x = 634 + index * 60
  push(`<rect x="${x}" y="378" width="54" height="20" rx="10" fill="${index === 1 ? '#4c8dff' : 'none'}" stroke="${index === 1 ? 'none' : '#4a4d52'}"/>`)
  push(`<text x="${x + 27}" y="392" fill="${index === 1 ? '#fff' : MUTED}" font-size="11.5" text-anchor="middle">${label}</text>`)
})

// trend card
push(`<rect x="76" y="410" width="700" height="140" rx="12" ${CARD}/>`)
push(`<text x="94" y="434" fill="${STRONG}" font-size="13.5" font-weight="600">每日 Token 趋势图</text>`)
;['按模型', '按类型'].forEach((label, index) => {
  const x = 604 + index * 56
  push(`<rect x="${x}" y="420" width="50" height="20" rx="10" fill="${index === 0 ? '#4c8dff' : 'none'}" stroke="${index === 0 ? 'none' : '#4a4d52'}"/>`)
  push(`<text x="${x + 25}" y="434" fill="${index === 0 ? '#fff' : MUTED}" font-size="11.5" text-anchor="middle">${label}</text>`)
})
MODELS.forEach((model, index) => {
  const x = 94 + index * 158
  push(`<rect x="${x}" y="452" width="9" height="9" rx="3" fill="${model.color}"/>`)
  push(`<text x="${x + 14}" y="461" fill="${MUTED}" font-size="11">${model.label}</text>`)
})
for (let line = 0; line < 4; line += 1) {
  const y = 480 + line * 16
  push(`<line x1="94" y1="${y}" x2="758" y2="${y}" stroke="#2b2f35" stroke-dasharray="3 4"/>`)
}
const plotX = 136
const plotW = 622
const plotTop = 484
const plotHeight = 44
// Four model routes, shaped like the live 30-day window.
const series = [
  { color: '#4c8dff', shape: [0.03, 0.05, 0.02, 0.08, 0.12, 0.06, 0.18, 0.25, 0.4, 0.55, 0.62, 0.86, 1] },
  { color: '#1f9d63', shape: [0, 0, 0, 0, 0, 0, 0, 0, 0.02, 0.05, 0.09, 0.13, 0.1] },
  { color: '#8b5cf6', shape: [0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.03, 0.06, 0.09, 0.06] },
  { color: '#d98b1f', shape: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.005, 0.01, 0.02, 0.015] },
]
for (const entry of series) {
  const points = entry.shape.map((value, index) => {
    const x = plotX + (index / (entry.shape.length - 1)) * plotW
    const y = plotTop + plotHeight - value * plotHeight
    return [x, y]
  })
  let path = `M${points[0][0]},${points[0][1]}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index]
    const current = points[index]
    const next = points[index + 1]
    const after = points[index + 2] ?? next
    path += ` C${current[0] + (next[0] - previous[0]) / 6},${current[1] + (next[1] - previous[1]) / 6}`
      + ` ${next[0] - (after[0] - current[0]) / 6},${next[1] - (after[1] - current[1]) / 6} ${next[0]},${next[1]}`
  }
  push(`<path d="${path}" fill="none" stroke="${entry.color}" stroke-width="2" stroke-linecap="round"/>`)
}
// Hover guide + tooltip, mirroring the live interaction on one day.
const hoverIndex = 10
const hoverX = plotX + (hoverIndex / 12) * plotW
push(`<line x1="${hoverX}" y1="${plotTop}" x2="${hoverX}" y2="${plotTop + plotHeight}" stroke="#4c8dff" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`)
for (const entry of series) {
  push(`<circle cx="${hoverX}" cy="${plotTop + plotHeight - entry.shape[hoverIndex] * plotHeight}" r="3.6" fill="${entry.color}" stroke="#212429" stroke-width="1.5"/>`)
}
const boxX = hoverX - 78
const boxY = plotTop - 14
push(`<rect x="${boxX}" y="${boxY}" width="156" height="54" rx="8" fill="#24272c" stroke="#4a4d52"/>`)
push(`<text x="${boxX + 10}" y="${boxY + 17}" fill="${STRONG}" font-size="10.5" font-weight="600">2026年9月28日</text>`)
push(`<circle cx="${boxX + 14}" cy="${boxY + 30}" r="4" fill="#4c8dff"/><text x="${boxX + 24}" y="${boxY + 33}" fill="${MUTED}" font-size="10">deepseek-flash</text><text x="${boxX + 146}" y="${boxY + 33}" fill="${STRONG}" font-size="10" text-anchor="end" font-weight="600">4471万</text>`)
push(`<line x1="${boxX + 10}" y1="${boxY + 40}" x2="${boxX + 146}" y2="${boxY + 40}" stroke="#3a3e44"/>`)
push(`<text x="${boxX + 10}" y="${boxY + 50}" fill="${MUTED}" font-size="10">合计 4471万 · 99 次调用</text>`)

// Y axis shares one unit across every tick.
;['1.04亿', '0.78亿', '0.52亿', '0.26亿', '0'].forEach((label, index) => {
  push(`<text x="${plotX - 8}" y="${plotTop + index * 11 + 3.5}" fill="${MUTED}" font-size="10.5" text-anchor="end">${label}</text>`)
})
;['9月1日', '9月6日', '9月11日', '9月16日', '9月21日', '9月26日', '9月30日'].forEach((label, index) => {
  const x = plotX + (index / 6) * plotW
  push(`<text x="${x}" y="544" fill="${MUTED}" font-size="10.5" text-anchor="${index === 0 ? 'start' : index === 6 ? 'end' : 'middle'}">${label}</text>`)
})
push('</svg>')

writeFileSync(new URL('../docs/panel.svg', import.meta.url), `${out.join('\n')}\n`, 'utf8')
console.log(`docs/panel.svg written (${out.length} elements)`)
void KINDS
