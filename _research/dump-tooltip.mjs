import { readFileSync } from "node:fs"
import vm from "node:vm"
const payload = await (await fetch("http://127.0.0.1:19387/usage-stats/data?days=30")).json()
const source = readFileSync("lib/client.js", "utf8")
let overrides = []
const React = {
  createElement(t, p, ...c) { const f = c.flat(); return { type: t, props: { ...(p ?? {}), children: f.length <= 1 ? f[0] : f }, children: f } },
  useState(i) { const o = overrides.shift(); return [o === undefined ? i : o, () => {}] },
  useEffect() {}, useRef(v) { return { current: v } }, useCallback(f) { return f }, useMemo(f) { return f() },
}
let loaded
const sb = { window: {}, document: undefined, fetch: () => Promise.reject(new Error("x")) }
sb.window.__ModuleLoader__ = { load(e) { loaded = e } }
sb.globalThis = sb
vm.runInNewContext(source, sb)
const plugin = loaded.factory(() => React)
const reg = []
plugin.apply({ slots: { inject: (k, cb) => cb(), register: (o, c) => { reg.push({ o, c }); return () => {} } } })
function walk(n, out = []) {
  if (n === null || n === undefined || typeof n === "boolean") return out
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out }
  if (Array.isArray(n)) { for (const c of n) walk(c, out); return out }
  if (typeof n.type === "function") { walk(n.type(n.props), out); return out }
  for (const c of n.children ?? []) walk(c, out)
  return out
}
for (const day of [29, 25]) {
  overrides = [30, "day", "model", { status: "ready", data: payload }, day]
  const text = walk(reg[1].c({})).join(" | ")
  const tail = text.slice(text.indexOf("每日 Token 趋势图"))
  console.log(`\n--- 悬停第 ${day} 天 ---\n${tail.slice(tail.indexOf("2026年")).split(" | ").slice(0, 12).join(" | ")}`)
}
