import test, { it } from "node:test"
import assert from "node:assert/strict"
import { KunbotAntPlugin, _internal } from "../index.mjs"
import { createRoutes, endpointOverrides, forwardRequest, routeRequest, _routing } from "../lib/routing.mjs"

const auth = (key = "test-key-A", metadata = {}) => ({ type: "api", key, metadata })
const json = (body, status = 200) => Response.json(body, { status })
const endpoints = {
  main: { base: "https://main.example/omni/v1", discover: true },
  backup: { base: "https://backup.example/salt/v1", discover: true },
}
const manager = options => createRoutes(options, _internal.configuredModels)
const list = ids => json({ data: ids.map(id => ({ id })) })
const request = (model, body = {}) => new Request(`${model.api.url}/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", "x-custom": "keep" }, body: JSON.stringify({ model: model.api.id, messages: [], ...body }),
})
async function plugin(options) {
  const p = await KunbotAntPlugin({}, options)
  return { p, models: await p.provider.models({ models: {} }, { auth: auth() }), loader: await p.auth.loader(async () => auth()) }
}

it('should use each model protocol when one endpoint serves conversations and decisions', async t => {
  // Arrange
  const sent = []
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) }); return json({ ok: true }) })
  const { models, loader } = await plugin({ includeCatalog: false, routes: { shared: { base: "https://shared.example/v1", protocol: "chat" } },
    models: { chat: { id: "chat", endpoint: "shared", protocol: "chat" }, responses: { id: "response", endpoint: "shared", protocol: "responses" }, anthropic: { id: "message", endpoint: "shared", protocol: "anthropic" }, gemini: { id: "native", endpoint: "shared", protocol: "gemini", suffix: "v1beta" }, systemone: { id: "classify", endpoint: "shared", protocol: "systemone" } },
  })
  const requests = [["chat", "/chat/completions"], ["responses", "/responses"], ["anthropic", "/messages"], ["gemini", "/models/native:generateContent"], ["systemone", "/systemone"]]
  // Act
  for (const [key, path] of requests) await loader.fetch(models[key].api.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(key === "gemini" ? { contents: [] } : { model: "display" }) })
  // Assert
  assert.deepEqual(Object.values(models).map(model => model.api.npm), ["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/google", "@ai-sdk/openai-compatible"])
  assert.equal(models.systemone.decides, true)
  assert.equal(models.chat.decides, false)
  assert.deepEqual(sent.map(request => request.url), ["https://shared.example/v1/chat/completions", "https://shared.example/v1/responses", "https://shared.example/v1/messages", "https://shared.example/v1beta/models/native:generateContent", "https://shared.example/v1/systemone"])
  assert.deepEqual(sent[3].body, { contents: [] })
  assert.equal(sent[3].headers.get("x-goog-api-key"), "test-key-A")
})

it('should discover native Gemini metadata when Google returns paginated model lists', async t => {
  // Arrange
  const requests = []
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) })
    return json(new URL(url).searchParams.has("pageToken")
      ? { models: [{ name: "models/gemini-b", displayName: "Gemini B", supportedGenerationMethods: ["generateContent"] }] }
      : { models: [{ name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 8192, outputTokenLimit: 2048, supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-only", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "page-two" })
  })
  const p = await KunbotAntPlugin({}, { includeCatalog: false, routes: { google: { base: "https://google.example/v1beta", protocol: "gemini", discover: true } } })
  // Act
  const models = await p.provider.models({ models: {} }, { auth: auth("google-key") })
  // Assert
  assert.deepEqual(Object.keys(models), ["gemini-a", "gemini-b"])
  assert.equal(models["gemini-a"].name, "Gemini A")
  assert.equal(models["gemini-a"].api.npm, "@ai-sdk/google")
  assert.deepEqual(models["gemini-a"].limit, { context: 8192, output: 2048 })
  assert.deepEqual(requests.map(r => r.url), ["https://google.example/v1beta/models", "https://google.example/v1beta/models?pageToken=page-two"])
  assert.deepEqual(requests.map(r => r.headers.get("x-goog-api-key")), ["google-key", "google-key"])
  assert.equal(requests[0].headers.has("authorization"), false)
})

it('should replace the Gemini path model and credential when a streaming request switches to backup', async t => {
  // Arrange
  const requests = [], body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) })
    return requests.length === 1 ? json({}, 503) : new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  const { models, loader } = await plugin({ includeCatalog: false,
    routes: { main: { base: "https://google.example/v1beta", protocol: "gemini" }, backup: { base: "https://mirror.example/google", protocol: "gemini" } },
    models: { native: { id: "models/alpha/model", targets: [{ endpoint: "main" }, { endpoint: "backup", id: "models/beta-model" }] } },
  })
  // Act
  const response = await loader.fetch(`${models.native.api.url}/models/ignored:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": "stale-key", authorization: "Bearer stale-key" }, body: JSON.stringify(body) })
  // Assert
  assert.equal(response.status, 200)
  assert.deepEqual(requests.map(r => r.url), ["https://google.example/v1beta/models/alpha%2Fmodel:streamGenerateContent?alt=sse", "https://mirror.example/google/models/beta-model:streamGenerateContent?alt=sse"])
  assert.deepEqual(requests.map(r => r.body), [body, body])
  assert.deepEqual(requests.map(r => r.headers.get("x-goog-api-key")), ["test-key-A", "test-key-A"])
  assert.equal(requests[0].headers.has("authorization"), false)
  assert.equal(requests[0].headers.has("x-api-key"), false)
})

it('should preserve Gemini API versions when models use complete bases or relative suffixes', async t => {
  // Arrange
  const urls = []
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async url => { urls.push(url); return json({}) })
  const { models, loader } = await plugin({ includeCatalog: false,
    routes: { google: { base: "https://google.example/v1beta", protocol: "gemini" } },
    models: { implicit: { id: "g", endpoint: "google", suffix: "relay" }, explicit: { id: "g", endpoint: "google", suffix: "relay/v1beta" }, complete: { id: "g", endpoint: "google" } },
  })
  // Act
  for (const model of Object.values(models)) await loader.fetch(`${model.api.url}/models/g:generateContent`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"contents":[]}' })
  // Assert
  assert.deepEqual(urls, ["https://google.example/relay/v1beta/models/g:generateContent", "https://google.example/relay/v1beta/models/g:generateContent", "https://google.example/v1beta/models/g:generateContent"])
})

it('should expose System One decision flags when the provider also contains conversational models', async () => {
  // Arrange
  const p = await KunbotAntPlugin({}, { includeCatalog: false,
    routes: { decide: { base: "https://decision.example/v1", protocol: "systemone" }, chat: { base: "https://chat.example/v1" } },
    models: { classifier: { id: "classifier-id", endpoint: "decide" }, conversation: { id: "chat-id", endpoint: "chat" } },
  })
  const config = {}
  // Act
  await p.config(config)
  const models = await p.provider.models({ models: { template: { decides: true } } }, { auth: auth() })
  // Assert
  assert.equal(config.provider.kunbot.decide, true)
  assert.equal(config.provider.kunbot.models.classifier.decides, true)
  assert.equal(models.classifier.decides, true)
  assert.equal(models.conversation.decides, false)
  assert.equal(models.classifier.api.npm, "@ai-sdk/openai-compatible")
})

it('should preserve System One questions and state when a retry uses a different upstream model id', async t => {
  // Arrange
  const sent = [], questions = { ok: { type: "noul", instructions: "Is this a test?" } }, state = { text: "ping" }
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, body: JSON.parse(init.body), key: init.headers.get("authorization") }); return json({ answers: {} }, sent.length === 1 ? 503 : 200) })
  const { models, loader } = await plugin({ includeCatalog: false,
    routes: { main: { base: "https://decide.example/v1", protocol: "systemone" }, backup: { base: "https://backup.example/decision/v1", protocol: "systemone" } },
    models: { classifier: { id: "primary-decider", targets: [{ endpoint: "main" }, { endpoint: "backup", id: "backup-decider" }] } },
  })
  // Act
  const response = await loader.fetch(`${models.classifier.api.url}/systemone`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "display-id", questions, state }) })
  // Assert
  assert.equal(models.classifier.decides, true)
  assert.equal(response.status, 200)
  assert.deepEqual(sent, [
    { url: "https://decide.example/v1/systemone", body: { model: "primary-decider", questions, state }, key: "Bearer test-key-A" },
    { url: "https://backup.example/decision/v1/systemone", body: { model: "backup-decider", questions, state }, key: "Bearer test-key-A" },
  ])
})

it('should keep System One separate from Chat when discovery returns the same model id', async t => {
  // Arrange
  const posts = []
  t.after(() => t.mock.restoreAll())
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method !== "POST") return list(["shared-id"])
    posts.push(url); return json({}, posts.length === 1 ? 503 : 200)
  })
  const { models, loader } = await plugin({ includeCatalog: false,
    routes: { main: { base: "https://decide.example/v1", protocol: "systemone", discover: true }, backup: { base: "https://chat.example/v1", protocol: "chat", discover: true } }, fallback: ["main", "backup"],
  })
  // Act
  const response = await loader.fetch(`${models["shared-id"].api.url}/systemone`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"shared-id","questions":{},"state":{}}' })
  // Assert
  assert.equal(response.status, 503)
  assert.deepEqual(posts, ["https://decide.example/v1/systemone"])
})

test("model suffixes normalize relative paths and add exactly one trailing v1", () => {
  for (const [base, suffix, expected] of [
    ["https://ant.kunbot.org", "7sref", "https://ant.kunbot.org/7sref/v1"],
    ["https://ant.kunbot.org", " /7sref/v1/ ", "https://ant.kunbot.org/7sref/v1"],
    ["https://ant.kunbot.org/v1", "7sref", "https://ant.kunbot.org/7sref/v1"],
    ["https://ant.kunbot.org/gateway/v1", "nested/7sref", "https://ant.kunbot.org/gateway/nested/7sref/v1"],
    ["https://ant.kunbot.org", "v1", "https://ant.kunbot.org/v1"],
    ["https://ant.kunbot.org/salt/v1", "", "https://ant.kunbot.org/salt/v1"],
    ["https://ant.kunbot.org", " / ", "https://ant.kunbot.org"],
    ["https://ant.kunbot.org/custom/v2", undefined, "https://ant.kunbot.org/custom/v2"],
  ]) assert.equal(_routing.modelBase(base, suffix), expected)
  for (const suffix of ["https://other.example/7sref", "../salt", "a/./b", "%2e%2e/salt", "a%2fb", "a//b", "salt?key=test", "salt#fragment", "a\\b", "a b", 123]) {
    assert.throws(() => _routing.modelBase("https://ant.kunbot.org", suffix), /suffix/, String(suffix))
  }
})

test("one host serves image, hidden and Messages models through independent suffixes", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return json({ ok: true }) })
  const { models, loader } = await plugin({
    includeCatalog: false, routes: { main: { base: "https://ant.kunbot.org" } },
    models: {
      image: { endpoint: "main", id: "MiniMax-H3-Image", type: "image", suffix: "7sref" },
      hidden: { endpoint: "main", id: "hidden-test-id", suffix: "salt/v1" },
      paid: { endpoint: "main", id: "paid-test-id", protocol: "anthropic", suffix: "/proprietary/" },
    },
  })
  for (const [key, path] of [["image", "/images/generations"], ["hidden", "/chat/completions"], ["paid", "/messages"]]) {
    await loader.fetch(`${models[key].api.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: models[key].api.id }) })
  }
  assert.deepEqual(sent.map(s => s.url), ["https://ant.kunbot.org/7sref/v1/images/generations", "https://ant.kunbot.org/salt/v1/chat/completions", "https://ant.kunbot.org/proprietary/v1/messages"])
  assert.equal(sent[0].body.model, "MiniMax-H3-Image")
  assert.equal(models.image.capabilities.output.image, true)
  assert.equal(models.paid.api.npm, "@ai-sdk/anthropic")
})

test("account addresses are resolved before adding the shared primary and backup suffix", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, key: init.headers.get("authorization") }); return json({}, sent.length === 1 ? 503 : 200) })
  const p = await KunbotAntPlugin({}, { includeCatalog: false,
    routes: { main: { base: "https://main.example" }, backup: { base: "https://backup.example/v1" } },
    models: { image: { id: "MiniMax-H3-Image", type: "image", suffix: "7sref", targets: [{ endpoint: "main" }, { endpoint: "backup" }] } },
  })
  const account = auth("suffix-account-key", { endpointBaseURLs: "main=https://tenant.example/prefix/v1", requestBaseURL: "https://wrong.example" })
  const models = await p.provider.models({ models: {} }, { auth: account })
  const loader = await p.auth.loader(async () => account)
  await loader.fetch(`${models.image.api.url}/images/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "MiniMax-H3-Image" }) })
  assert.deepEqual(sent.map(s => s.url), ["https://tenant.example/prefix/7sref/v1/images/generations", "https://backup.example/7sref/v1/images/generations"])
  assert.ok(sent.every(s => s.key === "Bearer suffix-account-key"))
})

test("target suffix overrides and fixed bases retain their precedence", async () => {
  const table = await manager({ includeCatalog: false, routes: { main: { base: "https://main.example" } }, models: {
    image: { endpoint: "main", base: "https://fixed.example/v1", suffix: "7sref", targets: [
      {}, { suffix: "other" }, { base: "https://complete.example/custom/v2", suffix: "" },
    ] },
  } }).build({}, auth("shared", { endpointBaseURLs: "main=https://account.example" }))
  assert.deepEqual(table.image._targets.map(t => t.base), ["https://fixed.example/7sref/v1", "https://fixed.example/other/v1", "https://complete.example/custom/v2"])
})

test("suffix overrides preserve discovered models and never accumulate on repeated builds", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async url => { calls.push(String(url)); return list(["shared"]) })
  const m = manager({ endpoints, models: { shared: { suffix: "7sref", type: "image" } } })
  const before = await m.build({}, auth())
  const after = await m.build({}, auth())
  assert.deepEqual(after.shared._targets, before.shared._targets)
  assert.deepEqual(after.shared._targets.map(t => t.base), ["https://main.example/omni/7sref/v1", "https://backup.example/salt/7sref/v1"])
  assert.deepEqual(calls.sort(), ["https://backup.example/salt/v1/models", "https://main.example/omni/v1/models"])
  assert.deepEqual(after.shared.modalities.output, ["image"])
})

test("suffix-only models without a known endpoint fail clearly instead of silently using an inferred path", async () => {
  await assert.rejects(manager({ models: { "old/image": { suffix: "7sref" } } }).build({}, auth(), "https://ant.kunbot.org"), /suffix needs an endpoint/)
  await assert.rejects(manager({ models: { image: { base: "https://ant.kunbot.org", suffix: "../salt" } } }).build({}, auth()), /suffix/)
})

test("discovery unions model ids, preserves backup-only entries and selects the declared priority", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([String(url), init.headers.authorization])
    return String(url).includes("main.example") ? list(["shared", "main-only"]) : list(["shared", "backup-only"])
  })
  const m = manager({ endpoints, fallback: ["main", "backup"] })
  const table = await m.build({}, auth())
  assert.deepEqual(Object.keys(table).sort(), ["backup-only", "main-only", "shared"])
  assert.deepEqual(table.shared._targets.map(t => t.endpoint), ["main", "backup"])
  assert.equal(table["backup-only"]._targets[0].base, endpoints.backup.base)
  assert.equal(table["main-only"]._targets.length, 1)
  await m.build({}, auth())
  assert.equal(calls.length, 2, "discovery is cached")
})

test("public directories and endpoint overrides are scoped to the selected account", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([String(url), init.headers.authorization])
    return list([init.headers.authorization === "Bearer test-key-A" ? "model-A" : "model-B"])
  })
  const m = manager({ endpoints: { main: endpoints.main } })
  const [a, b] = await Promise.all([
    m.build({}, auth()),
    m.build({}, auth("test-key-B", { endpointBaseURLs: "main=https://tenant.example/custom/v1" })),
  ])
  assert.deepEqual(Object.keys(a), ["model-A"])
  assert.deepEqual(Object.keys(b), ["model-B"])
  assert.equal(b["model-B"]._targets[0].base, "https://tenant.example/custom/v1")
  assert.ok(calls.some(([url, key]) => url === "https://tenant.example/custom/v1/models" && key === "Bearer test-key-B"))
})

test("same-key accounts with different full endpoint overrides do not share discoveries", async t => {
  t.mock.method(globalThis, "fetch", async url => list([new URL(url).hostname]))
  const m = manager({ endpoints: { main: endpoints.main } })
  const a = await m.build({}, auth("shared", { endpointBaseURLs: { main: "https://a.example/v1" } }))
  const b = await m.build({}, auth("shared", { endpointBaseURLs: { main: "https://b.example/v1" } }))
  assert.deepEqual(Object.keys(a), ["a.example"])
  assert.deepEqual(Object.keys(b), ["b.example"])
})

test("failed discovery retains the last good list and does not hide manual models", async t => {
  let now = 1000, fail = false
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async () => fail ? json({}, 503) : list(["public"]))
  const m = manager({ endpoints: { main: endpoints.main }, models: { private: { endpoint: "main", id: "secret-id" } } })
  const before = await m.build({}, auth())
  now += 300001; fail = true
  const after = await m.build({}, auth())
  assert.deepEqual(Object.keys(after), Object.keys(before))
  const fresh = await m.build({}, auth("new-account"))
  assert.deepEqual(Object.keys(fresh), ["private"])
})

test("discovery timeouts are bounded and leave independently configured models usable", async t => {
  t.mock.method(globalThis, "fetch", (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const m = manager({ discoveryTimeoutMs: 100, endpoints: { main: endpoints.main }, models: { image: { endpoint: "main", type: "image" } } })
  const keepAlive = setTimeout(() => {}, 1000)
  try { assert.deepEqual(Object.keys(await m.build({}, auth())), ["image"]) }
  finally { clearTimeout(keepAlive) }
})

test("manual proprietary, image and hidden models keep distinct complete bases and protocols", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, init }); return json({ ok: true }) })
  const p = await KunbotAntPlugin({}, {
    includeCatalog: false,
    routes: {
      paid: { base: "https://anthropic.kunbot.art/v1", protocol: "anthropic", models: ["paid-id"] },
      omni: { base: "https://anthropic.kunbot.org/omni/v1", models: ["hidden-id"] },
      salt: { base: "https://anthropic.kunbot.org/salt/v1", models: { "image-id": "image" } },
    },
  })
  const account = auth("my-test-key", { requestBaseURL: "https://wrong.example/v1" })
  const models = await p.provider.models({ models: {} }, { auth: account })
  const loader = await p.auth.loader(async () => account)
  for (const [key, path] of [["paid/paid-id", "/messages"], ["omni/hidden-id", "/chat/completions"], ["salt/image-id", "/images/generations"]]) {
    await loader.fetch(`${models[key].api.url}${path}`, { method: "POST", body: JSON.stringify({ model: models[key].api.id }), headers: { "content-type": "application/json" } })
  }
  assert.deepEqual(sent.map(s => s.url), ["https://anthropic.kunbot.art/v1/messages", "https://anthropic.kunbot.org/omni/v1/chat/completions", "https://anthropic.kunbot.org/salt/v1/images/generations"])
  assert.equal(models["paid/paid-id"].api.npm, "@ai-sdk/anthropic")
  assert.equal(models["salt/image-id"].capabilities.output.image, true)
  assert.equal(models["salt/image-id"].capabilities.output.text, false)
  assert.ok(sent.every(s => s.init.headers.get("authorization") === "Bearer my-test-key"))
})

test("primary success makes one request; retryable HTTP failures use full backup path and upstream id", async t => {
  const sent = [], outcomes = [200, 503, 200]
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return json({}, outcomes.shift()) })
  const { models, loader } = await plugin({ includeCatalog: false, models: { shared: { id: "primary-id", targets: [
    { base: "https://main.example/omni/v1" }, { base: "https://backup.example/salt/v1", id: "backup-id" },
  ] } } })
  await loader.fetch(request(models.shared))
  assert.equal(sent.length, 1)
  await loader.fetch(request(models.shared))
  assert.equal(sent.length, 3)
  assert.equal(sent[2].url, "https://backup.example/salt/v1/chat/completions")
  assert.equal(sent[2].body.model, "backup-id")
  assert.equal(sent[2].init.method, "POST")
  assert.equal(sent[2].init.headers.get("x-custom"), "keep")
  assert.equal(sent[2].init.headers.get("content-type"), "application/json")
})

test("network, 408 and 429 failures switch once; input/auth errors are returned directly", async t => {
  let status = 429, calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; if (status === "network" && calls % 2) throw new TypeError("network"); return json({}, status === "network" ? 200 : status) })
  const { models, loader } = await plugin({ includeCatalog: false, models: { m: { targets: [{ base: "https://a.example/v1" }, { base: "https://b.example/v1" }] } } })
  for (const s of [408, 429, 500, "network"]) {
    status = s; calls = 0
    await loader.fetch(request(models.m))
    assert.equal(calls, 2)
  }
  for (const s of [400, 401, 403, 404]) {
    status = s; calls = 0
    const result = await loader.fetch(request(models.m))
    assert.equal(result.status, s); assert.equal(calls, 1)
  }
})

test("abort never switches; successful streams are passed through without probing the backup", async t => {
  let calls = 0, mode = "abort"
  const controller = new AbortController()
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    if (mode === "abort") { controller.abort(); throw controller.signal.reason }
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")); }, pull(c) { c.error(new Error("broken stream")) } }), { headers: { "content-type": "text/event-stream" } })
  })
  const { models, loader } = await plugin({ includeCatalog: false, models: { m: { targets: [{ base: "https://a.example/v1" }, { base: "https://b.example/v1" }] } } })
  await assert.rejects(loader.fetch(request(models.m), { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls, 1)
  mode = "stream"; calls = 0
  const res = await loader.fetch(request(models.m))
  await assert.rejects(res.text(), /broken stream/)
  assert.equal(calls, 1)
})

test("multipart fallback retains uploaded bytes and switches only the model field", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push({ url, form: await new Request(url, init).formData() }); return json({}, sent.length === 1 ? 503 : 200) })
  const { models, loader } = await plugin({ includeCatalog: false, models: { m: { id: "first", type: "image", targets: [{ base: "https://a.example/v1" }, { base: "https://b.example/salt/v1", id: "second" }] } } })
  const body = new FormData()
  body.set("model", "first"); body.set("prompt", "same prompt"); body.set("image", new Blob([new Uint8Array([1, 2, 3])]), "test.png")
  await loader.fetch(new Request(`${models.m.api.url}/images/edits`, { method: "POST", body }))
  assert.equal(sent[1].form.get("model"), "second")
  assert.equal(sent[1].form.get("prompt"), "same prompt")
  assert.deepEqual(new Uint8Array(await sent[1].form.get("image").arrayBuffer()), new Uint8Array([1, 2, 3]))
})

test("fixed base overrides preserve catalog capabilities and cannot be rewritten by account prefix", async t => {
  const old = { id: "real-id", name: "Known", provider: { api: "https://old.example/route/v1", npm: "@ai-sdk/openai-compatible" }, limit: { context: 128000, output: 8192 }, reasoning: true, tool_call: true, modalities: { input: ["text", "image"], output: ["text"] }, cost: { input: 3 }, variants: { high: {} } }
  const table = await manager({ models: { "route/real-id": { base: "https://fixed.example/omni/v1" } } }).build({ "route/real-id": old }, auth())
  const m = table["route/real-id"]
  assert.deepEqual(m.limit, old.limit)
  assert.deepEqual(m.modalities, old.modalities)
  assert.equal(m.reasoning, true); assert.equal(m.tool_call, true)
  assert.deepEqual(m.cost, old.cost)
  assert.equal(m._targets[0].base, "https://fixed.example/omni/v1")
})

test("legacy prefix forwarding preserves Request method, body, headers and cancellation", async t => {
  let sent
  t.mock.method(globalThis, "fetch", async (url, init) => { sent = { url, init }; return json({}) })
  const p = await KunbotAntPlugin({}, { includeCatalog: false })
  const loader = await p.auth.loader(async () => auth("old-key", { requestBaseURL: "https://mirror.example/prefix" }))
  const signal = new AbortController().signal
  await loader.fetch(new Request("https://old.example/maid/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-extra": "keep" }, body: '{"model":"legacy"}', signal }))
  assert.equal(sent.url, "https://mirror.example/prefix/maid/v1/chat/completions")
  assert.equal(sent.init.method, "POST")
  assert.equal(new TextDecoder().decode(sent.init.body), '{"model":"legacy"}')
  assert.equal(sent.init.headers.get("x-extra"), "keep")
  assert.equal(sent.init.signal.aborted, false)
})

test("empty manual options never manufacture proprietary entries or submit a key", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push([url, init?.method]); return json({}) })
  const p = await KunbotAntPlugin({}, { models: {} })
  await p.provider.models({ models: {} }, { auth: auth() })
  assert.equal(calls.filter(([, method]) => method === "POST").length, 0)
})

test("invalid endpoints and cross-protocol manual fallbacks fail clearly", async () => {
  assert.throws(() => manager({ routes: { main: { base: "file:///tmp/key" } } }), /Invalid endpoint/)
  assert.throws(() => endpointOverrides({ metadata: { endpointBaseURLs: "main=https://user:password@example.com/v1" } }), /Endpoint Base/)
  const m = manager({ models: { m: { targets: [{ base: "https://a.example/v1", npm: "@ai-sdk/anthropic" }, { base: "https://b.example/v1" }] } } })
  await assert.rejects(m.build({}, auth()), /same protocol/)
  assert.throws(() => routeRequest("https://models.kunbot.invalid/bad"), /Invalid kunbot/)
})

test("explicit fixed model base wins over account endpoint mapping", async () => {
  const m = manager({ endpoints: { main: { ...endpoints.main, discover: false } }, models: { m: { endpoint: "main", base: "https://fixed.example/v1" } } })
  const table = await m.build({}, auth("test-key", { endpointBaseURLs: "main=https://account.example/v1" }))
  assert.equal(table.m._targets[0].base, "https://fixed.example/v1")
})

test("metadata and upstream id overrides apply once to discovered models", async t => {
  t.mock.method(globalThis, "fetch", async () => list(["known"]))
  const old = { id: "known", name: "Known", provider: { api: "https://old.example/v1", npm: "@ai-sdk/openai-compatible" }, limit: { context: 128000, output: 8192 }, reasoning: true, tool_call: true, modalities: { input: ["text"], output: ["text"] }, cost: { input: 2 }, variants: { high: {} } }
  const m = manager({ includeCatalog: true, endpoints, models: { "old/known": { id: "actual-id", type: "vision" } } })
  const table = await m.build({ "old/known": old }, auth())
  assert.deepEqual(Object.keys(table), ["old/known"])
  assert.deepEqual(table["old/known"].limit, old.limit)
  assert.equal(table["old/known"].reasoning, true)
  assert.deepEqual(table["old/known"].modalities.input, ["text", "image"])
  assert.deepEqual(table["old/known"]._targets.map(t => t.id), ["actual-id", "actual-id"])
})

test("public refresh retains a failed catalog while incorporating other successful feeds", async t => {
  let now = 1000, failed = false
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("models.json")) {
      if (failed) return json({}, 503)
      return json({ providers: { main: { baseUrl: "https://legacy.example/maid/v1", api: "openai-completions", models: [{ id: "known", name: "Known", contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text", "image"] }] } } })
    }
    if (String(url).endsWith("openweight")) return json({ base_url: "https://images.example", routes: failed ? [{ slug: "img", label: "Image Generation", models: ["image-id"] }] : [] })
    return json({})
  })
  const p = await KunbotAntPlugin({}, { models: { "maid/known": { base: "https://fixed.example/omni/v1" } } })
  const first = await p.provider.models({ models: {} }, { auth: auth() })
  assert.equal(first["maid/known"].limit.context, 128000)
  now += 300001; failed = true
  const next = await p.provider.models({ models: {} }, { auth: auth() })
  assert.equal(next["maid/known"].limit.context, 128000)
  assert.equal(next["maid/known"].capabilities.reasoning, true)
  assert.equal(next["img/image-id"].capabilities.output.image, true)
})

test("balance-session failure cannot remove independently configured models", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/proprietary/key")) throw new TypeError("offline")
    if (String(url).endsWith("/proprietary")) return json({ base_url: "https://paid.example/v1", models: { paid: {} } })
    return json({})
  })
  const p = await KunbotAntPlugin({}, { models: { hidden: { base: "https://hidden.example/v1", id: "real" } } })
  const models = await p.provider.models({ models: {} }, { auth: auth("optional-balance-test") })
  assert.deepEqual(Object.keys(models), ["hidden"])
})

test("transport uses each selected account key even for the same logical model", async t => {
  const keys = []
  t.mock.method(globalThis, "fetch", async (url, init) => { keys.push([url, init.headers.get("authorization")]); return json({}) })
  const p = await KunbotAntPlugin({}, { includeCatalog: false, routes: { main: { base: "https://main.example/v1" } }, models: { m: { endpoint: "main" } } })
  const a = auth("test-key-A"), b = auth("test-key-B", { endpointBaseURLs: "main=https://account-B.example/salt/v1" })
  for (const account of [a, b]) {
    const models = await p.provider.models({ models: {} }, { auth: account })
    const loader = await p.auth.loader(async () => account)
    await loader.fetch(request(models.m))
  }
  assert.deepEqual(keys, [["https://main.example/v1/chat/completions", "Bearer test-key-A"], ["https://account-b.example/salt/v1/chat/completions", "Bearer test-key-B"]])
})
