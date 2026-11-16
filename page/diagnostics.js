;(() => {
const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name="kunbot-diagnostics-token"]').content
let models = [], running = false, loading = false, generation = 0, controller
const say = (message, kind = "") => { $("status").textContent = message; $("status").className = kind }
const current = () => models.find(m => m.key === $("model").value)
function controls() {
  const busy = running || loading, ready = !!current() && !current()?.unsupported
  for (const id of ["reload", "account", "model", "operation", "timeout", "body", "reset-body"]) $(id).disabled = busy
  $("preview").disabled = busy || !ready; $("send").disabled = busy || !ready
  $("cancel").disabled = !running
  $("back").disabled = running
  $("copy").disabled = !$("output").value
}
async function api(path, body, signal) {
  const response = await fetch(new URL(path, location.href), {
    method: body === undefined ? "GET" : "POST", headers: { "x-kunbot-diagnostics": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
function choices(node, items, value) {
  node.replaceChildren(...items.map(([id, name]) => { const option = document.createElement("option"); option.value = id; option.textContent = name; return option }))
  if (items.some(([id]) => id === value)) node.value = value
}
function resetBody() {
  const model = current()
  $("output").value = ""; $("summary").textContent = "尚未运行测试。"
  if (model?.unsupported) { $("body").value = ""; say(model.unsupported, "error") }
  else if (model) {
    $("operation").value = model.operation; $("body").value = JSON.stringify(model.body, null, 2)
    say("先预览请求，确认后再发送。")
  } else { $("body").value = ""; say("当前账号没有可测试的模型，请先在配置页添加模型。") }
  controls()
}
async function loadModels() {
  const version = ++generation
  loading = true; models = []; controls(); say("正在载入此账号的模型…")
  try {
    const result = await api(`api/models?account=${encodeURIComponent($("account").value)}`)
    if (version !== generation) return
    models = result.models; choices($("model"), models.map(m => [m.key, `${m.name} · ${m.key}`]))
    resetBody()
  } catch (e) { if (version === generation) say(e.message, "error") }
  finally { if (version === generation) { loading = false; controls() } }
}
async function reload() {
  loading = true; controls(); say("正在读取已登录账号…")
  try {
    const { accounts } = await api("api/accounts")
    choices($("account"), accounts.map(a => [a.id, a.name]), $("account").value)
    if (!accounts.length) {
      models = []; choices($("model"), []); $("body").value = ""
      say("尚未登录 kunbot 账号，请先在 Magpie 中登录，再重新加载。", "error"); return
    }
    await loadModels()
  } catch (e) { say(e.message, "error") }
  finally { loading = false; controls() }
}
async function run(preview) {
  if (running || loading || !current()) return
  let body
  try {
    body = JSON.parse($("body").value)
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error()
  } catch { say("请填写有效的 JSON 对象。", "error"); return }
  running = true; controller = new AbortController(); controls()
  say(preview ? "正在构造实际候选请求…" : "正在请求上游；可取消此次测试…")
  $("summary").textContent = preview ? "请求预览中…" : "测试进行中…"
  try {
    const result = await api("api/test", { account: $("account").value, model: current().key, operation: $("operation").value, body, preview, timeoutMs: Number($("timeout").value) }, controller.signal)
    $("output").value = JSON.stringify(result, null, 2)
    const summary = `${preview ? "预览" : result.ok ? "成功" : "失败"} · ${result.attempts?.length ?? 0} 个候选${result.status ? ` · HTTP ${result.status}` : ""} · ${result.elapsedMs ?? 0} ms`
    $("summary").textContent = summary
    say(result.error || (preview ? "预览已生成，没有发送模型请求。" : result.ok ? "测试完成，查看各候选的请求和响应。" : "上游返回失败，详情见诊断结果。"), result.ok ? "success" : "error")
  } catch (e) {
    const message = controller.signal.aborted ? "测试已取消。" : e.message
    say(message, "error"); $("summary").textContent = message
  } finally { running = false; controller = null; controls() }
}
$("back").addEventListener("click", () => location.replace(new URL("config/index.html", location.href).href))
$("reload").addEventListener("click", reload)
$("account").addEventListener("change", loadModels)
$("model").addEventListener("change", resetBody)
$("reset-body").addEventListener("click", resetBody)
$("preview").addEventListener("click", () => run(true))
$("send").addEventListener("click", () => run(false))
$("cancel").addEventListener("click", () => controller?.abort())
$("copy").addEventListener("click", async () => {
  try {
    if (!navigator.clipboard?.writeText) throw Error()
    await navigator.clipboard.writeText($("output").value); say("已复制脱敏诊断。", "success")
  } catch {
    $("output").focus(); $("output").select()
    if (document.execCommand("copy")) say("已复制脱敏诊断。", "success")
    else say("已选中诊断，请按 Ctrl+C（Mac 为 ⌘C）复制。")
  }
})
window.addEventListener("pagehide", () => controller?.abort())
reload()
})()
