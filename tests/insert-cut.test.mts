// Cut text in Copied (the owner on 2.7: "copies are kept, cuts aren't"; only `copy` was listened to).
// A cut is heard like a copy, on the page and in same-origin iframes, and read before the site removes the text.
// In real engines (inputs, textareas, contenteditable, an editor that cuts by itself, an open shadow root, an
// iframe): ~/ContextFlow-work/reminders-27/cut/engine.mjs (WebKit).
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let C: any
let window: any
let document: any

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><body>
<textarea id="note">Meeting moved to Friday</textarea>
<div id="editor" contenteditable="true"><p>Draft: call the bank</p></div>
<input id="pass" type="password" value="hunter22">
<form><input id="name" type="text" value="Alex Smith"><input id="card" autocomplete="cc-number"></form>
</body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, MutationObserver: window.MutationObserver })
  const dir = mkdtempSync(join(tmpdir(), "cf-insert-cut-"))
  const out = join(dir, "cut.mjs")
  await build({
    stdin: { contents: `export * from "./src/content/insert/capture"; export { watchFields } from "./src/content/insert/watch"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"]
  })
  C = await import(pathToFileURL(out).href)
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** The focus and the selection as a browser reports them. */
function select(doc: any, el: any, text: string, field?: { start: number; end: number }) {
  Object.defineProperty(doc, "activeElement", { value: el, configurable: true })
  if (field) Object.assign(el, { selectionStart: field.start, selectionEnd: field.end })
  doc.getSelection = () => ({ anchorNode: el.firstChild ?? el, toString: () => text })
}

/** A clipboard event as the handlers see it; `page` is what the site's own handler does in between. */
function clip(type: "copy" | "cut", target: any) {
  const data = new Map<string, string>()
  return {
    type,
    target,
    defaultPrevented: false,
    clipboardData: { getData: (k: string) => data.get(k) ?? "", setData: (k: string, v: string) => void data.set(k, v) },
    preventDefault() {
      this.defaultPrevented = true
    }
  }
}

function keeper() {
  const kept: string[] = []
  return { kept, on: C.clipboardKeeper((t: string) => kept.push(t)) }
}

test("a cut is heard like a copy: at capture on the document, at bubble on the window", () => {
  const seen: string[] = []
  const stop = C.watchFields({
    focus: () => undefined, blur: () => undefined, input: () => undefined, keydown: () => undefined,
    copy: (e: any, doc: any, phase: string) => seen.push(`${e.type}:${phase}:${doc === document ? "page" : "frame"}`)
  })
  const note = document.getElementById("note")
  note.dispatchEvent(new window.Event("cut", { bubbles: true }))
  note.dispatchEvent(new window.Event("copy", { bubbles: true }))
  assert.deepEqual(seen, ["cut:capture:page", "cut:bubble:page", "copy:capture:page", "copy:bubble:page"])
  stop()
  note.dispatchEvent(new window.Event("cut", { bubbles: true }))
  assert.equal(seen.length, 4, "nothing after stopping")
})

test("a cut in a same-origin iframe (TinyMCE, CKEditor 4) is heard in the frame's own document", async () => {
  const inner = parseHTML(`<!doctype html><html><body id="tinymce" contenteditable="true"><p>Invoice due 15 March</p></body></html>`)
  const frame = document.createElement("iframe")
  Object.defineProperty(frame, "contentDocument", { value: inner.document, configurable: true })
  const seen: string[] = []
  const stop = C.watchFields({
    focus: () => undefined, blur: () => undefined, input: () => undefined, keydown: () => undefined,
    copy: (e: any, doc: any, phase: string) => seen.push(`${e.type}:${phase}:${doc === inner.document ? "frame" : "page"}`)
  })
  document.body.appendChild(frame)
  await tick()
  inner.document.querySelector("p")!.dispatchEvent(new (inner.window as any).Event("cut", { bubbles: true }))
  assert.deepEqual(seen, ["cut:capture:frame", "cut:bubble:frame"])
  stop()
  frame.remove()
})

test("cut in a textarea: read whole before the text goes, kept once", async () => {
  const note = document.getElementById("note")
  select(document, note, "", { start: 0, end: 12 })
  const { kept, on } = keeper()
  const e = clip("cut", note)
  on(e, document, "capture")
  on(e, document, "bubble")
  await tick(5)
  assert.deepEqual(kept, ["Meeting move"])
})

test("an editor that cuts by itself (ProseMirror, Lexical): its own clipboard text is taken", async () => {
  const editor = document.getElementById("editor")
  select(document, editor, "call the bank")
  const { kept, on } = keeper()
  const e = clip("cut", editor)
  on(e, document, "capture")
  // The editor's handler: its text on the clipboard, the native cut stopped, the selection removed.
  e.preventDefault()
  e.clipboardData.setData("text/plain", "call the bank ")
  select(document, editor, "")
  on(e, document, "bubble")
  await tick(5)
  assert.deepEqual(kept, ["call the bank"])
})

test("an editor that cuts by itself with only HTML on the clipboard: what capture saw is kept", async () => {
  const editor = document.getElementById("editor")
  select(document, editor, "Draft: call")
  const { kept, on } = keeper()
  const e = clip("cut", editor)
  on(e, document, "capture")
  e.preventDefault()
  e.clipboardData.setData("text/html", "<p>Draft: call</p>")
  select(document, editor, "")
  on(e, document, "bubble")
  await tick(5)
  assert.deepEqual(kept, ["Draft: call"])
})

test("a site that stops the cut before it bubbles up: what capture saw is kept", async () => {
  const editor = document.getElementById("editor")
  select(document, editor, "Draft: call the bank")
  const { kept, on } = keeper()
  on(clip("cut", editor), document, "capture")
  await tick(5)
  assert.deepEqual(kept, ["Draft: call the bank"])
})

test("a copy with nothing to read at bubble keeps nothing, as before", async () => {
  const editor = document.getElementById("editor")
  select(document, editor, "Draft: call")
  const { kept, on } = keeper()
  const e = clip("copy", editor)
  on(e, document, "capture")
  e.preventDefault()
  select(document, editor, "")
  on(e, document, "bubble")
  await tick(5)
  assert.deepEqual(kept, [])
})

test("cuts from a password field, or a form with a card field, are never kept", async () => {
  for (const id of ["pass", "name"]) {
    const el = document.getElementById(id)
    select(document, el, "", { start: 0, end: 8 })
    const { kept, on } = keeper()
    const e = clip("cut", el)
    on(e, document, "capture")
    on(e, document, "bubble")
    await tick(5)
    assert.deepEqual(kept, [], id)
  }
})
