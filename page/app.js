// Classic external script: module scripts require CORS in Magpie's opaque
// iframe origin. The host can also inline this file with a CSP hash in web mode.
;(async () => {
const $ = (id) => document.getElementById(id)
const protocolLabels = { chat: "OpenAI Chat", anthropic: "Anthropic Messages", responses: "OpenAI Responses", gemini: "Gemini 原生 API", systemone: "System One 决策 API" }
const sdks = { chat: "@ai-sdk/openai-compatible", anthropic: "@ai-sdk/anthropic", responses: "@ai-sdk/openai", gemini: "@ai-sdk/google", systemone: "@ai-sdk/openai-compatible" }
const types = { text: "文字对话", vision: "文字 + 看图", image: "图像生成", audio: "语音合成", transcription: "语音转写", video: "视频生成" }
const clone = (v) => structuredClone(v)
const object = (v) => v && typeof v === "object" && !Array.isArray(v)
const specOf = (v) => typeof v === "string" ? { type: v } : object(v) ? clone(v) : {}
let original = {}, routeRows = [], modelRows = [], saving = false, dirty = false, loaded = false
let pendingImport, importGeneration = 0, readingFile = false
const transfer = window.KunbotConfigTransfer
const transferStatus = (message, kind = "") => { $("transfer-status").textContent = message; $("transfer-status").className = `hint ${kind}` }
function resetTransfer() {
  importGeneration++; readingFile = false; pendingImport = undefined
  for (const id of ["export-panel", "import-panel", "import-preview"]) $(id).hidden = true
  for (const id of ["export-text", "import-text", "import-file"]) $(id).value = ""
  $("preview-import").disabled = false
  transferStatus("")
}
function invalidateImport() { pendingImport = undefined; $("import-preview").hidden = true }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
    else if (value !== undefined && value !== null) node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}
function markDirty() {
  dirty = true
  $("save-state").textContent = "有未保存的修改"
  $("status").textContent = "修改后点击保存。"
  $("status").className = ""
}
function field(label, value, change, attrs = {}) {
  const input = el("input", { ...attrs, "aria-label": label, oninput: () => { change(input.value); markDirty() } })
  input.value = value ?? ""
  return el("label", { class: "field" }, [el("span", { text: label }), input])
}
function select(label, value, choices, change) {
  const input = el("select", { "aria-label": label, onchange: () => { change(input.value); markDirty() } })
  for (const [key, text] of Object.entries(choices)) input.append(el("option", { value: key, text }))
  if (value && !Object.hasOwn(choices, value)) input.append(el("option", { value, text: `现有设置：${value}` }))
  input.value = value ?? ""
  return el("label", { class: "field" }, [el("span", { text: label }), input])
}
function check(label, value, change, hint) {
  const input = el("input", { type: "checkbox", onchange: () => { change(input.checked); markDirty() } })
  input.checked = !!value
  return el("label", { class: "check" }, [input, el("span", { text: label }), ...(hint ? [el("span", { class: "hint", text: hint })] : [])])
}
function button(text, fn, attrs = {}) { return el("button", { type: "button", text, onclick: fn, ...attrs }) }
function status(text, kind = "") { $("status").textContent = text; $("status").className = kind }
function newRouteID() {
  for (const id of ["main", "backup", ...Array.from({ length: routeRows.length + 1 }, (_, i) => `route-${i + 3}`)]) {
    if (!routeRows.some(r => r.id === id)) return id
  }
}
function protocolOf(s) { return s.protocol ?? Object.keys(sdks).find(k => sdks[k] === s.npm) ?? (s.npm || "chat") }

function load(options) {
  original = clone(options)
  const definitions = { ...(options.endpoints ?? {}), ...(options.routes ?? {}) }
  const order = [...new Set([...(options.fallback ?? []), ...Object.keys(definitions)])]
  routeRows = order.filter(id => definitions[id]).map(id => {
    const s = definitions[id]
    return { id, name: s.name ?? id, base: s.base ?? s.base_url ?? s.url ?? "", protocol: protocolOf(s), discover: s.discover === true, modelsURL: s.models_url ?? "", raw: clone(s) }
  })
  modelRows = []
  const addModel = (key, raw, source) => {
    const s = specOf(raw), targets = s.targets ?? []
    let endpoint = s.endpoint ?? targets[0]?.endpoint ?? ""
    const base = s.base ?? s.base_url ?? s.url
    // Fixed-base overrides and legacy type-only overrides are preserved as-is
    // unless the user explicitly selects a named route in the form.
    // A candidate's id may differ from the model's default id. Keeping those
    // separate also preserves backup candidates which inherit the default.
    const id = String(s.id ?? (key.includes("/") ? key.slice(key.indexOf("/") + 1) : key))
    modelRows.push({ key, id, name: s.name ?? "", type: s.type ?? "", suffix: s.suffix ?? "", endpoint, backup: targets[1]?.endpoint ?? "", raw: s, source, fixed: base, changedRouting: false })
  }
  for (const [key, s] of Object.entries(options.models ?? options.extraModels ?? {})) addModel(key, s, "models")
  for (const route of routeRows) {
    const entries = Array.isArray(route.raw.models) ? route.raw.models.map(id => [id, {}]) : Object.entries(route.raw.models ?? {})
    for (const [id, raw] of entries) {
      const s = specOf(raw), key = s.key ?? `${route.id}/${id}`
      if (!modelRows.some(m => m.key === key)) addModel(key, { ...s, id: s.id ?? id, endpoint: route.id }, "route")
    }
  }
  $("include-catalog").checked = options.includeCatalog ?? !routeRows.some(r => r.discover)
  dirty = false
  resetTransfer()
  render()
}

function renderRoutes() {
  $("routes").replaceChildren(...routeRows.map((r, index) => {
    const title = el("strong", { text: r.name || "新线路" })
    const actions = el("div", { class: "actions" }, [
      button("↑", () => moveRoute(index, -1), { "aria-label": `上移 ${r.name}`, ...(index === 0 ? { disabled: "" } : {}) }),
      button("↓", () => moveRoute(index, 1), { "aria-label": `下移 ${r.name}`, ...(index === routeRows.length - 1 ? { disabled: "" } : {}) }),
      button("移除", () => {
        if (modelRows.some(m => m.endpoint === r.id || m.backup === r.id || m.raw.targets?.some(t => t.endpoint === r.id))) {
          status("这条线路仍被手动模型使用，请先调整模型的线路。", "error"); return
        }
        routeRows.splice(index, 1); markDirty(); render()
      }, { class: "remove", "aria-label": `移除线路 ${r.name}` }),
    ])
    const fields = el("div", { class: "fields" }, [
      field("线路名称", r.name, v => { r.name = v; title.textContent = v || "新线路"; renderModels() }, { placeholder: "主线 / 备线 / 专有" }),
      field("完整 Base URL", r.base, v => { r.base = v; renderModels() }, { type: "url", placeholder: "https://ant.kunbot.org 或完整 API 前缀", spellcheck: "false" }),
      select("接口协议", r.protocol, protocolLabels, v => { r.protocol = v; render() }),
    ])
    const details = el("details", {}, [el("summary", { text: "目录地址与线路标识" }),
      field("模型目录地址（可选，默认 Base URL + /models）", r.modelsURL, v => { r.modelsURL = v }, { class: "wide", placeholder: "https://api.example.com/v1/models", type: "url" }),
      el("p", { class: "hint", text: `线路标识：${r.id}` }),
    ])
    const protocolHint = r.protocol === "systemone" ? "此线路的模型将作为路由组的决策分类器，不用于普通对话。填写 API 前缀，插件会追加 /systemone。"
      : r.protocol === "gemini" ? "填写 Gemini 完整 API 前缀（通常以 /v1beta 结尾），使用原生 generateContent 接口。" : ""
    return el("article", { class: "card", "data-route": r.id }, [
      el("div", { class: "card-head" }, [el("div", { class: "card-title" }, [el("span", { class: `badge ${index === 0 ? "first" : ""}`, text: `${index + 1}${index === 0 ? " · 优先" : ""}` }), title]), actions]),
      fields, ...(protocolHint ? [el("p", { class: "hint", text: protocolHint })] : []),
      check("自动发现模型", r.discover, v => { r.discover = v }, "通过当前账号获取 /models 目录"), details,
    ])
  }))
}
function moveRoute(index, step) { [routeRows[index], routeRows[index + step]] = [routeRows[index + step], routeRows[index]]; markDirty(); render() }

// Same path rules as lib/routing.mjs; preview uses default route addresses,
// while the backend applies any account-specific override before joining.
function validSuffix(raw) {
  if (typeof raw !== "string") throw new Error("模型后缀需要填写相对路径。")
  const suffix = raw.trim().replace(/^\/+|\/+$/g, "")
  if (suffix && !suffix.split("/").every(part => /^[a-z0-9._~-]+$/i.test(part) && part !== "." && part !== "..")) {
    throw new Error("模型后缀只填写路径名称，如 7sref；不能包含完整网址、查询参数、空路径段或 . / ..。")
  }
  return suffix
}
function previewAddresses(m, node) {
  try {
    const targets = m.changedRouting || !m.key
      ? [m.endpoint, m.backup].filter(Boolean).map(endpoint => ({ endpoint }))
      : m.raw.targets ?? [{ endpoint: m.endpoint }]
    const lines = targets.map(target => {
      const route = routeRows.find(r => r.id === (target.endpoint ?? m.endpoint))
      const base = target.base ?? target.base_url ?? target.url ?? (!m.changedRouting ? m.fixed : undefined) ?? route?.base
      if (!base) return null
      const suffix = validSuffix(target.suffix ?? m.suffix)
      const cleanBase = validURL(base, "线路地址")
      const npm = target.npm ?? sdks[target.protocol] ?? m.raw.npm ?? sdks[m.raw.protocol] ?? sdks[route?.protocol] ?? route?.protocol
      const google = npm === sdks.gemini
      const root = cleanBase.replace(google ? /\/v1(?:beta)?$/ : /\/v1$/, "")
      const versioned = google ? /(?:^|\/)v1(?:beta)?$/.test(suffix) : /(?:^|\/)v1$/.test(suffix)
      const address = suffix ? `${root}/${suffix}${versioned ? "" : google ? "/v1beta" : "/v1"}` : cleanBase
      return el("div", { class: "address-line" }, [el("span", { text: route?.name || "固定地址" }), el("code", { text: address })])
    }).filter(Boolean)
    node.replaceChildren(...(lines.length ? [el("p", { class: "hint", text: "默认 API 前缀" }), ...lines] : [el("p", { class: "hint", text: "选择线路后显示地址；已有目录模型可保留目录地址。" })]))
  } catch (e) { node.replaceChildren(el("p", { class: "hint", text: e.message })) }
}

function renderModels() {
  const choices = Object.fromEntries(routeRows.map(r => [r.id, r.name || r.id]))
  $("models").replaceChildren(...modelRows.map((m, index) => {
    const title = el("strong", { text: m.name || m.id || "新模型" })
    const primaryChoices = { "": m.fixed ? `保留固定地址：${m.fixed}` : m.raw.targets?.length ? "保留高级线路配置" : m.key ? "保留目录地址" : "选择线路", ...choices }
    const fields = el("div", { class: "fields model-fields" }, [
      field("真实模型 ID", m.id, v => { m.id = v; if (m.raw.targets?.[0]?.id !== undefined) m.raw.targets[0].id = v; title.textContent = m.name || v || "新模型" }, { placeholder: "填写上游真实 ID", spellcheck: "false" }),
      field("显示名称（可选）", m.name, v => { m.name = v; title.textContent = v || m.id || "新模型" }, { placeholder: "方便识别的名称" }),
      select("模型类型", m.type, { "": "保留目录能力", ...types }, v => { m.type = v }),
    ])
    const compatible = Object.fromEntries(routeRows.filter(r => r.id !== m.endpoint && r.protocol === routeRows.find(r => r.id === m.endpoint)?.protocol).map(r => [r.id, r.name || r.id]))
    const addresses = el("div", { class: "model-addresses", "data-address-preview": "", "aria-live": "polite" })
    const routing = el("div", { class: "fields model-routing" }, [
      select("主线路", m.endpoint, primaryChoices, v => { m.endpoint = v; m.changedRouting = true; if (m.backup === v) m.backup = ""; renderModels() }),
      select("备用线路（可选）", m.backup, { "": "不设置", ...compatible }, v => { m.backup = v; m.changedRouting = true; previewAddresses(m, addresses) }),
      field("模型路径后缀（可选）", m.suffix, v => { m.suffix = v; previewAddresses(m, addresses) }, { placeholder: "例如 7sref、omni、salt", spellcheck: "false" }),
    ])
    previewAddresses(m, addresses)
    const advanced = el("details", {}, [el("summary", { text: "模型能力（可选）" }), el("div", { class: "fields" }, [
      field("上下文长度", m.raw.context, v => { if (v) m.raw.context = Number(v); else delete m.raw.context }, { type: "number", min: "0", placeholder: "沿用目录" }),
      field("最大输出", m.raw.output_limit, v => { if (v) m.raw.output_limit = Number(v); else delete m.raw.output_limit }, { type: "number", min: "0", placeholder: "沿用目录" }),
      select("推理能力", m.raw.reasoning === undefined ? "" : String(m.raw.reasoning), { "": "沿用目录", true: "支持", false: "不支持" }, v => { if (v) m.raw.reasoning = v === "true"; else delete m.raw.reasoning }),
    ]), ...(m.raw.targets?.length > 2 ? [el("p", { class: "hint", text: "此模型有多条高级候选线路；未修改线路选择时会完整保留。" })] : []), ...(m.raw.targets?.some(t => t.suffix != null) ? [el("p", { class: "hint", text: "高级候选中单独指定的后缀优先于模型后缀；修改主备选择会重新生成候选。" })] : [])])
    return el("article", { class: "card", "data-model": index }, [
      el("div", { class: "card-head" }, [el("div", { class: "card-title" }, [el("span", { class: "badge", text: types[m.type] ?? "模型" }), title]), el("div", { class: "actions" }, [button("移除", () => { modelRows.splice(index, 1); markDirty(); render() }, { class: "remove", "aria-label": `移除模型 ${m.id}` })])]),
      fields, routing, el("p", { class: "hint suffix-hint", text: "后缀按协议补齐版本：Gemini 为 /v1beta，其他为 /v1。留空使用线路完整地址。" }), addresses, advanced,
    ])
  }))
}
function render() {
  renderRoutes(); renderModels()
  $("route-empty").hidden = routeRows.length > 0
  $("model-empty").hidden = modelRows.length > 0
  $("route-count").textContent = `${routeRows.length} 条线路`
  $("model-count").textContent = `${modelRows.length} 个手动模型`
}
function validURL(raw, label) {
  try {
    const url = new URL(raw.trim())
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw Error()
    return url.href.replace(/\/+$/, "")
  } catch { throw new Error(`${label}需要完整的 http(s) 地址，且不包含密钥、查询参数或片段。`) }
}
function serialize() {
  const out = clone(original), routes = {}, models = {}
  for (const r of routeRows) {
    if (!r.name.trim()) throw new Error("请填写线路名称。")
    const s = { ...r.raw, name: r.name.trim(), base: validURL(r.base, `线路“${r.name}”的地址`), discover: r.discover }
    delete s.base_url; delete s.url; delete s.models
    if (sdks[r.protocol]) { s.protocol = r.protocol; delete s.npm }
    else { s.npm = r.protocol; delete s.protocol }
    if (r.modelsURL.trim()) s.models_url = validURL(r.modelsURL, "模型目录地址")
    else delete s.models_url
    routes[r.id] = s
  }
  const identities = new Set()
  for (const m of modelRows) {
    if (!m.id.trim() || /[?？]/.test(m.id)) throw new Error("请填写真实模型 ID，不能使用带问号的脱敏名称。")
    if (!m.key && !m.endpoint) throw new Error(`请为模型“${m.id}”选择线路。`)
    if (m.endpoint && !routes[m.endpoint]) throw new Error(`模型“${m.id}”的线路不存在。`)
    if (m.backup && (!routes[m.backup] || !m.endpoint || m.backup === m.endpoint)) throw new Error(`请检查模型“${m.id}”的备用线路。`)
    if (m.backup && routeRows.find(r => r.id === m.backup)?.protocol !== routeRows.find(r => r.id === m.endpoint)?.protocol) throw new Error(`模型“${m.id}”的主备线路需要使用相同协议。`)
    const key = m.key || `manual/${m.type === "audio" ? "tts-" : m.type === "transcription" ? "transcribe-" : ""}${m.id.trim()}`
    if (identities.has(key)) throw new Error(`模型“${m.id}”重复，请在同一个模型上选择主备线路。`)
    identities.add(key)
    const s = { ...m.raw, id: m.id.trim() }
    if (m.name.trim()) s.name = m.name.trim(); else delete s.name
    if (m.type) s.type = m.type; else delete s.type
    const suffix = validSuffix(m.suffix)
    if (suffix) {
      if (!m.endpoint && !m.fixed && !m.raw.targets?.length) throw new Error(`请为模型“${m.id}”选择线路后再设置后缀。`)
      s.suffix = suffix
    } else delete s.suffix
    if (m.changedRouting || !m.key) {
      delete s.targets; delete s.endpoint; delete s.base; delete s.base_url; delete s.url
      if (m.endpoint) {
        if (m.backup) s.targets = [{ endpoint: m.endpoint }, { endpoint: m.backup }]
        else s.endpoint = m.endpoint
      }
    }
    models[key] = s
  }
  out.routes = routes; out.models = models; out.fallback = routeRows.map(r => r.id)
  out.includeCatalog = $("include-catalog").checked
  delete out.endpoints; delete out.extraModels
  return out
}

$("add-route").addEventListener("click", () => {
  const id = newRouteID()
  routeRows.push({ id, name: id === "main" ? "主线" : id === "backup" ? "备线" : "新线路", base: "", protocol: "chat", discover: false, modelsURL: "", raw: {} })
  markDirty(); render(); $("routes").lastElementChild.querySelector('input[type="url"]').focus()
})
$("add-model").addEventListener("click", () => {
  modelRows.push({ key: "", id: "", name: "", type: "text", suffix: "", endpoint: routeRows[0]?.id ?? "", backup: "", raw: {}, changedRouting: true })
  markDirty(); render(); $("models").lastElementChild.querySelector("input").focus()
})
$("include-catalog").addEventListener("change", markDirty)
$("export-config").addEventListener("click", () => {
  if (!loaded || saving) return
  try {
    const json = transfer.encode(serialize(), "0.4.0")
    resetTransfer(); $("export-panel").hidden = false; $("export-text").value = json
    transferStatus("已生成当前表单的备份；导出不会保存配置。", "success")
  } catch (e) { transferStatus(e.message, "error") }
})
$("import-config").addEventListener("click", () => {
  if (!loaded || saving) return
  resetTransfer(); $("import-panel").hidden = false; $("import-text").focus()
  transferStatus("粘贴或选择 JSON 文件，再点击预览导入。")
})
$("close-export").addEventListener("click", resetTransfer)
$("cancel-import").addEventListener("click", resetTransfer)
$("select-export").addEventListener("click", () => {
  $("export-text").focus(); $("export-text").select()
  transferStatus("已全选，请按 Ctrl+C（Mac 为 ⌘C）复制。")
})
$("copy-export").addEventListener("click", async () => {
  const json = $("export-text").value
  try {
    if (!navigator.clipboard?.writeText) throw Error()
    await navigator.clipboard.writeText(json)
    transferStatus("已复制配置 JSON。", "success")
  } catch {
    $("export-text").focus(); $("export-text").select()
    let copied = false
    try { copied = document.execCommand("copy") } catch {}
    transferStatus(copied ? "已复制配置 JSON。" : "已选中 JSON，请按 Ctrl+C（Mac 为 ⌘C）复制。", copied ? "success" : "")
  }
})
$("import-text").addEventListener("input", () => {
  importGeneration++; readingFile = false; $("preview-import").disabled = false
  invalidateImport(); transferStatus("内容已修改，请重新预览。")
})
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0]
  $("import-file").value = ""
  if (!file || saving || !loaded) return
  const generation = ++importGeneration
  invalidateImport(); readingFile = true; $("preview-import").disabled = true
  transferStatus("正在读取文件…")
  try {
    if (file.size > transfer.LIMIT) throw new Error("配置文件不能超过 1 MiB。")
    const json = await file.text()
    if (generation !== importGeneration || saving) return
    $("import-text").value = json
    transferStatus("文件已读取，请点击预览导入。")
  } catch (e) { if (generation === importGeneration) transferStatus(e.message || "文件读取失败。", "error") }
  finally { if (generation === importGeneration) { readingFile = false; $("preview-import").disabled = false } }
})
$("preview-import").addEventListener("click", () => {
  if (!loaded || saving || readingFile) return
  invalidateImport()
  try {
    const result = transfer.decode($("import-text").value)
    pendingImport = result.options
    $("import-summary").textContent = `${result.summary.routes} 条线路 · ${result.summary.models} 个手动模型 · 公共目录${result.summary.includeCatalog ? "开启" : "关闭"}`
    $("import-preview").hidden = false
    transferStatus("校验通过，尚未修改编辑区或已保存配置。", "success")
  } catch (e) { transferStatus(e.message, "error") }
})
$("apply-import").addEventListener("click", () => {
  if (!loaded || saving || readingFile || !pendingImport) return
  load(pendingImport); markDirty()
  status("已载入导入草稿，检查后点击保存配置。")
  transferStatus("已替换编辑区，尚未保存。", "success")
})
$("open-tests").addEventListener("click", () => {
  if (!loaded || saving) return
  if (dirty) { status("请先保存配置，再打开模型测试。", "error"); return }
  location.replace(window.magpie.service || `http://127.0.0.1:${original.diagnosticsPort ?? 37747}/`)
})
$("save").addEventListener("click", async () => {
  if (saving || !loaded) return
  let controls = []
  try {
    const options = serialize()
    controls = [...$("editor").querySelectorAll("input, select, textarea, button")].map(node => [node, node.disabled])
    for (const [node] of controls) node.disabled = true
    saving = true; $("save").disabled = true
    status("正在保存…")
    const saved = await window.magpie.options.set(options)
    load(saved)
    $("save-state").textContent = "配置已保存"
    status("请到 kunbot 的模型列表查看结果；目录同步可能需要几秒。", "success")
  } catch (e) { status(e?.message ?? "保存失败，请重试。", "error") }
  finally {
    for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled
    saving = false; $("save").disabled = false; $("preview-import").disabled = readingFile
  }
})
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = "" } })
try {
  if (!window.magpie) throw new Error("请在 Magpie 的插件页面中打开此页。")
  await window.magpie.ready
  load(await window.magpie.options.get())
  loaded = true; $("loading").hidden = true; $("editor").hidden = false
} catch (e) { $("loading").textContent = e?.message ?? "读取配置失败，请重新打开页面。" }
})()
