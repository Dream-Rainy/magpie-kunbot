// Classic script shared by the native sandbox and the service-hosted page.
;(() => {
  const FORMAT = "magpie-kunbot-config", LIMIT = 1024 * 1024
  const sdks = { chat: "@ai-sdk/openai-compatible", anthropic: "@ai-sdk/anthropic", responses: "@ai-sdk/openai", gemini: "@ai-sdk/google", systemone: "@ai-sdk/openai-compatible" }
  const kinds = new Set(["text", "chat", "vision", "image", "image-generation", "image generation", "img", "draw", "audio", "tts", "speech", "text-to-speech", "transcription", "transcribe", "asr", "stt", "speech-to-text", "video", "video-generation"])
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  const fail = (path, message) => { throw new Error(`${path}：${message}`) }
  const isObject = (value, path) => { if (!object(value)) fail(path, "需要 JSON 对象。") }
  const text = (value, path, empty = false) => {
    if (typeof value !== "string" || (!empty && !value.trim())) fail(path, "需要有效的文字内容。")
  }
  const number = (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path, "需要非负数值。")
  }
  const baseOf = value => value.base ?? value.base_url ?? value.url
  const npmOf = (value, fallback = sdks.chat) => value.npm ?? sdks[value.protocol] ?? fallback
  const decisionOf = (value, fallback = false) => value.protocol ? value.protocol === "systemone" : value.npm ? false : fallback
  function safeTree(value, path = "配置", depth = 0) {
    if (depth > 64) fail(path, "嵌套层级过多。")
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail(path, "包含不支持的对象属性。")
      safeTree(child, `${path}.${key}`, depth + 1)
    }
  }
  function url(value, path) {
    text(value, path)
    try {
      const parsed = new URL(value)
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error()
    } catch { fail(path, "需要完整的 http(s) 地址，且不包含密钥、查询参数或片段。") }
  }
  function suffix(value, path) {
    if (value == null) return
    text(value, path, true)
    const clean = value.trim().replace(/^\/+|\/+$/g, "")
    if (clean && !clean.split("/").every(part => /^[a-z0-9._~-]+$/i.test(part) && part !== "." && part !== "..")) fail(path, "只接受相对路径，如 7sref；不能使用完整网址、查询参数或空路径段。")
  }
  function address(value, path) {
    for (const field of ["base", "base_url", "url"]) if (value[field] !== undefined) url(value[field], `${path}.${field}`)
    if (value.protocol !== undefined && !Object.hasOwn(sdks, value.protocol)) fail(`${path}.protocol`, "请选择 chat、anthropic、responses、gemini 或 systemone，其他 SDK 请使用 npm 字段。")
    if (value.npm !== undefined) text(value.npm, `${path}.npm`)
    suffix(value.suffix, `${path}.suffix`)
  }
  function validate(options) {
    isObject(options, "配置"); safeTree(options)
    for (const field of ["routes", "endpoints", "models", "extraModels"]) if (options[field] !== undefined) isObject(options[field], field)
    if (options.includeCatalog !== undefined && typeof options.includeCatalog !== "boolean") fail("includeCatalog", "需要 true 或 false。")
    if (options.discoveryTimeoutMs !== undefined) number(options.discoveryTimeoutMs, "discoveryTimeoutMs")
    if (options.diagnosticsPort !== undefined && (!Number.isInteger(options.diagnosticsPort) || options.diagnosticsPort < 0 || options.diagnosticsPort > 65535)) fail("diagnosticsPort", "需要 0–65535 之间的整数。")
    const routes = { ...options.endpoints, ...options.routes }
    for (const [name, route] of Object.entries(routes)) {
      const path = `routes.${name}`
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) fail(path, "线路标识格式不正确。")
      isObject(route, path); address(route, path); url(baseOf(route), `${path}.base`)
      if (route.name !== undefined) text(route.name, `${path}.name`)
      if (route.discover !== undefined && typeof route.discover !== "boolean") fail(`${path}.discover`, "需要 true 或 false。")
      if (route.models_url !== undefined && route.models_url !== "") url(route.models_url, `${path}.models_url`)
    }
    if (options.fallback !== undefined) {
      if (!Array.isArray(options.fallback)) fail("fallback", "需要线路标识数组。")
      for (const name of options.fallback) if (typeof name !== "string" || !Object.hasOwn(routes, name)) fail("fallback", "包含不存在的线路。")
    }
    function model(raw, path) {
      const spec = typeof raw === "string" ? { type: raw } : raw
      isObject(spec, path); address(spec, path)
      for (const field of ["id", "key"]) if (spec[field] !== undefined) text(spec[field], `${path}.${field}`)
      if (spec.id && /[?？]/.test(spec.id)) fail(`${path}.id`, "请使用真实模型 ID。")
      if (spec.name !== undefined) text(spec.name, `${path}.name`, true)
      if (spec.type !== undefined && (typeof spec.type !== "string" || !kinds.has(spec.type.trim().toLowerCase()))) fail(`${path}.type`, "模型类型不支持。")
      for (const field of ["context", "output_limit"]) if (spec[field] !== undefined) {
        const value = typeof spec[field] === "string" ? Number.parseFloat(spec[field].replace(/[^\d.-]/g, "")) : spec[field]
        number(value, `${path}.${field}`)
      }
      for (const field of ["reasoning", "tool_call"]) if (spec[field] !== undefined && typeof spec[field] !== "boolean") fail(`${path}.${field}`, "需要 true 或 false。")
      for (const field of ["input", "output"]) if (spec[field] !== undefined && (!Array.isArray(spec[field]) || spec[field].some(item => !["text", "image", "audio", "video", "pdf"].includes(item)))) fail(`${path}.${field}`, "需要有效的模态数组。")
      for (const field of ["cost", "variants"]) if (spec[field] !== undefined) isObject(spec[field], `${path}.${field}`)
      if (spec.targets !== undefined && (!Array.isArray(spec.targets) || !spec.targets.length)) fail(`${path}.targets`, "需要至少一个候选线路。")
      const candidates = spec.targets ?? [{}], protocols = []
      for (const [index, candidate] of candidates.entries()) {
        const at = `${path}.targets[${index}]`
        isObject(candidate, at); address(candidate, at)
        if (candidate.id !== undefined) text(candidate.id, `${at}.id`)
        for (const [value, where] of [[spec.endpoint, `${path}.endpoint`], [candidate.endpoint, `${at}.endpoint`]]) {
          if (value !== undefined) {
            text(value, where, true)
            if (value && !Object.hasOwn(routes, value)) fail(where, "引用的线路不存在。")
          }
        }
        const endpoint = candidate.endpoint ?? spec.endpoint
        const route = endpoint ? routes[endpoint] : undefined
        if (spec.targets && !baseOf(candidate) && !baseOf(spec) && !route) fail(at, "需要线路或固定地址。")
        const decides = decisionOf(candidate, decisionOf(spec, route ? decisionOf(route) : false))
        protocols.push(`${decides ? "systemone:" : ""}${npmOf(candidate, npmOf(spec, route ? npmOf(route) : sdks.chat))}`)
      }
      if (protocols.some(protocol => protocol !== protocols[0])) fail(`${path}.targets`, "主备线路需要使用相同协议。")
    }
    const models = { ...(options.models ?? options.extraModels ?? {}) }
    for (const [name, route] of Object.entries(routes)) {
      if (route.models === undefined) continue
      if (!Array.isArray(route.models)) isObject(route.models, `routes.${name}.models`)
      const entries = Array.isArray(route.models) ? route.models.map(id => { text(id, `routes.${name}.models`); return [id, {}] }) : Object.entries(route.models)
      for (const [id, raw] of entries) {
        const spec = typeof raw === "string" ? { type: raw } : raw
        isObject(spec, `routes.${name}.models.${id}`)
        const key = spec.key ?? `${name}/${id}`
        text(key, `routes.${name}.models.${id}.key`)
        if (["__proto__", "constructor", "prototype"].includes(key)) fail("模型键", "包含不支持的对象属性。")
        if (!Object.hasOwn(models, key)) models[key] = { ...spec, id: spec.id ?? id, endpoint: name }
      }
    }
    for (const [key, raw] of Object.entries(models)) {
      text(key, "models 的模型键"); model(raw, `models.${key}`)
    }
    return { routes: Object.keys(routes).length, models: Object.keys(models).length, includeCatalog: options.includeCatalog ?? !Object.values(routes).some(route => route.discover) }
  }
  function checkSize(value) {
    if (new TextEncoder().encode(value).byteLength > LIMIT) throw new Error("配置不能超过 1 MiB。")
  }
  function encode(options, pluginVersion) {
    validate(options)
    const json = JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), pluginVersion, options }, null, 2)
    checkSize(json)
    return json
  }
  function decode(json) {
    if (typeof json !== "string") throw new Error("请粘贴 JSON 或选择 JSON 文件。")
    checkSize(json)
    let data
    try { data = JSON.parse(json.replace(/^\uFEFF/, "")) } catch { throw new Error("配置不是有效的 JSON。") }
    isObject(data, "配置"); safeTree(data)
    const wrapped = Object.hasOwn(data, "format") || (Object.hasOwn(data, "options") && Object.hasOwn(data, "version"))
    if (wrapped && data.format !== FORMAT) throw new Error("这不是 magpie-kunbot 的配置备份。")
    if (wrapped && data.version !== 1) throw new Error("不支持此备份格式版本，请使用兼容的插件版本。")
    const options = wrapped ? data.options : data
    const summary = validate(options)
    return { options, summary }
  }
  globalThis.KunbotConfigTransfer = Object.freeze({ encode, decode, validate, LIMIT })
})()
