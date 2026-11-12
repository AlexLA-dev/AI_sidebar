// 2.6.1, filmed for X on build 100: after Watch, "Watching." flashed inside the window and went by unseen (the watch
// showed up only in Watching), and the system's question about notifications came in the middle of the first Watch.
// Now the window goes and "Watching: …" says what's watched and on what condition, over the page; the question about
// notifications comes only after the watch is set, on "Turn on notifications", with a line about why.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let sheet: any
let root: any
let sent: any[] = []
let notify = "ok"
let asked = "ok"

before(async () => {
  const { window, document } = parseHTML(`<!doctype html><html><head><title>Robot vacuum · Shop</title></head><body><div class="buy"><span>$</span><span>799</span><span>.99</span> <button>Add to Cart</button></div></body></html>`)
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, location: { href: "https://shop.example/vacuum" } })
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    // The background: a page it can read, a watch saved, and the system's answer when it's asked.
    runtime: {
      sendMessage: async (m: any) => {
        sent.push(m)
        if (m.type === "watchPrepare") return { ok: true, what: "price", source: "ld-price", rule: { kind: "below", n: 750 }, label: "Price", site: "shop", readable: true, local: false, value: "799.99 USD" }
        if (m.type === "watchSave") return { ok: true, id: "w1", notify }
        if (m.type === "watchNotifyAsk") return { notify: asked }
        return { ok: true }
      }
    },
    // The AI consent is given.
    storage: { local: { get: async (key: string) => (key === "cf:consent" ? { [key]: 3 } : {}), set: async () => undefined } }
  }
  const out = join(mkdtempSync(join(tmpdir(), "cf-watch-confirm-")), "sheet.mjs")
  await build({
    stdin: { contents: `export { openWatchSheet } from "./src/content/watch/WatchSheet"; export { setPanelRoot } from "./src/content/root"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".tsx": "tsx" }, define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.6.1"', __TARGET__: '"safari"' }
  })
  sheet = await import(pathToFileURL(out).href)
  const host = document.createElement("contextflow-root")
  document.documentElement.appendChild(host)
  root = host.attachShadow({ mode: "open" })
  const panel = document.createElement("div")
  panel.className = "cf"
  root.appendChild(panel)
  sheet.setPanelRoot(root)
})

beforeEach(() => {
  sent = []
})

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const click = (el: any) => el.dispatchEvent(new (globalThis as any).window.Event("click"))
const layer = () => [...root.children].at(-1)

/** The eye's window on "$799.99", the person's words, Watch. */
async function watch(words: string): Promise<void> {
  sheet.openWatchSheet({ url: "https://shop.example/vacuum", title: "Robot vacuum · Shop", selection: "$799.99", how: "bubble" })
  await wait()
  const field = layer().querySelector("textarea.cf-watch-cond")
  assert.match(field.value, /when the price changes \(now \$799\.99\)/, "a price condition, the price whole")
  field.value = words
  field.dispatchEvent(new (globalThis as any).window.Event("input", { bubbles: true }))
  await wait(10)
  click(layer().querySelector(".cf-watch .cf-primary"))
  await wait(60)
}

test("notifications allowed: the window goes and \"Watching: …\" says what's watched and on what condition", async () => {
  notify = "ok"
  await watch("Tell me when it drops below $750")
  assert.equal(layer().querySelector(".cf-watch"), null, "the window is gone")
  const toast = layer().querySelector(".cf-watch-toast")
  assert.ok(toast, "the confirmation over the page")
  assert.equal(toast.getAttribute("role"), "status", "read out by VoiceOver")
  assert.equal(toast.textContent.trim(), "Watching: Tell me when it drops below $750 · now $799.99")
  assert.deepEqual(sent.map((m) => m.type), ["watchPrepare", "watchSave"], "never the system's question")
})

test("never asked: the watch is set first, then why and \"Turn on notifications\"; the question comes on the tap", async () => {
  notify = "not-asked"
  asked = "ok"
  await watch("Tell me when it drops below $750")
  const window = layer()
  assert.match(window.innerHTML, /Watching\. I'll tell you when it changes\./, "set, said in the window")
  assert.match(window.innerHTML, /Turn on notifications so I can tell you when it changes\./, "why")
  assert.deepEqual(sent.map((m) => m.type), ["watchPrepare", "watchSave"], "no question before the tap")
  click(window.querySelector(".cf-watch-notify"))
  await wait(60)
  assert.deepEqual(sent.map((m) => m.type), ["watchPrepare", "watchSave", "watchNotifyAsk"])
  assert.equal(layer().querySelector(".cf-watch"), null, "the window is gone")
  assert.match(layer().querySelector(".cf-watch-toast").textContent.trim(), /^Watching: Tell me when it drops below \$750/)
})

test("never asked, Not now: no question, and still \"Watching: …\"", async () => {
  notify = "not-asked"
  await watch("when the price changes (now $799.99)")
  const later = [...layer().querySelectorAll(".cf-sheet-actions .cf-secondary")].find((b: any) => b.textContent === "Not now")
  assert.ok(later, "Not now")
  click(later)
  await wait()
  assert.ok(!sent.some((m) => m.type === "watchNotifyAsk"), "not asked")
  assert.equal(layer().querySelector(".cf-watch-toast").textContent.trim(), "Watching: when the price changes (now $799.99)")
})

test("turned off when asked: the window stays and says how to turn them on", async () => {
  notify = "not-asked"
  asked = "denied"
  await watch("Tell me when it drops below $750")
  click(layer().querySelector(".cf-watch-notify"))
  await wait(60)
  assert.ok(layer().querySelector(".cf-watch"), "the window stays")
  assert.match(layer().innerHTML, /Notifications are off for ContextFlow/)
  assert.equal(layer().querySelector(".cf-watch-notify"), null, "no second ask")
  click(layer().querySelector(".cf-sheet-title .cf-sheet-close"))
  await wait(10)
})

test("a window opened while \"Watching: …\" shows isn't closed by its timer", async () => {
  notify = "ok"
  await watch("Tell me when it drops below $750")
  assert.ok(layer().querySelector(".cf-watch-toast"))
  sheet.openWatchSheet({ url: "https://shop.example/vacuum", title: "Robot vacuum · Shop", selection: "$799.99", how: "bubble" })
  await wait(4300)
  assert.ok(layer().querySelector(".cf-watch"), "the new window stays")
})
