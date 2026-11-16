import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createDiagnostics } from "./diagnostics.mjs"

const LIMIT = 65536
const files = {
  "/diagnostics.js": ["diagnostics.js", "text/javascript"], "/diagnostics.css": ["diagnostics.css", "text/css"],
  "/config/app.js": ["app.js", "text/javascript"], "/config/style.css": ["style.css", "text/css"],
  "/config/config-transfer.js": ["config-transfer.js", "text/javascript"],
  "/config/_magpie/bridge.js": ["service-bridge.js", "text/javascript"],
}
const tokenMatches = (a, b) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function startDiagnosticService(config) {
  const listenPort = Number(config.port ?? 37747)
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error("Invalid diagnostics port")
  const diagnostics = createDiagnostics(config), token = randomBytes(32).toString("hex")
  let active = 0
  const server = createServer(async (req, res) => {
    const port = server.address()?.port
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)) }
    const origin = req.headers.origin
    res.setHeader("cache-control", "no-store")
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host) || (origin !== undefined && origin !== "null")) { send(403, { error: "Only the local plugin page can use this service." }); return }
    let path
    try { path = new URL(req.url, `http://127.0.0.1:${port}`).pathname }
    catch { send(400, { error: "Invalid diagnostics address." }); return }
    const api = path.startsWith("/api/")
    // HTML deliberately has no CORS header: another opaque-origin frame
    // cannot fetch the page to obtain its random API token.
    if (api && origin === "null") res.setHeader("access-control-allow-origin", "null")
    if (api && req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, x-kunbot-diagnostics" }); res.end(); return
    }
    if (api && !tokenMatches(req.headers["x-kunbot-diagnostics"], token)) { send(401, { error: "测试页面已过期，请从插件配置页重新打开。" }); return }
    try {
      if (req.method === "GET" && ["/", "/config/", "/config/index.html"].includes(path)) {
        const file = path === "/" ? "diagnostics.html" : "index.html"
        const html = (await readFile(new URL(`../page/${file}`, import.meta.url), "utf8")).replace("__KUNBOT_DIAGNOSTIC_TOKEN__", token)
        const own = `http://127.0.0.1:${port}`
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'self' ${own}; style-src 'self' ${own}; connect-src 'self' ${own}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:* https://127.0.0.1:* http://localhost:* https://localhost:* wails://localhost http://wails.localhost` })
        res.end(html); return
      }
      if (req.method === "GET" && files[path]) {
        const [name, type] = files[path]
        const body = await readFile(new URL(`../page/${name}`, import.meta.url))
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(body); return
      }
      if (req.method === "GET" && path === "/api/accounts") { send(200, { accounts: await diagnostics.accounts() }); return }
      if (req.method === "GET" && path === "/api/models") {
        send(200, { models: await diagnostics.models(new URL(req.url, "http://local").searchParams.get("account")) }); return
      }
      if (req.method === "POST" && path === "/api/test") {
        if (active >= 2) { send(429, { error: "已有测试正在运行，请等待或取消后重试。" }); return }
        if (!String(req.headers["content-type"]).startsWith("application/json")) { send(415, { error: "请发送 JSON 请求。" }); return }
        if (Number(req.headers["content-length"]) > LIMIT) { send(413, { error: "请求体不能超过 64 KiB。" }); return }
        active++
        const controller = new AbortController()
        const closed = () => { if (!res.writableEnded) controller.abort() }
        res.on("close", closed)
        try {
          const chunks = []; let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > LIMIT) throw new Error("请求体不能超过 64 KiB。")
            chunks.push(chunk)
          }
          let input
          try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new Error("请求体不是有效 JSON。") }
          const report = await diagnostics.run(input, controller.signal)
          if (!res.destroyed) send(200, report)
        } finally { active--; res.off("close", closed) }
        return
      }
      send(404, { error: "No such diagnostics endpoint." })
    } catch (e) { if (!res.destroyed) send(400, await diagnostics.error(e)) }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(listenPort, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  server.unref()
  return server
}
