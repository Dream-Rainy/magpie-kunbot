// The service's copy of the configuration page must not load resources from
// Wails' virtual host after visiting HTTP. Use Magpie's existing postMessage
// protocol for the few bridge operations the configuration form needs.
;(() => {
  const waiting = new Map(), listeners = []
  let sequence = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Magpie 窗口未响应，请从插件侧边栏重新打开。")) }, 10000)
    waiting.set(id, { resolve, reject, timer })
    parent.postMessage({ magpie: 1, id, method, params }, "*")
  })
  const api = {
    // This file is served only beneath /config/, so the parent is the local
    // service root, including any Magpie Web proxy prefix.
    service: new URL("../", location.href).href,
    options: { get: () => call("options.get"), set: options => call("options.set", { options }) },
    onTheme: fn => { listeners.push(fn); if (api.theme) fn(api.theme) },
  }
  function paint(theme) {
    api.theme = theme
    const root = document.documentElement
    root.dataset.theme = theme.dark ? "dark" : "light"
    root.style.colorScheme = theme.dark ? "dark" : "light"
    if (theme.lang) root.lang = theme.lang
    for (const [key, value] of Object.entries(theme.tokens ?? {})) {
      if (/^[a-z][a-z0-9-]*$/.test(key)) root.style.setProperty(`--magpie-${key}`, String(value))
    }
    for (const fn of listeners) fn(theme)
  }
  window.addEventListener("message", event => {
    const message = event.data
    if (event.source !== parent || !message || message.magpie !== 1) return
    if (message.event === "theme") { paint(message.data ?? {}); return }
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id); clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(String(message.error)))
    else pending.resolve(message.result)
  })
  window.magpie = api
  api.ready = call("hello").then(theme => { paint(theme ?? {}); return api.theme })
})()
