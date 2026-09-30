/**
 * Diagnostic: render the live panel output with the LIVE payload and print
 * every string the browser half produces, so unit problems are visible without
 * a browser. Run: node _research/dump-panel-text.mjs [days]
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const windows = process.argv[2] === undefined ? [30, 7] : [Number.parseInt(process.argv[2], 10)]
const payloads = new Map()
for (const window of windows) {
  const response = await fetch(`http://127.0.0.1:19387/usage-stats/data?days=${window}`)
  payloads.set(window, await response.json())
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let overrides = []
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat()
    return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat }, children: flat }
  },
  useState(initial) {
    const override = overrides.shift()
    return [override === undefined ? initial : override, () => {}]
  },
  useEffect() {},
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

let loaded
const sandbox = { window: {}, document: undefined, fetch: () => Promise.reject(new Error('no network')) }
sandbox.window.__ModuleLoader__ = { load(entry) { loaded = entry } }
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

const plugin = loaded.factory(() => React)
const registered = []
plugin.apply({
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
})

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (typeof node.type === 'function') { collect(node.type(node.props), out); return out }
  for (const child of node.children ?? []) collect(child, out)
  return out
}

/** Every `title` attribute, which is where the hover text hides. */
function collectTitles(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collectTitles(child, out); return out }
  if (typeof node.props?.title === 'string') out.push(node.props.title)
  if (typeof node.type === 'function') collectTitles(node.type(node.props), out)
  for (const child of node.children ?? []) collectTitles(child, out)
  return out
}

const panel = registered[1].component
for (const [label, window, hookState] of [['默认（近 30 天）', 30, [30, 'day', 'model']], ['近 7 天', 7, [7, 'day', 'model']]]) {
  overrides = [...hookState, { status: 'ready', data: payloads.get(window) }]
  const tree = panel({})
  console.log(`\n===== ${label} =====`)
  console.log('文字:', collect(tree).join(' | '))
  const titles = collectTitles(tree).filter((text) => text !== undefined)
  console.log('悬停:', [...new Set(titles)].slice(0, 3).join(' /// '))
}
