// Complete API prefixes and ordered candidates live here. The private URL
// keeps a model's identity through Magpie's fetch hook, even when two models
// share an upstream id or use unrelated paths. It is never sent to the network.
const ORIGIN = "https://models.kunbot.invalid"
const SDK = {
  chat: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
  responses: "@ai-sdk/openai",
  gemini: "@ai-sdk/google",
  systemone: "@ai-sdk/openai-compatible",
}
const object = (v) => v && typeof v === "object" && !Array.isArray(v)
const specOf = (v) => typeof v === "string" ? { type: v } : object(v) ? v : {}
const fixedBase = (s) => s?.base ?? s?.base_url ?? s?.url
const baseURL = (raw) => {
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return ""
    return url.href.replace(/\/+$/, "")
  } catch { return "" }
}
const npmOf = (s, fallback = SDK.chat) => s?.npm ?? SDK[s?.protocol] ?? fallback
const decisionOf = (s, fallback = false) => s?.protocol ? s.protocol === "systemone" : s?.npm ? false : fallback
const compatible = (a, b) => a.npm === b.npm && (a.decides === true) === (b.decides === true)
const modelURL = (key) => `${ORIGIN}/m/${encodeURIComponent(key)}/v1`

// Keep in sync with the form's address preview. Only an explicit suffix opts
// into the protocol's versioned route convention; complete bases stay untouched.
function modelBase(base, rawSuffix, npm) {
  if (rawSuffix == null) return base
  if (typeof rawSuffix !== "string") throw new Error("Model suffix must be a relative path")
  const suffix = rawSuffix.trim().replace(/^\/+|\/+$/g, "")
  if (!suffix) return base
  if (!suffix.split("/").every(part => /^[a-z0-9._~-]+$/i.test(part) && part !== "." && part !== "..")) {
    throw new Error("Model suffix must contain path names only, without a URL, query, fragment or dot segments")
  }
  const google = npm === SDK.gemini
  const root = base.replace(google ? /\/v1(?:beta)?$/ : /\/v1$/, "")
  const versioned = google ? /(?:^|\/)v1(?:beta)?$/.test(suffix) : /(?:^|\/)v1$/.test(suffix)
  return `${root}/${suffix}${versioned ? "" : google ? "/v1beta" : "/v1"}`
}

export function routeRequest(input) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== ORIGIN) return null
  const match = /^\/m\/([^/]+)\/v1(\/.*)?$/.exec(url.pathname)
  if (!match) throw new Error("Invalid kunbot model address")
  return { key: decodeURIComponent(match[1]), path: match[2] || "", search: url.search }
}

export function endpointOverrides(auth) {
  const raw = auth?.metadata?.endpointBaseURLs
  const out = Object.create(null)
  const entries = object(raw) ? Object.entries(raw) : String(raw ?? "").split(/[,;\n]+/).filter(s => s.trim()).map(s => {
    const eq = s.indexOf("=")
    return eq < 1 ? ["", ""] : [s.slice(0, eq).trim(), s.slice(eq + 1).trim()]
  })
  for (const [name, value] of entries) {
    const base = baseURL(value)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !base) throw new Error("Endpoint Base URLs must contain name=full API URL pairs")
    out[name] = base
  }
  return out
}

export function createRoutes(options, configure, log = () => {}) {
  const definitions = { ...(object(options.endpoints) ? options.endpoints : {}), ...(object(options.routes) ? options.routes : {}) }
  const endpoints = Object.create(null)
  for (const [name, raw] of Object.entries(definitions)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !object(raw) || !baseURL(fixedBase(raw))) {
      throw new Error(`Invalid endpoint: ${name}`)
    }
    endpoints[name] = { ...raw, base: baseURL(fixedBase(raw)), npm: npmOf(raw), decides: decisionOf(raw) }
    if (raw.models_url && !baseURL(raw.models_url)) throw new Error(`Invalid models URL: ${name}`)
  }
  const order = [...new Set([...(Array.isArray(options.fallback) ? options.fallback : []), ...Object.keys(endpoints)])]
  const specs = { ...(object(options.models ?? options.extraModels) ? options.models ?? options.extraModels : {}) }
  // Grouped routes remain available for existing or advanced configurations.
  for (const [name, endpoint] of Object.entries(endpoints)) {
    const entries = Array.isArray(endpoint.models) ? endpoint.models.map(id => [id, {}]) : Object.entries(endpoint.models ?? {})
    for (const [id, raw] of entries) {
      const spec = specOf(raw)
      const key = spec.key ?? `${name}/${id}`
      if (!Object.hasOwn(specs, key)) specs[key] = { ...spec, id: spec.id ?? id, endpoint: name }
    }
  }
  const includeCatalog = options.includeCatalog ?? !Object.values(endpoints).some(e => e.discover)
  const cache = new Map()
  const timeout = Number.isFinite(options.discoveryTimeoutMs) ? Math.min(30000, Math.max(100, options.discoveryTimeoutMs)) : 8000

  const resolve = (target, spec, auth, id, fallbackNpm, fallbackDecision) => {
    const name = target.endpoint ?? spec.endpoint
    const endpoint = name ? endpoints[name] : null
    if (name && !endpoint) throw new Error(`Unknown endpoint: ${name}`)
    const base = fixedBase(target) ?? fixedBase(spec) ?? (name ? endpointOverrides(auth)[name] : null) ?? endpoint?.base
    if (!baseURL(base)) throw new Error(`No complete API URL for model ${id}`)
    const npm = npmOf(target, npmOf(spec, endpoint?.npm ?? fallbackNpm))
    const decides = decisionOf(target, decisionOf(spec, endpoint?.decides ?? fallbackDecision))
    return {
      endpoint: name || "fixed", base: modelBase(baseURL(base), target.suffix ?? spec.suffix, npm), id: String(target.id ?? id),
      npm, ...(decides ? { decides: true } : {}),
    }
  }

  const discover = async (name, auth) => {
    const endpoint = endpoints[name]
    const base = endpointOverrides(auth)[name] ?? endpoint.base
    // A per-account override also moves the default discovery URL. An explicit
    // models_url is an intentional independent catalog location.
    const url = endpoint.models_url || `${base}/models`
    const key = JSON.stringify([auth.key, name, base, url])
    const hit = cache.get(key)
    if (hit?.pending) return hit.pending
    if (hit?.until > Date.now()) return hit.models
    const entry = hit ?? { models: [] }
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value)
    entry.pending = (async () => {
      try {
        const google = endpoint.npm === SDK.gemini, signal = AbortSignal.timeout(timeout), models = []
        const headers = { accept: "application/json" }
        if (google) headers["x-goog-api-key"] = auth.key
        else {
          headers.authorization = `Bearer ${auth.key}`
          if (!endpoint.decides) Object.assign(headers, { "x-api-key": auth.key, "anthropic-version": "2023-06-01" })
        }
        let page = url
        do {
          const res = await fetch(page, { headers, signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (Array.isArray(data?.data)) models.push(...data.data)
          else if (google && Array.isArray(data?.models)) {
            models.push(...data.models.filter(m => typeof m?.name === "string" && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.some(method => method === "generateContent" || method === "streamGenerateContent"))).map(m => ({
              ...m, id: m.name?.replace(/^models\//, ""), name: m.displayName ?? m.name?.replace(/^models\//, ""),
              context_window: m.inputTokenLimit, max_output_tokens: m.outputTokenLimit,
            })))
          } else throw new Error("Expected a data[] or Gemini models[] model list")
          page = ""
          if (google && typeof data.nextPageToken === "string" && data.nextPageToken) {
            const next = new URL(url); next.searchParams.set("pageToken", data.nextPageToken); page = next.href
          }
        } while (page)
        entry.models = models.filter(m => typeof m?.id === "string" && m.id.trim()).map(m => ({
          ...m, id: m.id.trim(), target: { endpoint: name, base, npm: endpoint.npm, id: m.id.trim(), ...(endpoint.decides ? { decides: true } : {}) },
        }))
        entry.until = Date.now() + 300000
      } catch (e) {
        entry.until = Date.now() + 30000
        log(`endpoint ${name}: model discovery failed (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? "network error"}); keeping last list`)
      } finally { delete entry.pending }
      return entry.models
    })()
    return entry.pending
  }

  async function build(catalog = {}, auth, gatewayBase = "") {
    const out = { ...(includeCatalog ? catalog : {}) }
    const known = new Map(Object.entries(catalog).map(([key, m]) => [m.id, { key, model: m }]))
    const lists = auth?.type === "api" && auth.key
      ? await Promise.all(order.filter(name => endpoints[name]?.discover).map(name => discover(name, auth))) : []
    const grouped = new Map()
    for (const list of lists) for (const m of list) {
      const group = grouped.get(m.id)
      if (!group) grouped.set(m.id, { model: m, targets: [m.target] })
      else if (compatible(group.targets[0], m.target)) group.targets.push(m.target)
      else log(`model ${m.id}: endpoint ${m.target.endpoint} uses a different protocol; skipped as fallback`)
    }
    for (const [id, { model, targets }] of grouped) {
      const previous = known.get(id)
      const key = previous && includeCatalog ? previous.key : id
      // When a configured endpoint exposes a known model, retain its metadata
      // and show one selectable entry for that upstream id.
      if (includeCatalog) for (const [k, m] of Object.entries(out)) if (m.id === id) delete out[k]
      const seed = previous?.model ? { [key]: previous.model } : {}
      const configured = configure(seed, { [key]: {
        id, name: model.name ?? model.display_name ?? previous?.model?.name ?? id,
        base: targets[0].base, npm: targets[0].npm,
        ...(Number.isFinite(model.context_window) ? { context: model.context_window } : {}),
        ...(Number.isFinite(model.max_output_tokens) ? { output_limit: model.max_output_tokens } : {}),
        ...(!previous ? { type: "text" } : {}),
      } }, "", log)
      out[key] = { ...configured[key], _targets: targets }
    }

    // Apply each manual override once, after the public lists have been merged.
    for (const [key, raw] of Object.entries(specs)) {
      const spec = specOf(raw)
      const prev = out[key]
      const id = spec.id ?? prev?.id ?? (key.includes("/") ? key.slice(key.indexOf("/") + 1) : key)
      let targets = prev?._targets
      const explicit = fixedBase(spec) !== undefined || spec.endpoint || spec.targets
      if (explicit) {
        if (spec.targets && (!Array.isArray(spec.targets) || !spec.targets.length)) throw new Error(`model ${key}: targets must not be empty`)
        targets = (spec.targets ?? [{}]).map(t => resolve(t, spec, auth, id, prev?.provider?.npm ?? SDK.chat, prev?.decides))
        if (targets.some(t => !compatible(t, targets[0]))) throw new Error(`model ${key}: fallback targets must use the same protocol`)
      } else if (targets && (spec.id !== undefined || spec.npm || spec.protocol || spec.suffix != null)) {
        targets = targets.map(t => ({ ...t, base: modelBase(t.base, spec.suffix, npmOf(spec, t.npm)), id: String(spec.id ?? t.id), npm: npmOf(spec, t.npm), decides: decisionOf(spec, t.decides) }))
      } else if (modelBase("", spec.suffix)) {
        throw new Error(`model ${key}: a suffix needs an endpoint or a fixed base URL`)
      }
      const overrides = { ...spec, ...(targets ? { base: targets[0].base, npm: targets[0].npm, id: targets[0].id } : {}) }
      const configured = configure(out, { [key]: overrides }, gatewayBase, log)
      if (configured[key]) out[key] = { ...configured[key], ...(targets ? { _targets: targets } : {}) }
    }
    for (const [key, model] of Object.entries(out)) {
      if (model._targets) out[key] = { ...model, decides: model._targets[0].decides === true, provider: { ...model.provider, api: modelURL(key) } }
    }
    return out
  }
  const hasDecision = Object.values(endpoints).some(e => e.decides) || Object.values(specs).some(raw => {
    const s = specOf(raw)
    return decisionOf(s) || s.targets?.some(t => decisionOf(t))
  })
  return { build, includeCatalog, hasDiscovery: Object.values(endpoints).some(e => e.discover), hasDecision }
}

// Buffer once so every candidate gets the same body. Request construction
// preserves URL/Request inputs, headers, method, multipart boundary and abort.
// A successful response is returned immediately; we never splice live streams.
export async function forwardRequest(input, init, { auth, client, targets, route, legacyURL, log = () => {}, trace, preview = false }) {
  const request = new Request(input, init)
  const signal = request.signal
  signal.throwIfAborted()
  const body = request.body ? await request.arrayBuffer() : undefined
  const headers = new Headers(request.headers)
  headers.set("authorization", `Bearer ${auth.key}`)
  headers.set("x-api-key", auth.key)
  headers.set("x-kunbot-client", client)
  headers.delete("host")
  headers.delete("content-length")
  const candidates = targets ?? [{ url: legacyURL ?? request.url }]
  for (let index = 0; index < candidates.length; index++) {
    signal.throwIfAborted()
    const candidate = candidates[index]
    const google = candidate.npm === SDK.gemini
    let path = route?.path
    const method = google && /^\/models\/.+:(\w+)$/.exec(path)
    if (method && candidate.id) path = `/models/${encodeURIComponent(candidate.id.replace(/^models\//, ""))}:${method[1]}`
    const url = candidate.url ?? `${candidate.base}${path}${route.search}`
    let payload = body
    const sentHeaders = new Headers(headers)
    if (google) {
      sentHeaders.set("x-goog-api-key", auth.key)
      for (const name of ["authorization", "x-api-key", "anthropic-version"]) sentHeaders.delete(name)
    } else if (candidate.decides) {
      for (const name of ["x-api-key", "x-goog-api-key", "anthropic-version"]) sentHeaders.delete(name)
    }
    if (candidate.id && body) {
      const contentType = headers.get("content-type") ?? ""
      if (contentType.includes("json")) {
        const json = JSON.parse(new TextDecoder().decode(body))
        if (google) delete json.model
        else json.model = candidate.id
        payload = JSON.stringify(json)
      } else if (contentType.includes("multipart/form-data")) {
        const form = await new Response(body, { headers }).formData()
        form.set("model", candidate.id)
        payload = form
        sentHeaders.delete("content-type")
      } else if (candidates.length > 1) {
        throw new Error("Cannot switch model ids in this request body format")
      }
    }
    const next = index + 1 < candidates.length
    // Diagnostics use this same prepared request, after the upstream model id
    // and headers have been applied. Normal requests have no tracing overhead.
    const attempt = trace ? { endpoint: candidate.endpoint ?? "catalog", url, method: request.method, headers: sentHeaders, body: payload } : undefined
    if (preview) { if (trace) await trace({ ...attempt, preview: true }); continue }
    const started = Date.now()
    let response
    try {
      response = await fetch(url, {
        method: request.method, headers: sentHeaders, body: payload, signal,
        redirect: request.redirect, credentials: request.credentials, cache: request.cache,
      })
    } catch (e) {
      if (trace) await trace({ ...attempt, error: e, elapsedMs: Date.now() - started })
      if (signal.aborted || e?.name === "AbortError" || !next) throw e
      log(`endpoint ${candidate.endpoint}: network failure; trying next endpoint`)
      continue
    }
    if (trace) await trace({ ...attempt, response, elapsedMs: Date.now() - started })
    if (next && (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600))) {
      log(`endpoint ${candidate.endpoint}: HTTP ${response.status}; trying next endpoint`)
      await response.body?.cancel().catch(() => {})
      continue
    }
    return response
  }
  if (preview) return new Response(null, { status: 204 })
  throw new Error("No endpoint available for this model")
}

export const _routing = { baseURL, modelURL, npmOf, modelBase }
