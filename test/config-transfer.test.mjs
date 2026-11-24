import test, { it } from "node:test"
import assert from "node:assert/strict"
import "../page/config-transfer.js"
import { createRoutes } from "../lib/routing.mjs"
import { _internal } from "../index.mjs"

const { encode, decode, validate, LIMIT } = globalThis.KunbotConfigTransfer

it('should retain native protocols when Gemini and System One configurations are exported and imported', () => {
  // Arrange
  const options = { includeCatalog: false, routes: { google: { base: "https://google.example/v1beta", protocol: "gemini" }, decide: { base: "https://decide.example/v1", protocol: "systemone" } }, models: { native: { id: "g", endpoint: "google", suffix: "relay/v1beta" }, classifier: { id: "c", endpoint: "decide" } } }
  // Act
  const result = decode(encode(options, "0.4.0"))
  // Assert
  assert.deepEqual(result.options, options)
  assert.deepEqual(result.summary, { routes: 2, models: 2, includeCatalog: false })
})

it('should reject mixed native protocols when a System One fallback points at a Chat endpoint', () => {
  // Arrange
  const json = JSON.stringify({ routes: { decide: { base: "https://decide.example/v1", protocol: "systemone" }, chat: { base: "https://chat.example/v1", protocol: "chat" } }, models: { classifier: { id: "c", targets: [{ endpoint: "decide" }, { endpoint: "chat" }] } } })
  // Act / Assert
  assert.throws(() => decode(json), /主备线路需要使用相同协议/)
})
const fixture = () => ({
  includeCatalog: false, diagnosticsPort: 37747, discoveryTimeoutMs: 9000,
  routes: {
    main: { name: "主线", base: "https://main.example/v1", protocol: "chat", models: { grouped: { type: "vision", context: 128000 } } },
    paid: { base: "https://paid.example/v1", protocol: "anthropic" },
  },
  endpoints: { backup: { base: "https://backup.example/omni/v1", npm: "@ai-sdk/openai-compatible" } },
  fallback: ["main", "backup", "paid"],
  models: {
    "manual/image": { id: "default-image-id", type: "image", suffix: "7sref", targets: [{ endpoint: "main", id: "primary-image-id", suffix: "" }, { endpoint: "backup" }, { base: "https://third.example/v1", id: "third-image-id", suffix: "salt" }], cost: { input: 3 }, variants: { high: {} }, input: ["text", "image"], rate: "1.25" },
    "manual/private": { id: "private-id", endpoint: "paid", type: "text", reasoning: true, tool_call: true },
    "legacy/known": "vision",
  },
  advancedSetting: { name: "保留", list: [1, "two", false] },
})

test("versioned backups preserve complete options, candidate ids, suffixes, grouped models and unknown advanced fields", async () => {
  const options = fixture(), snapshot = structuredClone(options)
  const json = encode(options, "0.3.2"), backup = JSON.parse(json)
  assert.equal(backup.format, "magpie-kunbot-config"); assert.equal(backup.version, 1)
  assert.equal(backup.pluginVersion, "0.3.2"); assert.ok(Number.isFinite(Date.parse(backup.exportedAt)))
  const imported = decode(json)
  assert.deepEqual(imported.options, options)
  assert.deepEqual(imported.summary, { routes: 3, models: 4, includeCatalog: false })
  assert.deepEqual(options, snapshot)
  const build = config => createRoutes(config, _internal.configuredModels).build()
  assert.deepEqual(await build(imported.options), await build(options))
})

test("raw Options and UTF-8 BOM files import without a backup wrapper", () => {
  const options = { endpoints: { old: { base_url: "https://legacy.example/v1", discover: true, models: ["one", "two"] } }, extraModels: { "old/one": { type: "text", context: "128,000", output_limit: "8192" } }, custom: "retained" }
  const result = decode("\uFEFF" + JSON.stringify(options))
  assert.deepEqual(result.options, options)
  assert.deepEqual(result.summary, { routes: 1, models: 2, includeCatalog: false })
  assert.deepEqual(decode("{}").summary, { routes: 0, models: 0, includeCatalog: true })
})

test("invalid JSON, non-objects, foreign backups and unsupported format versions fail clearly", () => {
  for (const value of ["{", "", "null", "[]", "42", '"text"']) assert.throws(() => decode(value), /JSON|对象/)
  assert.throws(() => decode('{"format":"other-plugin","version":1,"options":{}}'), /不是 magpie-kunbot/)
  assert.throws(() => decode('{"format":"magpie-kunbot-config","version":2,"options":{}}'), /格式版本/)
  assert.throws(() => decode('{"format":"magpie-kunbot-config","version":1}'), /JSON 对象/)
  assert.throws(() => decode('{"options":{},"version":1}'), /不是 magpie-kunbot/)
})

test("malformed route structures, addresses, references and known option types cannot be imported", () => {
  const cases = [
    { routes: [] }, { models: [] }, { routes: { invalid: "url" } }, { routes: { "bad/name": { base: "https://example.test" } } },
    { routes: { main: { base: "https://user:password@example.test/v1" } } },
    { routes: { main: { base: "https://example.test/v1?key=value" } } },
    { routes: { main: { base: "file:///tmp/config" } } },
    { routes: { main: { base: "https://example.test", discover: "yes" } } },
    { includeCatalog: "false" }, { diagnosticsPort: 65536 }, { discoveryTimeoutMs: "8000" },
    { fallback: ["absent"] }, { models: { model: { endpoint: "absent" } } },
    { models: { model: { type: "not-a-kind" } } },
    { models: { model: { output: "image" } } },
  ]
  for (const options of cases) {
    const snapshot = structuredClone(options)
    assert.throws(() => decode(JSON.stringify(options)), undefined, JSON.stringify(options))
    assert.deepEqual(options, snapshot)
  }
})

test("invalid candidate structures, model suffixes and mixed fallback protocols are rejected", () => {
  const options = fixture()
  for (const targets of [[], [null], ["main"], [{}], [{ endpoint: "absent" }], [{ endpoint: "main" }, { endpoint: "paid" }]]) {
    const candidate = structuredClone(options)
    candidate.models["manual/image"].targets = targets
    assert.throws(() => validate(candidate), /targets|endpoint|线路|候选/)
  }
  for (const value of ["https://example.test", "a//b", "a/../b", "a?x=y", 3]) {
    const candidate = structuredClone(options)
    candidate.models["manual/image"].suffix = value
    assert.throws(() => validate(candidate), /suffix/)
  }
  const overridden = fixture()
  overridden.models["manual/image"].targets = [{ endpoint: "main" }, { endpoint: "paid", protocol: "chat" }]
  assert.doesNotThrow(() => validate(overridden), "effective protocol overrides are respected")
})

test("relative suffix aliases, modality aliases and independent fixed-base candidates remain compatible", () => {
  for (const suffix of ["", "/7sref/", "7sref/v1", null]) {
    const options = fixture()
    options.models["manual/image"].suffix = suffix
    options.models["manual/private"].type = "CHAT"
    options.models["legacy/known"] = "speech-to-text"
    assert.deepEqual(decode(encode(options, "future-plugin-version")).options, options)
  }
})

test("text limits count UTF-8 bytes for both imports and exports", () => {
  assert.throws(() => decode(" ".repeat(LIMIT + 1)), /1 MiB/)
  const multibyte = { note: "汉".repeat(Math.ceil(LIMIT / 3)) }
  assert.ok(JSON.stringify(multibyte).length < LIMIT)
  assert.throws(() => decode(JSON.stringify(multibyte)), /1 MiB/)
  assert.throws(() => encode(multibyte, "0.3.2"), /1 MiB/)
  assert.doesNotThrow(() => decode(JSON.stringify({ note: "汉".repeat(1000) })))
})

test("prototype properties, grouped prototype keys and deeply nested payloads are rejected without pollution", () => {
  for (const json of ['{"__proto__":{"polluted":true}}', '{"custom":{"constructor":{"prototype":{"polluted":true}}}}', '{"routes":{"main":{"base":"https://example.test","models":{"test":{"key":"__proto__"}}}}}']) {
    assert.throws(() => decode(json), /对象属性/)
  }
  let options = {}
  for (let i = 0; i < 70; i++) options = { child: options }
  assert.throws(() => decode(JSON.stringify(options)), /嵌套/)
  assert.equal({}.polluted, undefined)
})
