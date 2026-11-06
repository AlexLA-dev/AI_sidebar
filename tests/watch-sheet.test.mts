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
const NOW = Date.UTC(2026, 10, 5, 12, 0)
let cancels = 0
let watches: any[] = [{
  id: "a1", url: "https://shop.example/mug", host: "shop.example", title: "Mug", what: "price", label: "Price",
  condition: "when it drops below 35 EUR", source: "ld-price", value: "40 EUR", rule: { kind: "below", n: 35 }, mode: "bg",
  site: "shop", createdAt: NOW - 3_600_000, checkedAt: NOW - 300_000, checks: 3, failures: 0
}]

before(async () => {
  const { window, document } = parseHTML(`<!doctype html><html><head><title>Mug · Shop</title></head><body><p>Price: USD 40</p></body></html>`)
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, location: { href: "https://shop.example/mug" } })
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    // The background, as far as the list needs it: its watches, and a stop that takes one away.
    runtime: {
      sendMessage: async (m: any) => {
        if (m.type === "watchList") return structuredClone(watches)
        if (m.type === "watchCancel") {
          cancels++
          watches = watches.filter((w) => w.id !== m.id)
        }
        return { ok: true }
      }
    },
    storage: { local: { get: async () => ({}), set: async () => undefined } }
  }
  const dir = mkdtempSync(join(tmpdir(), "cf-watch-sheet-"))
  const out = join(dir, "sheet.mjs")
  await build({
    stdin: { contents: `export { openWatchSheet } from "./src/content/watch/WatchSheet"; export { setPanelRoot } from "./src/content/root"; export { watchSource } from "./src/content/watch/list"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
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

test("Stop watching in a row's window: the open list reads its rows again and the row is gone", async () => {
  const row = { id: "watch:a1", kind: "watch", title: "Mug", url: "https://shop.example/mug", status: "", sortAt: 0 }
  assert.deepEqual((await sheet.watchSource.items()).map((r: any) => r.id), ["watch:a1"])
  let reread = 0
  // As chat UX's openLaterItem asks it, with `done` reading the list again.
  assert.equal(sheet.watchSource.open(row, () => void reread++), true)
  await new Promise((r) => setTimeout(r, 30))
  const window = [...root.children].at(-1)
  assert.match(window.innerHTML, /when it drops below 35 EUR · now/, "its words whole, with the value now")
  const stop = window.querySelector(".cf-watch-stop")
  assert.ok(stop, "Stop watching")
  stop.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(cancels, 1, "one stop")
  assert.equal(reread, 1, "the list was told to read its rows again")
  assert.deepEqual(await sheet.watchSource.items(), [], "and the row isn't among them")
  assert.doesNotMatch(window.innerHTML, /cf-watch-edit/, "the window closed")
})
