// The selection bubble on text inside a site's open shadow root (2.5 (77), the director: LinkedIn draws its messages
// in #interop-outlet's open root, and a selection there gave no bubble). The document doesn't see such a selection:
// Safari's has nothing (the text is reached through getComposedRanges), Chrome's names the root's host (the root
// has its own getSelection). readSelection reads it inside the root the pointer last went down in, with quick
// insert's rangeIn; never inside the panel.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let S: any
let window: any
let document: any

// linkedom's Range can't be set: the parts readSelection and rangeIn use, within one text node.
class TestRange {
  startContainer: any
  startOffset = 0
  endContainer: any
  endOffset = 0
  setStart(node: any, offset: number) {
    this.startContainer = node
    this.startOffset = offset
  }
  setEnd(node: any, offset: number) {
    this.endContainer = node
    this.endOffset = offset
  }
  get collapsed() {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset
  }
  toString() {
    return this.startContainer === this.endContainer ? (this.startContainer.textContent ?? "").slice(this.startOffset, this.endOffset) : ""
  }
  cloneRange() {
    const r = new TestRange()
    r.setStart(this.startContainer, this.startOffset)
    r.setEnd(this.endContainer, this.endOffset)
    return r
  }
  getBoundingClientRect() {
    return { top: 300, bottom: 322, left: 20, right: 220, width: 200, height: 22 }
  }
}
const rangeOf = (node: any, start: number, end: number) => {
  const r = new TestRange()
  r.setStart(node, start)
  r.setEnd(node, end)
  return r
}

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><body><p id="page">The page's own words</p><div id="interop-outlet"></div><contextflow-root id="panel"></contextflow-root></body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot })
  document.createRange = () => new TestRange()
  const dir = mkdtempSync(join(tmpdir(), "cf-selection-shadow-"))
  const out = join(dir, "selection.mjs")
  await build({
    stdin: { contents: `export { readSelection } from "./src/content/page"; export { trackPointer, shadowSelection } from "./src/content/selectionShadow"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"]
  })
  S = await import(pathToFileURL(out).href)
  S.trackPointer(document)
})

/** LinkedIn's outlet: a message in an open root, and a reply box two roots deep. */
function outlet() {
  const host = document.getElementById("interop-outlet")
  if (host.shadowRoot) return { host, root: host.shadowRoot, inner: host.shadowRoot.getElementById("composer").shadowRoot }
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<style>p { margin: 0 }</style><div class="msg"><b>Ben Ortiz</b><p id="said">Thanks for the intro! When are you free next week?</p></div><cf-composer id="composer"></cf-composer>`
  const inner = root.getElementById("composer").attachShadow({ mode: "open" })
  inner.innerHTML = `<div id="deep"><p id="quoted">Let's meet on Tuesday at noon</p></div>`
  return { host, root, inner }
}

/** The pointer goes down on `el` (composedPath reaches into open roots). */
function pointerOn(el: any) {
  const path: any[] = []
  for (let n = el; n; n = n.parentNode ?? n.host) path.push(n)
  const e = new window.Event("pointerdown", { bubbles: true })
  e.composedPath = () => path
  document.dispatchEvent(e)
}

const noSelection = { rangeCount: 0, isCollapsed: true, anchorNode: null, toString: () => "", getRangeAt: () => null }

beforeEach(() => {
  document.getSelection = () => noSelection
})

test("Safari: the document has nothing; the text is read in the root (getComposedRanges)", () => {
  const { root } = outlet()
  const said = root.getElementById("said").firstChild
  for (const form of ["dictionary", "roots"]) {
    document.getSelection = () => ({
      ...noSelection,
      // Safari 18 takes { shadowRoots }, Safari 17 the roots themselves; a root not named gives the host.
      getComposedRanges: (...args: any[]) => {
        const roots = form === "dictionary" ? args[0]?.shadowRoots : args
        if (!Array.isArray(roots) || !roots.includes(root)) throw new TypeError("no roots")
        return [{ startContainer: said, startOffset: 0, endContainer: said, endOffset: 21 }]
      }
    })
    pointerOn(root.getElementById("said"))
    const sel = S.readSelection()
    assert.equal(sel?.text, "Thanks for the intro!", form)
    assert.equal(sel.words, 4)
    assert.equal(sel.rect.top, 300, "a rectangle to put the bubble by")
    // The range for the bell, the eye and the note.
    assert.equal(S.shadowSelection("contextflow-root").toString(), "Thanks for the intro!")
  }
})

test("Chrome: the document names the host; the root's own selection has the text", () => {
  const { host, root } = outlet()
  const said = root.getElementById("said").firstChild
  document.getSelection = () => ({ rangeCount: 1, isCollapsed: false, anchorNode: host.parentNode, toString: () => "", getRangeAt: () => rangeOf(host.parentNode, 1, 2) })
  root.getSelection = () => ({ rangeCount: 1, getRangeAt: () => rangeOf(said, 22, 50) })
  pointerOn(root.getElementById("said"))
  assert.equal(S.readSelection()?.text, "When are you free next week?")
  delete root.getSelection
})

test("two roots deep (a component inside the outlet): the inner root's selection", () => {
  const { root, inner } = outlet()
  const quoted = inner.getElementById("quoted").firstChild
  document.getSelection = () => ({
    ...noSelection,
    getComposedRanges: ({ shadowRoots }: { shadowRoots: any[] }) => {
      assert.deepEqual(shadowRoots, [inner, root], "the roots from the inside out")
      return [{ startContainer: quoted, startOffset: 14, endContainer: quoted, endOffset: 29 }]
    }
  })
  pointerOn(inner.getElementById("quoted"))
  assert.equal(S.readSelection()?.text, "Tuesday at noon")
})

test("a selection in the page itself reads as before, once the pointer went down there", () => {
  const { root } = outlet()
  pointerOn(root.getElementById("said"))
  const words = document.getElementById("page").firstChild
  document.getSelection = () => ({ rangeCount: 1, isCollapsed: false, anchorNode: words, toString: () => "page's own words", getRangeAt: () => rangeOf(words, 4, 20) })
  pointerOn(document.getElementById("page"))
  assert.equal(S.readSelection()?.text, "page's own words")
  // Nothing selected anywhere: no bubble.
  document.getSelection = () => noSelection
  assert.equal(S.readSelection(), null)
})

test("never inside the panel (its root is open in test builds)", () => {
  const panel = document.getElementById("panel")
  const own = panel.shadowRoot ?? panel.attachShadow({ mode: "open" })
  own.innerHTML = `<div class="cf"><p id="answer">An answer in the panel</p></div>`
  const answer = own.getElementById("answer").firstChild
  own.getSelection = () => ({ rangeCount: 1, getRangeAt: () => rangeOf(answer, 3, 9) })
  pointerOn(own.getElementById("answer"))
  assert.equal(S.shadowSelection("contextflow-root"), null)
  assert.equal(S.readSelection(), null)
})
