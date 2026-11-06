// A site's window over everything (the owner on 2.5 (81), LinkedIn's "Start post" on an iPad: no button by its field,
// and after such windows the button and the selection bubble seemed gone until a reload). A modal <dialog> and an
// open popover are in the browser's top layer, above our host whatever its z-index, and a modal dialog makes the rest
// of the page inert; our host goes into the window while the person works there, and back after. In real engines:
// ~/ContextFlow-work/quick-insert-25/shadow/q81.mjs and Safari on tools/preview/modal.html.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let T: any
let window: any
let document: any

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><body><p id="page">Page</p><div id="outlet"></div></body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, MutationObserver: window.MutationObserver })
  const dir = mkdtempSync(join(tmpdir(), "cf-top-layer-"))
  const out = join(dir, "top.mjs")
  await build({ entryPoints: [new URL("../src/content/topLayer.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  T = await import(pathToFileURL(out).href)
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A window as a browser has it in its top layer: ":modal" (or ":popover-open") matches while it's open. */
function topWindow(scope: any, pseudo = ":modal") {
  const d = document.createElement("dialog")
  d.innerHTML = `<div id="editor" contenteditable="true"><p></p></div>`
  scope.appendChild(d)
  let open = false
  const matches = d.matches.bind(d)
  d.matches = (sel: string) => (sel === pseudo ? open : matches(sel))
  return {
    el: d,
    editor: d.querySelector("#editor"),
    open() {
      open = true
      d.setAttribute("open", "")
    },
    close() {
      open = false
      d.removeAttribute("open")
      d.dispatchEvent(new window.Event("close"))
    }
  }
}

/** A press as the page hears it: its path, inside open roots too. */
function press(path: any[]) {
  const e = new window.Event("pointerdown", { bubbles: true })
  e.composedPath = () => [...path, document.body, document.documentElement, document, window]
  document.dispatchEvent(e)
}

function ourHost() {
  const host = document.createElement("contextflow-root")
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 })
  document.documentElement.appendChild(host)
  return host
}

test("a modal window: our host goes into it while the person works there, and back to <html> when it closes", async () => {
  const host = ourHost()
  const stop = T.keepOverTopLayer(host)
  const w = topWindow(document.body)
  w.open()
  press([w.editor, w.el])
  assert.equal(host.parentNode, w.el, "inside the window, its last child")
  assert.equal(w.el.lastElementChild, host)
  // Our own buttons, pressed there, keep it there.
  press([host, w.el])
  assert.equal(host.parentNode, w.el)
  w.close()
  await tick()
  assert.equal(host.parentNode, document.documentElement, "home once it closed")
  stop()
  host.remove()
  w.el.remove()
})

test("a window in a shadow root, taken off the page with our host in it: our host comes home all the same", async () => {
  const host = ourHost()
  const stop = T.keepOverTopLayer(host)
  const outlet = document.getElementById("outlet")
  const root = outlet.shadowRoot ?? outlet.attachShadow({ mode: "open" })
  const w = topWindow(root)
  w.open()
  press([w.editor, w.el, root, outlet])
  assert.equal(host.parentNode, w.el)
  // The site tears its window down at once (no close event first).
  w.el.remove()
  await tick()
  assert.equal(host.parentNode, document.documentElement)
  assert.ok(host.isConnected)
  stop()
  host.remove()
})

test("a popover: the same; back on the page, our host comes home", async () => {
  const host = ourHost()
  const stop = T.keepOverTopLayer(host)
  const w = topWindow(document.body, ":popover-open")
  w.open()
  press([w.editor, w.el])
  assert.equal(host.parentNode, w.el)
  // A press on the page while it's still open (a popover doesn't make the page inert).
  press([document.getElementById("page")])
  assert.equal(host.parentNode, document.documentElement)
  stop()
  host.remove()
  w.el.remove()
})

test("the site's code takes our host out of its window: home; a site marking our host inert: undone", async () => {
  const host = ourHost()
  const stop = T.keepOverTopLayer(host)
  const w = topWindow(document.body)
  w.open()
  press([w.editor, w.el])
  assert.equal(host.parentNode, w.el)
  w.el.innerHTML = `<div id="editor2" contenteditable="true"></div>`
  await tick()
  assert.equal(host.parentNode, document.documentElement, "re-rendered without us: back home")
  host.setAttribute("inert", "")
  await tick()
  assert.equal(host.hasAttribute("inert"), false)
  stop()
  host.remove()
  w.el.remove()
})

test("windows that aren't in the top layer change nothing (a closed dialog, a plain overlay)", () => {
  const host = ourHost()
  const stop = T.keepOverTopLayer(host)
  const w = topWindow(document.body)
  press([w.editor, w.el])
  assert.equal(host.parentNode, document.documentElement)
  assert.equal(T.inTopLayer(document.getElementById("page")), false)
  stop()
  host.remove()
  w.el.remove()
})
