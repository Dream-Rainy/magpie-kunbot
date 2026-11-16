import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"
import { createDiagnostics, diagnosticTemplate, redact } from "../lib/diagnostics.mjs"
import { startDiagnosticService } from "../lib/diagnostic-service.mjs"
import { createRoutes } from "../lib/routing.mjs"
import { _internal } from "../index.mjs"

const secret = "fixture-diagnostics-personal-key"
const fixtureAuth = {
  kunbot: { type: "api", key: secret, metadata: { email: "personal" } },
  "kunbot#2": { type: "api", key: "fixture-work-key", metadata: { email: "work", endpointBaseURLs: "main=https://work.example/v1" } },
  other: { type: "api", key: "unrelated-provider-key" },
}
const options = {
  includeCatalog: false, routes: { main: { base: "https://main.example" }, backup: { base: "https://backup.example/v1" } },
  models: { image: { type: "image", id: "MiniMax-H3-Image", suffix: "7sref", targets: [{ endpoint: "main" }, { endpoint: "backup", id: "backup-image-id" }] } },
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kunbot-diagnostic-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const save = data => writeFile(join(directory, "plugin-auth.json"), JSON.stringify(data))
  await save(fixtureAuth)
  const routes = createRoutes(options, _internal.configuredModels)
  const config = { directory, client: "diagnostics-test", modelTable: auth => routes.build({}, auth), ...extra }
  return { config, save, diagnostics: createDiagnostics(config) }
}
const input = overrides => ({ account: "kunbot", model: "image", operation: "/images/generations", body: { prompt: "test", model: "cannot-override-selected-id", n: 1 }, ...overrides })

test("diagnostics list only this provider's API accounts without credentials and choose protocol-specific bodies", async t => {
  const { diagnostics } = await fixture(t)
  assert.deepEqual(await diagnostics.accounts(), [{ id: "kunbot", name: "personal" }, { id: "kunbot#2", name: "work" }])
  const models = await diagnostics.models("kunbot")
  assert.equal(models[0].body.model, "MiniMax-H3-Image")
  assert.equal(models[0].operation, "/images/generations")
  assert.equal(diagnosticTemplate({ id: "m", provider: { npm: "@ai-sdk/anthropic" } }).operation, "/messages")
  assert.equal(diagnosticTemplate({ id: "m", provider: { npm: "@ai-sdk/openai" } }).operation, "/responses")
  assert.equal(diagnosticTemplate({ id: "m" }).operation, "/chat/completions")
  await assert.rejects(diagnostics.models("other"), /未登录/)
})

test("preview uses the final per-account addresses and upstream ids without any model fetch", async t => {
  t.mock.method(globalThis, "fetch", () => { throw Error("preview must not fetch") })
  const { diagnostics } = await fixture(t)
  const result = await diagnostics.run(input({ preview: true, account: "kunbot#2" }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.attempts.map(a => a.request.url), ["https://work.example/7sref/v1/images/generations", "https://backup.example/7sref/v1/images/generations"])
  assert.deepEqual(result.attempts.map(a => a.request.body.model), ["MiniMax-H3-Image", "backup-image-id"])
  assert.ok(result.attempts.every(a => a.request.body.prompt === "test" && a.request.headers.authorization === "[REDACTED]" && !a.response))
  assert.ok(!JSON.stringify(result).includes("fixture-work-key"))
})

test("diagnostics record retryable primary failures and backup success with the same requests actually sent", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), key: init.headers.get("authorization") })
    return Response.json(sent.length === 1 ? { error: { message: `denied ${secret}`, api_key: "echoed-credential" } } : { data: [{ b64_json: "a".repeat(1000) }] }, { status: sent.length === 1 ? 503 : 200, headers: { "set-cookie": "session=secret" } })
  })
  const { diagnostics } = await fixture(t)
  const result = await diagnostics.run(input())
  assert.equal(result.ok, true); assert.equal(result.status, 200)
  assert.equal(result.attempts[0].response.status, 503)
  assert.equal(result.attempts[1].response.status, 200)
  assert.deepEqual(result.attempts.map(a => a.request.url), sent.map(s => s.url))
  assert.deepEqual(result.attempts.map(a => a.request.body), sent.map(s => s.body))
  assert.ok(sent.every(s => s.key === `Bearer ${secret}`))
  assert.match(result.attempts[1].response.body.data[0].b64_json, /omitted/)
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes("echoed-credential"))
  assert.equal(result.attempts[0].response.headers["set-cookie"], "[REDACTED]")
})

test("network errors containing keys are redacted and input/auth failures do not try backup", async t => {
  let calls = 0, network = true
  t.mock.method(globalThis, "fetch", async () => { calls++; if (network) throw Error(`network: ${secret}`); return Response.json({ error: "bad key" }, { status: 401 }) })
  const { diagnostics } = await fixture(t)
  const failed = await diagnostics.run(input())
  assert.equal(failed.attempts.length, 2); assert.equal(failed.ok, false)
  assert.ok(!JSON.stringify(failed).includes(secret))
  calls = 0; network = false
  const refused = await diagnostics.run(input())
  assert.equal(calls, 1); assert.equal(refused.status, 401)
})

test("timeouts and cancellation abort inference and do not switch candidates", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", (_, init) => new Promise((_, reject) => {
    calls++; init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const { diagnostics } = await fixture(t)
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const timed = await diagnostics.run(input({ timeoutMs: 100 }))
    assert.equal(calls, 1); assert.match(timed.error, /超时/)
    calls = 0
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30)
    const cancelled = await diagnostics.run(input(), controller.signal)
    clearTimeout(timer); assert.equal(calls, 1); assert.match(cancelled.error, /取消/)
  } finally { clearTimeout(keepAlive) }
})

test("credentials are re-read before sending and account logout cannot use a stale key", async t => {
  let save
  const f = await fixture(t, { modelTable: async () => { await save({}); return createRoutes(options, _internal.configuredModels).build() } })
  save = f.save
  t.mock.method(globalThis, "fetch", () => { throw Error("stale account must not fetch") })
  const result = await f.diagnostics.run(input())
  assert.equal(result.ok, false); assert.match(result.error, /退出/); assert.deepEqual(result.attempts, [])
  assert.deepEqual(await f.diagnostics.accounts(), [])
})

test("response capture is bounded and binary data is summarized", async t => {
  let binary = false
  t.mock.method(globalThis, "fetch", async () => new Response(binary ? new Uint8Array(1000) : "x".repeat(100000), { headers: { "content-type": binary ? "image/png" : "text/plain" } }))
  const { diagnostics } = await fixture(t)
  const text = await diagnostics.run(input())
  assert.equal(text.attempts[0].response.body.length, 65536); assert.equal(text.attempts[0].response.truncated, true)
  binary = true
  const image = await diagnostics.run(input())
  assert.match(image.attempts[0].response.body, /binary image\/png; 1000 bytes/)
  assert.deepEqual(redact({ apiKey: "hidden", value: `Authorization: Bearer ${secret}`, data: [{ b64_json: "raw" }] }, [secret]).apiKey, "[REDACTED]")
})

test("a successful stream that breaks reports its partial body and never switches to backup", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: partial\n\n")) },
      pull(controller) { controller.error(new Error("stream broke")) },
    }), { headers: { "content-type": "text/event-stream" } })
  })
  const { diagnostics } = await fixture(t)
  const report = await diagnostics.run(input())
  assert.equal(calls, 1); assert.equal(report.ok, false); assert.equal(report.status, 200)
  assert.equal(report.attempts[0].response.body, "data: partial\n\n")
  assert.match(report.attempts[0].response.readError, /stream broke/)
})

test("redaction covers echoed headers, nested fields and backend error messages", async t => {
  const { diagnostics } = await fixture(t)
  assert.ok(!JSON.stringify(await diagnostics.error(Error(`failed with ${secret}`))).includes(secret))
  const urlCredential = "example-not-a-real-key"
  const clean = redact({ password: "private-value", apiKey: "private-key", details: "Authorization: Bearer unknown-value\nSet-Cookie: private-cookie\ntoken=private-token", url: `https://user:${urlCredential}@example.test/v1` })
  for (const value of ["private-value", "private-key", "unknown-value", "private-cookie", "private-token", urlCredential]) assert.ok(!JSON.stringify(clean).includes(value))
})

test("local diagnostics service protects the HTML token and rejects untrusted origins, hosts and request targets", async t => {
  const { config } = await fixture(t)
  const server = await startDiagnosticService({ ...config, port: "0" })
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const html = await fetch(base)
  assert.equal(html.headers.get("access-control-allow-origin"), null)
  const token = /name="kunbot-diagnostics-token" content="([a-f0-9]+)"/.exec(await html.text())[1]
  assert.equal((await fetch(base + "/api/accounts")).status, 401)
  assert.equal((await fetch(base + "/api/accounts", { headers: { "x-kunbot-diagnostics": token, origin: "https://untrusted.example" } })).status, 403)
  const badHost = await new Promise((resolve, reject) => {
    request(base + "/api/accounts", { headers: { host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode) }).on("error", reject).end()
  })
  assert.equal(badHost, 403)
  const headers = { "x-kunbot-diagnostics": token, origin: "null", "content-type": "application/json" }
  const accounts = await fetch(base + "/api/accounts", { headers })
  assert.equal(accounts.headers.get("access-control-allow-origin"), "null")
  assert.ok(!JSON.stringify(await accounts.json()).includes(secret))
  const preview = await fetch(base + "/api/test", { method: "POST", headers, body: JSON.stringify(input({ preview: true })) })
  assert.equal((await preview.json()).attempts.length, 2)
  const badPath = await fetch(base + "/api/test", { method: "POST", headers, body: JSON.stringify(input({ operation: "/any-url" })) })
  assert.equal(badPath.status, 400)
  const large = await fetch(base + "/api/test", { method: "POST", headers, body: JSON.stringify({ body: "x".repeat(70000) }) })
  assert.equal(large.status, 413)
})

test("the service provides a complete config page without loading Wails resources", async t => {
  const { config } = await fixture(t)
  const server = await startDiagnosticService({ ...config, port: 0 })
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(base + "/config/index.html")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("access-control-allow-origin"), null)
  const html = await response.text()
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:css|js))"/g)].map(m => m[1])
  assert.deepEqual(assets.sort(), ["_magpie/bridge.js", "app.js", "config-transfer.js", "style.css"])
  for (const asset of assets) assert.equal((await fetch(new URL(asset, base + "/config/index.html"))).status, 200)
  assert.equal((await fetch(base + "/config/")).status, 200)
  const bridge = await (await fetch(base + "/config/_magpie/bridge.js")).text()
  assert.ok(bridge.includes('event.source !== parent'))
  assert.ok(!bridge.includes("wails.localhost")); assert.ok(!bridge.includes("wails://"))
})
