// The new-tab catch never outlives its tap (the director on 1cf627ab): put back when the tap ends, and by the page-side
// script's own timer if that never comes; an address the page wrote itself, with no script of this tap, isn't read.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

import { catchNewTab, newTabScript } from "../src/content/agent/newtab.ts"

/** A small page: attributes on its root, events, a window.open of its own, and scripts that run (or not: a strict policy). */
function page(runs = true) {
  const attrs = new Map<string, string>()
  const listeners = new Map<string, Array<() => void>>()
  const native = function nativeOpen() { return { opened: true } }
  const root = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, String(v)), removeAttribute: (k: string) => void attrs.delete(k) }
  const document: any = {
    documentElement: root,
    addEventListener: (t: string, f: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
    dispatchEvent: (e: { type: string }) => { const fs = listeners.get(e.type) ?? []; listeners.delete(e.type); fs.forEach((f) => f()); return true },
    createElement: () => { const s: any = { textContent: "", setAttribute() {}, remove() {} }; return s },
    head: { appendChild: (s: { textContent: string }) => { if (runs) vm.runInContext(s.textContent, ctx) } }
  }
  const window: any = { open: native, CustomEvent: class { type: string; constructor(t: string) { this.type = t } } }
  document.defaultView = window
  const ctx = vm.createContext({ window, document, location: { href: "https://stays.example/stays" }, URL, setTimeout, String })
  return { document, window, native, attrs }
}

test("the tap's own address is read, and window.open is the page's again when the tap ends", () => {
  const p = page()
  const win = catchNewTab(p.document)
  assert.notEqual(p.window.open, p.native, "caught during the tap")
  assert.equal(p.window.open("/stay?id=0"), null)
  const tab = win.done()
  assert.deepEqual(tab, { url: "https://stays.example/stay?id=0", reached: true })
  assert.equal(p.window.open, p.native, "put back")
  assert.equal(p.attrs.get("data-cf-win"), undefined)
})

test("never outlives its tap: the page-side timer puts window.open back when «done» never comes", async () => {
  const p = page()
  catchNewTab(p.document, 30)
  assert.notEqual(p.window.open, p.native)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(p.window.open, p.native, "back on its own (a task stopped mid-tap, a content script torn down)")
  // A finger's tap afterwards opens the tab.
  assert.deepEqual(p.window.open("/stay?id=1"), { opened: true })
})

test("a page-set address without this tap's script is ignored (a strict policy, or a page writing the attribute)", () => {
  const p = page(false)
  const win = catchNewTab(p.document)
  p.attrs.set("data-cf-open", "https://elsewhere.example/phish")
  p.attrs.set("data-cf-win", "cf-fake")
  assert.deepEqual(win.done(), { url: "", reached: false })
  // With the script, a value the page wrote before the tap is cleared first, and a forged marker isn't this tap's.
  const q = page()
  q.attrs.set("data-cf-open", "https://elsewhere.example/before")
  const w2 = catchNewTab(q.document)
  assert.deepEqual(w2.done(), { url: "", reached: true })
})

test("the tap ends in a finally: a settle that throws still puts it back", () => {
  const hands = readFileSync(new URL("../src/content/agent/hands.ts", import.meta.url), "utf8")
  assert.match(hands, /try \{\n\s+press\(el!\)\n\s+settled = await stepSettle\(\)\n\s+\} finally \{\n\s+tab = win\?\.done\(\) \?\? null\n\s+\}/)
  assert.match(newTabScript("n1", 10), /if\(window\.open===w\)window\.open=o/)
})
