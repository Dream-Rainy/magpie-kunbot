// kunbot's model gateway, as a provider plugin for magpie.
//
// The site serves three kinds of endpoint, and each kind knows its own address:
//
//   open-weight   one endpoint per route, each with its own baseUrl, the API it
//                 speaks, and the full model spec (context window, max output,
//                 cost, whether it reasons). All of it comes from
//                 /configs/pi/models.json, the same file the site hands to pi
//                 users, so it is the source of truth. A request goes to
//                 <base_url>/<route>/v1.
//   proprietary   Claude, GPT and the rest, all on one gateway whose address the
//                 proprietary feed states as its own `base_url`. A request goes
//                 to that address, not to the status site. These need
//                 "Proprietary Access" on the key and are billed in Pt.
//   image         routes the status site labels "Image Generation", whose note
//                 names the model they serve. They are not in the pi catalog,
//                 and a request goes to <base_url>/<route>/v1 asking for an
//                 image output modality.
//
// No feed is filtered by whether it says a model is up. A route or model
// the site reports as down is still listed: the probe is the site's business,
// not a decision this plugin should make about what an agent may ask for.
//
// Legacy discovery uses ant.kunbot.org. Named endpoints, automatic discovery
// and manual models are configured through the plugin page. Their complete
// API prefixes are resolved per model and per selected account.

import { createRoutes, routeRequest, forwardRequest } from "./lib/routing.mjs"
import { startDiagnosticService } from "./lib/diagnostic-service.mjs"

const PROVIDER = "kunbot"
const CLIENT = "magpie-kunbot/0.3.1"

// The status site: the one address the plugin knows. It serves the catalogs
// and holds the balance session; the model gateway is a different host, and
// its address comes from the catalogs.
const SITE = "https://ant.kunbot.org"

const normalizeBase = (value) => {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    url.search = ""
    url.pathname = url.pathname.replace(/\/+$/, "")
    return url.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

const ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/i

// A sign-in may give one base for every route, or a route=base map for as
// many routes as it likes. A route is the first path segment of the model's
// catalog address (`.../maid/v1`), `proprietary` for the paid gateway, and
// `*` for every route no other key names.
const normalizeBaseMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const base = normalizeBase(raw)
    if (base) out[String(key).trim().toLowerCase()] = base
  }
  return Object.keys(out).length ? out : null
}

const parseBaseOverrides = (value) => {
  const raw = String(value ?? "").trim()
  if (!raw) return {}
  // A URL may contain `=`, so a lone address is read as one before the
  // route=URL form is tried.
  if (/^https?:\/\//i.test(raw)) {
    const base = normalizeBase(raw)
    return base === null ? null : { baseURL: base }
  }
  const map = {}
  for (const part of raw.split(/[,;\n]+/)) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf("=")
    if (eq <= 0) return null
    const key = item.slice(0, eq).trim().toLowerCase()
    const base = normalizeBase(item.slice(eq + 1))
    if ((key !== "*" && !ROUTE_KEY.test(key)) || !base) return null
    map[key] = base
  }
  return Object.keys(map).length ? { baseURLs: map } : null
}

// Model kinds the plugin's `models` option can name, and the modalities
// each one means. A model the catalog cannot classify (an image route whose
// note was masked, a speech route, a second endpoint) is declared here.
const MODEL_KINDS = {
  text: { input: ["text"], output: ["text"], tool_call: true },
  vision: { input: ["text", "image"], output: ["text"], tool_call: true },
  image: { input: ["text"], output: ["image"], tool_call: false },
  audio: { input: ["text"], output: ["audio"], tool_call: false },
  transcription: { input: ["audio"], output: ["text"], tool_call: false },
  video: { input: ["text"], output: ["video"], tool_call: false },
}

const MODEL_KIND_ALIASES = {
  text: "text",
  chat: "text",
  vision: "vision",
  image: "image",
  "image-generation": "image",
  "image generation": "image",
  img: "image",
  draw: "image",
  audio: "audio",
  tts: "audio",
  speech: "audio",
  "text-to-speech": "audio",
  transcription: "transcription",
  transcribe: "transcription",
  asr: "transcription",
  stt: "transcription",
  "speech-to-text": "transcription",
  video: "video",
  "video-generation": "video",
}

const modalityList = (value, fallback) => {
  if (!Array.isArray(value)) return fallback
  const out = value.map((v) => String(v).trim().toLowerCase()).filter((v) => v === "text" || v === "image" || v === "audio" || v === "video" || v === "pdf")
  return out.length ? [...new Set(out)] : fallback
}

// `models` is the plugin option that names models the catalog cannot:
//
//   { "7sref/MiniMax-H3-Image": "image",
//     "tts/voice": { "type": "audio", "base": "https://…/v1", "id": "voice" } }
//
// A string is a kind. An object's `base` (or `base_url`) is required for a
// model the catalog does not know; a known model keeps its catalog address
// unless `base` overrides it. The route's own `<gateway>/<route>/v1` is used
// when `base` is omitted and the gateway's base is known.
function configuredModels(models, specs, gatewayBase, log = () => {}) {
  if (!specs || typeof specs !== "object" || Array.isArray(specs)) return models
  const out = { ...(models ?? {}) }
  for (const [rawKey, rawSpec] of Object.entries(specs)) {
    const key = String(rawKey).trim()
    if (!key) continue
    const spec = typeof rawSpec === "string" ? { type: rawSpec } : rawSpec
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      log(`model ${key}: the option must be a kind or an object`)
      continue
    }
    const askedKind = spec.type == null ? "" : String(spec.type).trim().toLowerCase()
    const kindName = askedKind ? MODEL_KIND_ALIASES[askedKind] : ""
    const kind = kindName ? MODEL_KINDS[kindName] : null
    if (askedKind && !kind) {
      log(`model ${key}: unknown type ${JSON.stringify(spec.type)}`)
      continue
    }
    const prev = out[key]
    const route = key.includes("/") ? key.split("/")[0] : ""
    const inherited = prev?.provider?.api ?? (gatewayBase && route ? `${gatewayBase.replace(/\/+$/, "")}/${route}/v1` : "")
    const askedBase = spec.base ?? spec.base_url ?? spec.url
    const base = askedBase !== undefined ? normalizeBase(askedBase) : normalizeBase(inherited)
    if (!base) {
      log(`model ${key}: no base URL (set its "base" in the plugin's models option)`)
      continue
    }
    const id = String(spec.id ?? prev?.id ?? key.split("/").slice(1).join("/") ?? "").trim() || key
    const input = modalityList(spec.input, kind?.input ?? prev?.modalities?.input ?? ["text"])
    const output = modalityList(spec.output, kind ? kind.output : prev?.modalities?.output ?? ["text"])
    const limit = { context: 0, output: 0, ...(prev?.limit ?? {}) }
    if (spec.context != null) limit.context = num(spec.context) ?? 0
    if (spec.output_limit != null) limit.output = num(spec.output_limit) ?? 0
    out[key] = {
      ...(prev ?? {}),
      name: String(spec.name ?? prev?.name ?? id),
      id,
      provider: {
        ...(prev?.provider ?? {}),
        npm: String(spec.npm ?? prev?.provider?.npm ?? "@ai-sdk/openai-compatible"),
        api: base,
      },
      limit,
      reasoning: spec.reasoning ?? prev?.reasoning ?? false,
      // A media model is not a tool caller unless its own option says so;
      // a text one keeps the catalog's answer when it had one.
      tool_call: spec.tool_call ?? kind?.tool_call ?? prev?.tool_call ?? false,
      modalities: { input, output },
      cost: spec.cost ?? prev?.cost ?? {},
      variants: spec.variants ?? prev?.variants ?? {},
      ...(spec.rate !== undefined ? { rate: spec.rate } : prev?.rate !== undefined ? { rate: prev.rate } : {}),
    }
  }
  return out
}

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input))

const rewriteRequest = (input, base) => {
  const target = new URL(urlOf(input))
  const root = new URL(base)
  target.protocol = root.protocol
  target.host = root.host
  target.pathname = `${root.pathname.replace(/\/+$/, "")}${target.pathname}`.replace(/\/{2,}/g, "/")
  return target.href
}

const PROTOCOL_SEGMENTS = new Set(["v1", "messages", "responses", "chat", "images"])

// The route an outgoing URL belongs to: the first path segment of a model
// route (`/maid/v1/...`), or `proprietary` for the gateway root, whose paths
// start with the protocol's own segment (`/v1/messages`, `/messages`).
const routeOf = (input) => {
  try {
    const first = new URL(urlOf(input)).pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? ""
    return !first || PROTOCOL_SEGMENTS.has(first) ? "proprietary" : first
  } catch {
    return ""
  }
}

// One override per route. Routes not named keep the catalog's address; `*`
// is the one every unnamed route falls back to.
const baseFor = (input, map, fallback) => {
  if (!map) return fallback
  const route = routeOf(input)
  return map[route] ?? map["*"] ?? fallback
}

// The reasoning efforts magpie's agents already know how to send. A route's
// thinkingLevelMap names the ones it takes: a level mapped to null is one the
// route does not accept, so it is not offered.
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

const effortsFor = (map) => (map && typeof map === "object" ? EFFORTS.filter((e) => map[e] != null) : EFFORTS)

const num = (v) => {
  const n = Number.parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

// The five reads this plugin makes of the status site. All of them are the
// site's own endpoints; none of them takes a key except the balance session.
const ENDPOINTS = {
  // The public reads.
  catalog: `${SITE}/configs/pi/models.json`,
  proprietary: `${SITE}/api/proprietary`,
  // The route list. Its image routes are not in the pi catalog.
  openweight: `${SITE}/api/openweight`,
  // The balance flow. POST key is the site's own "paste a key, see your
  // balance" endpoint: it checks the key against the gateway and, if it is a
  // working key, leaves a session behind that /access then reads. It is the
  // documented behaviour of the site's own UI, and the only way to learn a
  // key's balance - the gateway refuses every unauthenticated read with a bare
  // 403. It does mean the key is POSTed to the status site; see the README.
  keySession: `${SITE}/api/proprietary/key`,
  access: `${SITE}/api/proprietary/access`,
}

const getJSON = async (url, init) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ""}`.trim())
  return res.json()
}

// The catalog is a pi/models.json: a map of provider id -> { baseUrl, api,
// models[] }. magpie needs the same information in its own shape, so the
// models are translated one by one rather than re-declared by hand.
//
// The catalog keys its providers `fishlb-<route>-<model>`, but the segment an
// agent actually addresses is the route (`maid`, `empurple`, `uni`, `7sref`)
// — the same segment that appears in the route's /v1 URL. The route slug is
// read back out of baseUrl so the key an agent types
// (`kunbot/maid/deepseek-ai/DeepSeek-V4.1-Flash`) is the address the request
// is sent to, and so two routes serving the same model id do not collide.
function modelsFromCatalog(catalog) {
  const providers = catalog?.providers ?? catalog
  if (!providers || typeof providers !== "object") return null

  const out = {}
  for (const [pid, p] of Object.entries(providers)) {
    // The catalog is pi's: `api` names the wire format. Every route the site
    // serves is OpenAI Chat Completions today; anything else is left to a
    // future revision of this plugin rather than guessed at.
    if (p?.api && !/openai-completions|openai-chat/i.test(p.api)) continue
    // A route with no address cannot be sent to: leave it out rather than
    // list a model magpie can only fail with "nowhere to send its requests".
    const base = normalizeBase(p?.baseUrl)
    if (!base) continue
    // /v1 at the end of the base is preceded by the route: .../<route>/v1.
    const route = /\/([^/]+)\/v1\/?$/.exec(base)?.[1] ?? pid.replace(/^fishlb-/, "")
    for (const m of p?.models ?? []) {
      const id = m?.id
      if (!id) continue

      // The route is part of the address rather than part of the model id, so
      // it is folded into the model key. The key is what an agent asks for;
      // `id` is what goes on the wire.
      const key = `${route}/${id}`
      const ctx = num(m?.contextWindow)
      const max = num(m?.maxTokens)
      const input = Array.isArray(m?.input) ? m.input : ["text"]
      const cost = m?.cost ?? {}

      out[key] = {
        name: m?.name || id,
        id,
        // Per-model address: the route's own /v1, taken from the catalog. The
        // provider-level `api` below is only a fallback.
        provider: { npm: "@ai-sdk/openai-compatible", api: base },
        limit: { context: ctx ?? 200000, ...(max ? { output: max } : {}) },
        reasoning: m?.reasoning === true,
        tool_call: true,
        modalities: { input, output: ["text"] },
        ...(num(cost?.input) != null || num(cost?.output) != null
          ? {
              cost: {
                ...(num(cost?.input) != null ? { input: num(cost?.input) } : {}),
                ...(num(cost?.output) != null ? { output: num(cost?.output) } : {}),
                ...(num(cost?.cacheRead) != null ? { cache_read: num(cost?.cacheRead) } : {}),
                ...(num(cost?.cacheWrite) != null ? { cache_write: num(cost?.cacheWrite) } : {}),
              },
            }
          : {}),
        ...(m?.reasoning === true
          ? { variants: Object.fromEntries(effortsFor(m?.thinkingLevelMap).map((e) => [e, {}])) }
          : {}),
      }
    }
  }
  return Object.keys(out).length ? out : null
}

// The proprietary feed. The models here are named on the gateway root, so they
// are the site's own ids with no route segment.
//
// The feed states the gateway's own address as `base_url`. That address is put
// on every model, because the proprietary models are not served by the status
// site: a request has to go to the gateway, and only the feed knows where
// that is on this deployment.
function proprietaryModels(feed) {
  const models = feed?.models
  if (!models || typeof models !== "object") return null
  const host = normalizeBase(feed?.base_url)
  if (!host) return null
  const out = {}
  for (const id of Object.keys(models)) {
    out[id] = {
      name: id,
      id,
      provider: { npm: "@ai-sdk/anthropic", api: host },
      limit: { context: 200000, output: 32000 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      cost: {},
      // The gateway meters output tokens in Pt and refuses a key that has no
      // Proprietary Access, so these are not free: magpie should not spend
      // them first.
      rate: 1,
      variants: Object.fromEntries(EFFORTS.map((e) => [e, {}])),
    }
  }
  return Object.keys(out).length ? out : null
}

// The status site labels an image-generation route "Image Generation" and
// names the model it serves in the route's note. Those routes stay out of the
// pi catalog, so they are read here. The model is named `<route>/<model>` like
// the chat routes, and magpie 0.1.3423+ sends image-only models to the
// route's /v1/images/generations.
const IMAGE_ROUTE_LABEL = "image generation"

function imageIdsFromNote(note) {
  const found = /supported\s+models?\s*[:：]\s*([^\n]+)/i.exec(String(note ?? ""))
  if (!found) return []
  return found[1]
    .split(/[,;，；、]/)
    .map((part) => part.trim().split(/\s+/)[0]?.replace(/[（(].*$/, "").replace(/[.。]+$/, ""))
    .filter(Boolean)
}

function imagesFromOpenweight(feed) {
  const base = normalizeBase(feed?.base_url)
  if (!base) return null

  const out = {}
  for (const route of Array.isArray(feed?.routes) ? feed.routes : []) {
    if (String(route?.label ?? "").trim().toLowerCase() !== IMAGE_ROUTE_LABEL) continue
    const slug = String(route?.slug ?? "").trim()
    if (!slug) continue

    const listed = (Array.isArray(route?.models) ? route.models : [])
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean)
    const ids = listed.length ? listed : imageIdsFromNote(route?.note)
    const usable = ids.filter((id) => !id.includes("?"))

    for (const id of usable) {
      out[`${slug}/${id}`] = {
        name: id,
        id,
        provider: { npm: "@ai-sdk/openai-compatible", api: `${base}/${slug}/v1` },
        limit: { context: 0, output: 0 },
        modalities: { input: ["text"], output: ["image"] },
        reasoning: false,
        tool_call: false,
        cost: {},
        variants: {},
      }
    }
  }
  return Object.keys(out).length ? out : null
}

const MODALITIES = ["text", "image", "audio", "video", "pdf"]
const modalitiesOf = (list, fallback = ["text"]) =>
  Object.fromEntries(MODALITIES.map((k) => [k, (Array.isArray(list) && list.length ? list : fallback).includes(k)]))

const costOf = (cost) => ({
  input: num(cost?.input) ?? 0,
  output: num(cost?.output) ?? 0,
  cache: {
    read: num(cost?.cacheRead) ?? num(cost?.cache_read) ?? 0,
    write: num(cost?.cacheWrite) ?? num(cost?.cache_write) ?? 0,
  },
})

// `provider.models` returns OpenCode's Model, not the config hook's model.
// magpie reads capabilities.reasoning/toolcall/input/output and
// cost.cache.read/write here; the config hook's reasoning, tool_call,
// modalities and cache_read keys are ignored on this path. The first model
// is only a source of defaults (headers, options, temperature), never of the
// capabilities themselves: otherwise a text-only route inherits another
// route's image input.
function hookModel(template, m) {
  const base = { ...(template ?? {}) }
  const input = modalitiesOf(m.modalities?.input)
  const output = modalitiesOf(m.modalities?.output, ["text"])
  return {
    ...base,
    id: m.id,
    name: m.name,
    api: {
      id: m.id,
      // No fallback to the template's address: that is one route's endpoint,
      // not a default for every other model. A missing address is a catalog
      // problem, and magpie should fail loudly rather than send it elsewhere.
      url: m.provider?.api ?? "",
      npm: m.provider?.npm ?? base.api?.npm ?? "@ai-sdk/openai-compatible",
    },
    limit: m.limit ?? base.limit ?? { context: 0, output: 0 },
    capabilities: {
      ...(base.capabilities ?? {}),
      temperature: base.capabilities?.temperature ?? true,
      reasoning: m.reasoning === true,
      toolcall: m.tool_call !== false,
      attachment: MODALITIES.some((k) => k !== "text" && input[k]),
      input,
      output,
    },
    cost: costOf(m.cost),
    variants: m.variants ?? {},
    ...(m.rate !== undefined ? { rate: m.rate } : {}),
  }
}

// The site's own UI signs a working key in and reads the balance back through
// a session. This does the same, caching the verdict for a while so
// `magpie quota` does not re-post the key on every read.
// Keyed by the key: there is one status site.
const sessions = new Map()
const SESSION_TTL = 30 * 60 * 1000

async function readAccess(key) {
  const id = key
  const hit = sessions.get(id)
  if (hit && hit.until > Date.now()) return hit.value
  if (hit) sessions.delete(id)

  const post = await fetch(ENDPOINTS.keySession, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(8000),
  })
  if (!post.ok) {
    const body = await post.json().catch(() => ({}))
    if (![400, 401, 403].includes(post.status)) return { ok: false, error: `the site answered ${post.status}` }
    // The site answers 400 with a reason rather than a `state` for a key the
    // gateway does not recognise. That is still a verdict about the key, so
    // it is normalised to the same shape as a session read: `access` always
    // carries the state the caller switches on.
    const value = { ok: false, access: { state: "anonymous" }, error: body?.error || `the site answered ${post.status}` }
    sessions.set(id, { until: Date.now() + SESSION_TTL, value })
    return value
  }
  const submitted = await post.json().catch(() => ({}))
  // A 200 carries the key's access state, as the site's own page reads it. A
  // state other than ok (no_pma, revoked) is the verdict: it is put in the
  // same `access` shape a session read gives, so the caller sees the state,
  // and cached so the key is not re-posted on every quota read.
  if (submitted?.state && submitted.state !== "ok") {
    const value = { ok: false, access: submitted }
    sessions.set(id, { until: Date.now() + SESSION_TTL, value })
    return value
  }

  const setCookies = post.headers.getSetCookie?.() ?? []
  const jar = new Map()
  for (const raw of setCookies) {
    const [pair] = raw.split(";")
    const eq = pair.indexOf("=")
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ") || undefined
  if (!cookie) return { ok: false, error: "the site set no session for this key" }

  const res = await fetch(ENDPOINTS.access, { headers: { accept: "application/json", cookie }, signal: AbortSignal.timeout(8000) })
  if (!res.ok) return { ok: false, error: `the site answered ${res.status}` }
  const body = await res.json().catch(() => null)
  const value = { ok: true, access: body }
  sessions.set(id, { until: Date.now() + SESSION_TTL, value })
  return value
}

export const KunbotAntPlugin = async ({ client, directory, magpie }, options = {}) => {
  const log = (level, message) => {
    try {
      client?.app?.log?.({ level, service: PROVIDER, message })
    } catch {}
  }
  // `models` names what the catalog cannot: a masked image id, a speech
  // model, or a model on another endpoint. It is a plugin option, so it
  // applies to every account rather than living in one sign-in.
  const routes = createRoutes(options, configuredModels, message => log("warn", message))

  // The public feeds are read once and kept for a while
  // rather than on every hook call.
  let cache = { until: 0, models: null, proprietary: null, images: null, gatewayBase: "" }
  let refreshing
  const CATALOG_TTL = 5 * 60 * 1000

  const refresh = async () => {
    if (!routes.includeCatalog || cache.until > Date.now()) return cache
    if (refreshing) return refreshing
    refreshing = (async () => {
    const [catalog, proprietary, openweight] = await Promise.allSettled([
      getJSON(ENDPOINTS.catalog),
      getJSON(ENDPOINTS.proprietary),
      getJSON(ENDPOINTS.openweight),
    ])
    const gatewayBase = openweight.status === "fulfilled" ? normalizeBase(openweight.value?.base_url) || cache.gatewayBase : cache.gatewayBase
    const models = catalog.status === "fulfilled" ? modelsFromCatalog(catalog.value) ?? cache.models : cache.models
    const images = openweight.status === "fulfilled" ? imagesFromOpenweight(openweight.value) : cache.images
    const paid = proprietary.status === "fulfilled" ? proprietaryModels(proprietary.value) : cache.proprietary
    const failed = [catalog, proprietary, openweight].some(r => r.status === "rejected")
    if (failed) log("warn", "Some public catalogs are unavailable; keeping their last successful models")
    cache = {
      until: Date.now() + (failed ? 30000 : CATALOG_TTL),
      models,
      proprietary: paid,
      images,
      gatewayBase,
    }
    return cache
    })()
    try { return await refreshing } finally { refreshing = null }
  }

  const modelTable = async (auth) => {
    const cat = await refresh()
    const available = { ...(cat.models ?? {}), ...(cat.images ?? {}) }
    // Only a real proprietary list needs this optional permission lookup.
    // Manual models and public models never depend on a balance session.
    if (auth?.type === "api" && auth.key && Object.keys(cat.proprietary ?? {}).length) {
      try {
        const access = await readAccess(auth.key)
        if (access?.access?.state === "ok") Object.assign(available, cat.proprietary)
      } catch { log("warn", "Proprietary access lookup unavailable; other models remain usable") }
    }
    return routes.build(available, auth, cat.gatewayBase)
  }

  // Magpie passes its actual config directory, including portable installs.
  // Other hosts and unit tests do not start a local service.
  if (magpie && directory && globalThis.Bun) {
    try {
      await startDiagnosticService({ directory, modelTable, client: CLIENT, port: options.diagnosticsPort ?? 37747,
        legacyURL: (url, auth) => {
          const saved = parseBaseOverrides(auth.metadata?.requestBaseURL) ?? {}
          const base = normalizeBase(auth.metadata?.baseURL) || saved.baseURL || null
          const bases = normalizeBaseMap(auth.metadata?.baseURLs) || saved.baseURLs || null
          const override = baseFor(url, bases, base)
          return override ? rewriteRequest(url, override) : url
        },
      })
    } catch { log("warn", "Model diagnostics could not start; check whether its local port is already in use. Provider requests remain available.") }
  }

  return {
    // The provider. `config` runs before anyone signs in, so the models are
    // read here too: the picker has them before anyone has a key. The `provider`
    // hook reads them again per account, to add the proprietary models that
    // key's access allows.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "kunbot",
        npm: "@ai-sdk/openai-compatible",
        // There is no provider-wide address: every model carries the route
        // it is served from. Leaving this empty makes a model with no
        // address fail instead of quietly sending it to the status site.
        api: "",
        models: {},
      }
      try {
        const models = await modelTable()
        for (const [k, m] of Object.entries(models)) {
          if (!m?.provider?.api) {
            log("warn", `model ${k}: no base URL; skipped`)
            continue
          }
          // The catalog (and the models option) is the source of truth:
          // assign rather than ??=, so a changed base or type reaches the
          // provider config magpie saved from an earlier load.
          cfg.provider[PROVIDER].models[k] = m
        }
      } catch (e) {
        log("warn", `catalog unavailable: ${e?.message ?? e}`)
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 8,
      methods: [
        {
          type: "api",
          label: "kunbot API key",
          placeholder: "sk-...",
          prompts: [
            {
              type: "text",
              key: "email",
              message: "Account name",
              placeholder: "e.g. personal or work; optional",
              validate: (v) =>
                String(v ?? "").trim().length <= 64 ? undefined : "Keep the account name to 64 characters",
            },
          ],
          // No authorize: magpie then asks its own API key field, and the
          // answers above are kept as metadata. An authorize here would make
          // magpie 0.1.4xxx treat the prompts as asking the key (keyAsked)
          // and skip that field, leaving the sign-in with no key.
        },
      ],

      // Every request this account makes. The open-weight routes are
      // OpenAI-compatible and authenticate with a bearer token; the gateway
      // root takes the same key.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        // Deliberately no `baseURL`: magpie's loader base wins over every
        // model's `provider.api`, which would collapse the catalog's many
        // routes onto one address. The per-route overrides are applied per
        // request here instead, so each route keeps its own base.
        // Keep address overrides saved by older versions. New sign-ins only
        // collect the key and account name; addresses live in the plugin page.
        const saved = parseBaseOverrides(auth.metadata?.requestBaseURL) ?? {}
        const base = normalizeBase(auth.metadata?.baseURL) || saved.baseURL || null
        const bases = normalizeBaseMap(auth.metadata?.baseURLs) || saved.baseURLs || null
        return {
          async fetch(input, init) {
            const route = routeRequest(input)
            if (route) {
              const table = await modelTable(auth)
              const targets = table[route.key]?._targets
              if (!targets?.length) throw new Error(`No endpoints available for model ${route.key}`)
              return forwardRequest(input, init, { auth, client: CLIENT, targets, route, log: message => log("warn", message) })
            }
            const override = baseFor(input, bases, base)
            return forwardRequest(input, init, { auth, client: CLIENT, legacyURL: override ? rewriteRequest(input, override) : undefined })
          },
        }
      },

      // The proprietary allowance. Pt is a balance rather than a window, so it
      // is reported through `balance` and no windows are claimed. A key the
      // site does not know is reported as such instead of being shown as a
      // zero balance.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "Not signed in", windows: [] }

        // A key without Proprietary Access cannot use the paid models at all.
        // That is the single most useful thing to say about such a key, so it
        // is checked first and said plainly. The balance flow needs the key to
        // be known to the site, so a key the site has never seen is reported
        // as such rather than as a failure.
        let access
        try { access = await readAccess(auth.key) }
        catch { return { error: "The site's balance service is unavailable", windows: [] } }
        const state = access?.access?.state

        if (state === "anonymous" || state === "no_pma" || state === "revoked") {
          const why = {
            anonymous: "this key isn't registered with the site",
            no_pma: "this key has no Proprietary Access",
            revoked: "this key's Proprietary Access was revoked",
          }[state]
          return {
            user: access?.access?.key_masked,
            error: `No proprietary models: ${why}${access?.error ? ` (${access.error})` : ""}. The open-weight routes are unaffected.`,
            windows: [],
          }
        }

        const bal = access?.access?.balance
        const out = { user: access?.access?.key_masked, windows: [] }
        if (bal?.ok) {
          out.balance = `${num(bal.data)} Pt`
        } else if (bal?.status === 401) {
          out.balance = "not in ACL"
        }

        if (!out.balance && !out.windows.length) {
          out.error = access?.error || "The site did not report a balance or any proprietary model state."
        }
        return out
      },
    },

    // Each account discovers its own endpoint models. Manual declarations are
    // shared, but endpoint overrides and request credentials stay scoped.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        let models
        try {
          models = await modelTable(auth)
        } catch (e) {
          log("warn", `model list failed: ${e?.message ?? e}`)
          return provider.models
        }

        // The hook returns models in magpie's own shape, not the config
        // hook's: `api` carries the per-model address (id, url, npm), and
        // capabilities/cost are what this path reads. The config hook's
        // reasoning, tool_call, modalities and cache_read keys are ignored
        // here. Each model must therefore be converted, not just spread from
        // the first one.
        const template = Object.values(provider.models ?? {})[0]
        const out = {}
        for (const [key, m] of Object.entries(models)) {
          const model = hookModel(template, m)
          if (model.api.url) out[key] = model
          else log("warn", `model ${key}: no base URL; skipped`)
        }

        return out
      },
    },
  }
}

// Tests need these; the community convention is to hang them off one object
// so magpie does not mistake a helper for a plugin.
export const _internal = {
  modelsFromCatalog,
  proprietaryModels,
  imagesFromOpenweight,
  configuredModels,
  imageIdsFromNote,
  readAccess,
  normalizeBase,
  normalizeBaseMap,
  parseBaseOverrides,
  baseFor,
  rewriteRequest,
  hookModel,
}
