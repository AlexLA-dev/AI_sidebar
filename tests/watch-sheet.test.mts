// The eye opens watching alone (the owner, build 75: "the eye opens a menu with both watching and a reminder; it
// confuses"). Its window has the watch section and nothing of Remind; the "Come back later…" window keeps both.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let sheet: any
let root: any

before(async () => {
  const { window, document } = parseHTML(`<!doctype html><html><head><title>Mug · Shop</title></head><body><p>Price: USD 40</p></body></html>`)
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, location: { href: "https://shop.example/mug" } })
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    runtime: { sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => undefined } }
  }
  const dir = mkdtempSync(join(tmpdir(), "cf-watch-sheet-"))
  const out = join(dir, "sheet.mjs")
  await build({
    stdin: { contents: `export { openWatchSheet } from "./src/content/watch/WatchSheet"; export { setPanelRoot } from "./src/content/root"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".tsx": "tsx" }, define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  sheet = await import(pathToFileURL(out).href)
  const host = document.createElement("contextflow-root")
  document.documentElement.appendChild(host)
  root = host.attachShadow({ mode: "open" })
  const panel = document.createElement("div")
  panel.className = "cf"
  panel.setAttribute("data-theme", "dark")
  root.appendChild(panel)
  sheet.setPanelRoot(root)
})

test("the eye's window: watching only, no Remind and no reminder button", async () => {
  sheet.openWatchSheet({ url: "https://shop.example/mug", title: "Mug · Shop", selection: "USD 40", how: "bubble" })
  await new Promise((r) => setTimeout(r, 20))
  const html = root.innerHTML as string
  assert.match(html, /cf-watch/, "the watch section")
  assert.match(html, /USD 40/, "the price it starts from")
  assert.doesNotMatch(html, /cf-sheet-row/, "no Remind presets (this evening, tomorrow…)")
  assert.doesNotMatch(html, /Remind|remind/, "no reminder anywhere in it")
  // The window takes the panel's theme.
  const layer = [...root.children].at(-1)
  assert.equal(layer.className, "cf")
  assert.equal(layer.getAttribute("data-theme"), "dark")
})
