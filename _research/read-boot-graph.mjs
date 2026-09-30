const res = await fetch("http://127.0.0.1:19387/plugins/events", { headers: { accept: "text/event-stream" } })
console.log("status", res.status, res.headers.get("content-type"))
const reader = res.body.getReader()
const decoder = new TextDecoder()
let text = ""
const deadline = Date.now() + 8000
while (Date.now() < deadline) {
  const race = await Promise.race([
    reader.read(),
    new Promise((r) => setTimeout(() => r("timeout"), 1500)),
  ])
  if (race === "timeout") continue
  if (race.done) break
  text += decoder.decode(race.value, { stream: true })
}
await reader.cancel().catch(() => {})
console.log("bytes", text.length)
const lines = text.split("\n").filter((l) => l.startsWith("data:"))
console.log("frames", lines.length)
for (const line of lines) {
  let payload
  try { payload = JSON.parse(line.slice(5)) } catch { continue }
  console.log("frame:", payload.type ?? Object.keys(payload).join(","))
  const graph = payload.graph ?? (payload.type === "graph" ? payload.graph : undefined)
  if (graph) {
    console.log("  rev:", graph.rev, "entries:", graph.entries.length)
    for (const e of graph.entries) if (String(e.id).includes("usage-stats")) console.log("  MATCH:", JSON.stringify(e))
  }
}
