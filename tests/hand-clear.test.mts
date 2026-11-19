// 2.7 (108), the owner in Gmail: he selected text, wrote a comment by the selection, made a note with a snapshot, tapped
// Open, closed the panel, cleared the selection with a tap on the page, opened the panel, and the text was selected
// again once it closed; clearing it and opening the panel again repeated it. The selection stays remembered after the
// page loses it (our own buttons and the panel's field take it away), the panel opens about the remembered one and
// puts it back when it closes; a selection the person cleared themselves was remembered the same way. Now a selection
// that ends right after a press on the page is forgotten (src/content/handClear.ts).
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { CLEAR_AFTER_PRESS_MS, clearedByHand } from "../src/content/handClear.ts"

const page = (at: number) => ({ at, onPage: true })
const ours = (at: number) => ({ at, onPage: false })

test("a tap on the page right before the selection ends: the person cleared it", () => {
  // The selection last seen at 10 000 (made, or put back when the panel closed); the tap at 14 000; gone at 14 180.
  assert.equal(clearedByHand(page(14_000), 10_000, 14_180), true)
  // A Mac: the click clears it at once.
  assert.equal(clearedByHand(page(14_000), 10_000, 14_001), true)
})

test("a press on something of ours isn't the person clearing it: the round button, the selection's buttons, the panel's field", () => {
  assert.equal(clearedByHand(ours(14_000), 10_000, 14_180), false)
})

test("the press that made the selection says nothing about its end", () => {
  // A long press went down at 9 500, the word was selected at 10 000; Safari's toolbar took the selection at 10 900.
  assert.equal(clearedByHand(page(9_500), 10_000, 10_900), false)
  // A drag with the mouse: down at 9 000, the selection grew until 10 000, a script of the page dropped it later.
  assert.equal(clearedByHand(page(9_000), 10_000, 10_400), false)
})

test("a selection reported again after the finger is down: its moment is when it appeared", () => {
  // Appeared at 10 000 (put back when the panel closed); the finger down at 14 000; should a browser report the same
  // selection again at 14 020, the tap clears it at 14 180. Counted from the appearance, the press is the one that
  // cleared it.
  assert.equal(clearedByHand(page(14_000), 10_000, 14_180), true)
  // Counted from such a second report it wouldn't be: why App.tsx keeps the moment the selection appeared.
  assert.equal(clearedByHand(page(14_000), 14_020, 14_180), false)
})

test("a selection that ends with no press near it stays remembered: a script of the page, the system", () => {
  assert.equal(clearedByHand(null, 10_000, 14_000), false)
  // A scroll's touch long before: not what ended it.
  assert.equal(clearedByHand(page(11_000), 10_000, 11_000 + CLEAR_AFTER_PRESS_MS + 1), false)
  assert.equal(clearedByHand(page(11_000), 10_000, 11_000 + CLEAR_AFTER_PRESS_MS), true)
})

// ------------------------------------------------------------------ the press, as the panel reads it

let S: any
let window: any
let document: any

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><body><p id="page">The page's own words</p><contextflow-root id="panel"><button id="fab"></button></contextflow-root></body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot })
  const dir = mkdtempSync(join(tmpdir(), "cf-hand-clear-"))
  const out = join(dir, "pointer.mjs")
  await build({
    stdin: { contents: `export { trackPointer, lastPointerDown } from "./src/content/selectionShadow"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"]
  })
  S = await import(pathToFileURL(out).href)
})

function pointerOn(el: any, at: number) {
  const path: any[] = []
  for (let n = el; n; n = n.parentNode ?? n.host) path.push(n)
  const e = new window.Event("pointerdown", { bubbles: true })
  e.composedPath = () => path
  Object.defineProperty(e, "timeStamp", { value: at })
  document.dispatchEvent(e)
}

test("the latest pointer down: when, and whether on the page or on something of ours", () => {
  assert.equal(S.lastPointerDown("contextflow-root"), null, "none yet")
  S.trackPointer(document)
  pointerOn(document.getElementById("page"), 5_000)
  assert.deepEqual(S.lastPointerDown("contextflow-root"), { at: 5_000, onPage: true })
  // In a test build our root is open and the press is seen inside it; in what ships, at its host.
  pointerOn(document.getElementById("fab"), 6_000)
  assert.deepEqual(S.lastPointerDown("contextflow-root"), { at: 6_000, onPage: false })
  pointerOn(document.getElementById("panel"), 7_000)
  assert.deepEqual(S.lastPointerDown("contextflow-root"), { at: 7_000, onPage: false })
  // A text node of the page (its parent is what's kept).
  pointerOn(document.getElementById("page").firstChild, 8_000)
  assert.deepEqual(S.lastPointerDown("contextflow-root"), { at: 8_000, onPage: true })
})

// ------------------------------------------------------------------ the panel

test("the panel forgets a selection cleared by hand, and doesn't put it back when it closes", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  // Only the end of a selection the page had, judged by the press before it.
  assert.match(app, /const live = Boolean\(trackSelection\(\)\)\n\s+const was = selLiveRef\.current\n\s+selLiveRef\.current = live/)
  assert.match(app, /else if \(was && clearedByHand\(lastPointerDown\(HOST_TAG\), selLiveAtRef\.current, performance\.now\(\)\)\) \{/)
  // The panel closed: forgotten at once, with the chip's selection. Open: its chip stays, the closing forgets.
  assert.match(app, /if \(open\) handClearedRef\.current = true\n\s+else \{\n\s+forgetSelection\(\)\n\s+setSelection\(null\)\n\s+\}/)
  assert.match(app, /if \(closing && handClearedRef\.current\) \{\n\s+handClearedRef\.current = false\n\s+forgetSelection\(\)\n\s+setSelection\(null\)\n\s+\}\n\s+const back = open/)
  // A selection made again is the panel's again. Its moment is when it appeared, not its latest report.
  assert.match(app, /if \(live\) \{\n(\s+\/\/[^\n]*\n)+\s+if \(!was\) selLiveAtRef\.current = performance\.now\(\)\n\s+handClearedRef\.current = false/)
  assert.doesNotMatch(app, /if \(live\) \{\n\s+selLiveAtRef\.current = performance\.now\(\)/)
  // What our own controls took away is still put back when the panel closes (2.6 (92)).
  assert.match(app, /if \(closing && keptSelectionRef\.current\) restoreSelection\(\)/)
})
