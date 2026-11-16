import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { forwardRequest, routeRequest } from "./routing.mjs"

const LIMIT = 65536
const operations = new Set(["/chat/completions", "/messages", "/responses", "/images/generations", "/audio/speech"])
const sensitive = /authorization|cookie|password|secret|(?:^|[-_])(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token)(?:$|[-_])/i
const object = value => value && typeof value === "object" && !Array.isArray(value)

// Both protocol metadata and an upstream error may echo a credential. Clean
// the whole report, not just Authorization, before returning it to the page.
export function redact(value, secrets = []) {
  if (typeof value === "string") {
    let text = value
    for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]")
    return text.replace(/https?:\/\/[^/\s:@]+:[^@/\s]+@/gi, match => match.slice(0, match.indexOf("://") + 3) + "[REDACTED]@")
      .replace(/data:[^;,]+;base64,[a-z0-9+/=]+/gi, "[binary data omitted]")
      .replace(/("b64_json"\s*:\s*")[^"]+/gi, "$1[image data omitted]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|set-cookie|cookie|password|secret)["']?\s*[:=]\s*["']?)[^"'\r\n,}&]+/gi, "$1[REDACTED]")
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    sensitive.test(key) ? "[REDACTED]" : key === "b64_json" ? `[image data omitted; ${String(v).length} characters]` : redact(v, secrets),
  ]))
  return value
}

async function responseBody(response) {
  if (!response.body) return { body: "", truncated: false }
  const reader = response.body.getReader(), chunks = []
  let size = 0, truncated = false, readError
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const keep = value.subarray(0, Math.max(0, LIMIT - size))
      chunks.push(keep); size += keep.length
      if (value.length > keep.length || size === LIMIT) { truncated = true; void reader.cancel().catch(() => {}); break }
    }
  } catch (e) { readError = e?.message ?? "Response interrupted" }
  finally { reader.releaseLock() }
  const type = response.headers.get("content-type") ?? ""
  if (/^(image|audio|video)\//i.test(type) || /octet-stream/i.test(type)) return { body: `[binary ${type}; ${size} bytes read]`, truncated, ...(readError ? { readError } : {}) }
  const bytes = new Uint8Array(size); let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  let body = new TextDecoder().decode(bytes)
  try { body = JSON.parse(body) } catch {}
  return { body, truncated, ...(readError ? { readError } : {}) }
}

export function diagnosticTemplate(model) {
  const id = model.id, npm = model.provider?.npm ?? ""
  if (model.modalities?.output?.includes("image")) return { operation: "/images/generations", body: { model: id, prompt: "A small blue circle on a white background", n: 1 } }
  if (model.modalities?.output?.includes("audio")) return { operation: "/audio/speech", body: { model: id, input: "Hello", voice: "alloy" } }
  if (model.modalities?.input?.includes("audio") || model.modalities?.output?.includes("video")) return { unsupported: "此面板支持 JSON 请求；当前模型需要文件或专用接口。" }
  if (npm === "@ai-sdk/anthropic") return { operation: "/messages", body: { model: id, max_tokens: 64, messages: [{ role: "user", content: "Reply OK." }], stream: false } }
  if (npm === "@ai-sdk/openai") return { operation: "/responses", body: { model: id, input: "Reply OK.", max_output_tokens: 64, stream: false } }
  return { operation: "/chat/completions", body: { model: id, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 64, stream: false } }
}

export function createDiagnostics({ directory, modelTable, legacyURL, client }) {
  const accounts = async () => {
    let all
    try { all = JSON.parse(await readFile(join(directory, "plugin-auth.json"), "utf8")) }
    catch (e) { if (e?.code === "ENOENT") return {}; throw new Error("无法读取当前 Magpie 的账号，请检查登录状态后重试。") }
    if (!object(all)) throw new Error("账号文件格式异常，请先在 Magpie 中检查登录状态。")
    return Object.fromEntries(Object.entries(all).filter(([id, auth]) => /^kunbot(?:#[^#]+)?$/.test(id) && auth?.type === "api" && typeof auth.key === "string" && auth.key))
  }
  const account = async id => {
    const all = await accounts()
    if (!Object.hasOwn(all, id)) throw new Error("该账号未登录或已退出，请重新加载账号。")
    return all[id]
  }
  return {
    async error(error) {
      try { return redact({ error: error?.message ?? "测试服务异常。" }, Object.values(await accounts()).map(a => a.key)) }
      catch { return { error: "无法读取当前 Magpie 的账号，请检查登录状态后重试。" } }
    },
    async accounts() {
      const all = await accounts(), secrets = Object.values(all).map(a => a.key)
      return redact(Object.entries(all).map(([id, auth], i) => ({ id, name: String(auth.metadata?.email || auth.accountId || `账号 ${i + 1}`) })), secrets)
    },
    async models(id) {
      const auth = await account(id)
      return redact(Object.entries(await modelTable(auth)).map(([key, m]) => ({ key, name: m.name || m.id, ...diagnosticTemplate(m) })), [auth.key])
    },
    async run(input, signal) {
      if (!object(input) || typeof input.account !== "string" || typeof input.model !== "string") throw new Error("请选择账号与模型。")
      if (!operations.has(input.operation)) throw new Error("请选择支持的模型操作接口。")
      if (!object(input.body) || Buffer.byteLength(JSON.stringify(input.body)) > LIMIT) throw new Error("请求体需要是 64 KiB 以内的 JSON 对象。")
      const auth = await account(input.account), secrets = [auth.key]
      const timeout = Math.trunc(Math.min(120000, Math.max(100, Number(input.timeoutMs) || 60000)))
      const abort = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
      const report = { preview: input.preview === true, account: input.account, model: input.model, attempts: [] }
      const started = Date.now()
      try {
        const model = (await modelTable(auth))[input.model]
        if (!model?.provider?.api) throw new Error("该模型不在当前账号的已配置模型列表中，请重新加载。")
        if (JSON.stringify(await account(input.account)) !== JSON.stringify(auth)) throw new Error("账号已变更，请重新加载后测试。")
        abort.throwIfAborted()
        const url = `${model.provider.api}${input.operation}`
        const headers = { "content-type": "application/json", accept: "application/json" }
        if (input.operation === "/messages") headers["anthropic-version"] = "2023-06-01"
        const response = await forwardRequest(url, {
          method: "POST", headers, body: JSON.stringify({ ...input.body, model: model.id }), signal: abort,
          redirect: "error",
        }, {
          auth, client, targets: model._targets, route: routeRequest(url), legacyURL: legacyURL?.(url, auth), preview: report.preview,
          trace: async event => {
            const reading = Date.now()
            let body = event.body
            if (typeof body !== "string") body = body ? new TextDecoder().decode(body) : ""
            try { body = JSON.parse(body) } catch {}
            const attempt = { endpoint: event.endpoint, request: { url: event.url, method: event.method, headers: Object.fromEntries(event.headers), body } }
            report.attempts.push(attempt)
            if (event.error) attempt.error = event.error?.message ?? String(event.error)
            if (event.response) attempt.response = { status: event.response.status, headers: Object.fromEntries(event.response.headers), ...await responseBody(event.response) }
            if (!event.preview) attempt.elapsedMs = event.elapsedMs + Date.now() - reading
          },
        })
        report.ok = report.preview || response.ok
        if (!report.preview) report.status = response.status
        if (report.attempts.some(a => a.response?.readError)) { report.ok = false; report.error = "响应读取中断，详情见候选记录。" }
      } catch (e) {
        report.ok = false
        report.error = abort.aborted ? (signal?.aborted ? "测试已取消。" : `测试在 ${timeout / 1000} 秒后超时。`) : e?.message ?? String(e)
      }
      report.elapsedMs = Date.now() - started
      return redact(report, secrets)
    },
  }
}
