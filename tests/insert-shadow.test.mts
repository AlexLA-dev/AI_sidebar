// Quick insert in fields inside the sites' open shadow roots (the owner on 2.5 (77): "the template and insert
// button didn't work on LinkedIn"; its new-post window and its messages sit in #interop-outlet's open root).
// The document sees only a root's host: as its activeElement, as a focus event's target, and as where its
// selection is. The field, its focus and its caret are found inside; the no-button rules hold there too.
// The insert itself runs in real engines: ~/ContextFlow-work/quick-insert-25/shadow/engine.mjs (Chromium,
// WebKit) and Safari on the stand tools/preview/shadow-fields.html.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { closestComposed, shadowRootsOf } from "../src/content/insert/shadow.ts"
import { noButtonField } from "../src/content/insert/spot.ts"
import { codeField, siteMenuOpen } from "../src/content/insert/trigger.ts"

let F: any
let W: any
let window: any
let document: any

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><body><p id="page">Page</p><div id="outlet"></div><form role="search"><cf-box id="wrapped"></cf-box></form></body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot, MutationObserver: window.MutationObserver })
  const dir = mkdtempSync(join(tmpdir(), "cf-insert-shadow-"))
  const out = join(dir, "field.mjs")
  await build({
    stdin: { contents: `export * from "./src/content/insert/field"; export { watchFields, deepActive } from "./src/content/insert/watch"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"]
  })
  F = await import(pathToFileURL(out).href)
  W = F
})

/** A page like LinkedIn's: an outlet with an open root (a post editor, a message box), a component two roots deep. */
function outlet() {
  const host = document.createElement("div")
  host.id = "interop-outlet"
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<div class="ql-editor" id="post" contenteditable="true"><p>Hi all</p></div>
<div class="msg-form__contenteditable" id="msg" contenteditable="true"><p></p></div>
<input id="pass" type="password"><input id="otp" autocomplete="one-time-code"><input id="headline" type="text">
<cf-composer id="composer"></cf-composer>`
  const composer = root.getElementById("composer")
  const inner = composer.attachShadow({ mode: "open" })
  inner.innerHTML = `<div id="deep" contenteditable="true"><p>Reply</p></div>`
  const at = (id: string) => root.getElementById(id) ?? inner.getElementById(id)
  return { host, root, composer, inner, at }
}

/** Where the focus is, as a browser reports it: the document names the outermost host, each root the next one. */
function focus(scopes: Array<[any, any]>, hasFocus = true) {
  for (const [scope, el] of scopes) Object.defineProperty(scope, "activeElement", { value: el, configurable: true })
  document.hasFocus = () => hasFocus
}

test("the roots on the way up, and closest across them", () => {
  const o = outlet()
  assert.deepEqual(shadowRootsOf(o.at("deep")), [o.inner, o.root], "innermost first")
  assert.deepEqual(shadowRootsOf(document.getElementById("page")), [])
  assert.equal(closestComposed(o.at("deep"), "#interop-outlet"), o.host, "past two roots to the outlet")
  assert.equal(closestComposed(o.at("deep"), "form"), null)
  o.host.remove()
})

test("the focused field inside open roots: activeElement, the focus event's target, hasFocus", () => {
  const o = outlet()
  focus([[document, o.host], [o.root, o.composer], [o.inner, o.at("deep")]])
  assert.equal(F.activeIn(document), o.at("deep"), "down through both roots")
  assert.equal(W.deepActive(), o.at("deep"))
  assert.equal(F.focusedTarget({ target: o.host }), o.at("deep"), "a focusin at the document has the host as its target")
  assert.equal(F.editableAt(F.focusedTarget({ target: o.host })), o.at("deep"), "the editor is the field")
  assert.equal(F.hasFocus(o.at("deep")), true)
  assert.equal(F.hasFocus(o.at("post")), false, "another editor of the same root")
  // Our own panel's root is open in test builds: it is never walked into.
  const own = document.createElement("contextflow-root")
  document.documentElement.appendChild(own)
  const ownRoot = own.attachShadow({ mode: "open" })
  ownRoot.innerHTML = `<textarea id="ask"></textarea>`
  focus([[document, own], [ownRoot, ownRoot.getElementById("ask")]])
  assert.equal(F.activeIn(document), own)
  assert.equal(F.focusedTarget({ target: own }), own)
  assert.equal(F.fromOwnUi({ target: own }), true)
  own.remove()
  o.host.remove()
})

test("passwords and codes inside a root are never fields; a text input is", () => {
  const o = outlet()
  assert.equal(F.editableAt(o.at("pass")), null)
  assert.equal(F.editableAt(o.at("otp")), null)
  assert.equal(F.editableAt(o.at("headline")), o.at("headline"))
  o.host.remove()
})

test("the caret inside a root: the root's own selection, the composed ranges (both forms), else none", () => {
  const o = outlet()
  const text = o.at("post").firstChild.firstChild
  const range = () => ({ startContainer: null as any, startOffset: 0, endContainer: null as any, endOffset: 0, collapsed: true, setStart(n: any, k: number) { this.startContainer = n; this.startOffset = k }, setEnd(n: any, k: number) { this.endContainer = n; this.endOffset = k }, cloneRange() { return this } })
  document.createRange = range
  const atHost = { startContainer: document.body, startOffset: 1, endContainer: document.body, endOffset: 1 }
  const inside = { startContainer: text, startOffset: 6, endContainer: text, endOffset: 6 }
  // The document's own selection, as Chrome and WebKit give it: moved out to the host.
  const docSel = (extra: Record<string, unknown> = {}) => ({ rangeCount: 1, getRangeAt: () => ({ ...atHost, cloneRange() { return this } }), ...extra })

  // Chrome: the root's own getSelection.
  document.getSelection = () => docSel()
  o.root.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ ...inside, cloneRange() { return { ...inside } } }) })
  assert.equal(F.rangeIn(o.at("post"))?.startOffset, 6, "Chrome: shadowRoot.getSelection")
  delete o.root.getSelection

  // The standard (Safari 18 and later, Chrome 137): getComposedRanges({ shadowRoots }).
  let asked: any = null
  document.getSelection = () => docSel({ getComposedRanges: (opts: any) => { if (!opts?.shadowRoots) throw new TypeError("dictionary"); asked = opts.shadowRoots; return [inside] } })
  const std = F.rangeIn(o.at("post"))
  assert.equal(std?.startContainer, text)
  assert.equal(std?.startOffset, 6)
  assert.deepEqual(asked, [o.root])

  // Safari 17: the roots as arguments (a dictionary isn't a ShadowRoot).
  document.getSelection = () => docSel({ getComposedRanges: (...roots: any[]) => { if (!roots.every((r) => r && r.host)) throw new TypeError("ShadowRoot"); return [inside] } })
  assert.equal(F.rangeIn(o.at("post"))?.startOffset, 6, "Safari 17: getComposedRanges(...roots)")

  // Two roots deep: every root on the way is named, innermost first.
  const deepText = o.at("deep").firstChild.firstChild
  document.getSelection = () => docSel({ getComposedRanges: (opts: any) => { asked = opts.shadowRoots; return [{ startContainer: deepText, startOffset: 2, endContainer: deepText, endOffset: 2 }] } })
  assert.equal(F.rangeIn(o.at("deep"))?.startOffset, 2)
  assert.deepEqual(asked, [o.inner, o.root])

  // Nothing that reaches inside (a browser without either): no caret rather than a wrong one.
  document.getSelection = () => docSel()
  assert.equal(F.rangeIn(o.at("post")), null)
  // The caret in another editor of the same root isn't this one's.
  document.getSelection = () => docSel({ getComposedRanges: () => [inside] })
  assert.equal(F.rangeIn(o.at("msg")), null)
  o.host.remove()
})

test("watching: a focus coming out of a root, then the focus moving inside it (the document hears nothing)", async () => {
  const o = outlet()
  document.getSelection = () => null
  const seen: string[] = []
  const stop = W.watchFields({ focus: (f: any) => seen.push(`focus:${f.el.id}`), blur: () => seen.push("blur"), input: () => undefined, keydown: () => undefined, copy: () => undefined })
  // Into the post editor: the event reaches the document from the host.
  focus([[document, o.host], [o.root, o.at("post")]])
  o.host.dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.deepEqual(seen, ["focus:post"])
  // To the message box in the same root: only the root hears it (linkedom, like a browser, stops it there).
  focus([[document, o.host], [o.root, o.at("msg")]])
  let heardByDocument = false
  const spy = () => { heardByDocument = true }
  document.addEventListener("focusin", spy, true)
  o.at("post").dispatchEvent(new window.Event("focusout", { bubbles: true }))
  o.at("msg").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  document.removeEventListener("focusin", spy, true)
  assert.equal(heardByDocument, false)
  assert.deepEqual(seen, ["focus:post", "focus:msg"], "the message box is the field now, and no blur came in between")
  // Typing in the composer two roots deep, its focus not heard: that's the field from then on.
  focus([[document, o.host], [o.root, o.composer], [o.inner, o.at("deep")]])
  o.host.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.deepEqual(seen.at(-1), "focus:deep")
  // A password in the root never becomes the field.
  focus([[document, o.host], [o.root, o.at("pass")]])
  o.at("pass").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.equal(seen.at(-1), "focus:deep")
  // The focus leaves for the page.
  focus([[document, document.getElementById("page")], [o.root, null], [o.inner, null]])
  o.at("pass").dispatchEvent(new window.Event("focusout", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 160))
  assert.equal(seen.at(-1), "blur")
  stop()
  o.host.remove()
})

// The owner on 2.5 (78), LinkedIn: loaded from scratch the button worked; after the feed, Start post and back to the
// messages inside the site, it didn't, until a refresh. A site that switches sections draws new hosts and roots and
// drops the old ones with the focus in them (WebKit sends no blur then). The stand: tools/preview/spa.html; in
// real engines: ~/ContextFlow-work/quick-insert-25/shadow/spaui.mjs and Safari.
test("a site drawing its sections anew: new roots found by a press, the old ones and the field that went let go", async () => {
  document.getSelection = () => null
  const seen: string[] = []
  const stop = W.watchFields({ focus: (f: any) => seen.push(`focus:${f.el.id}`), blur: () => seen.push("blur"), input: () => undefined, keydown: () => undefined, copy: () => undefined })
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
  /** A section's outlet: a new host with its own open root. */
  const section = (html: string) => {
    const host = document.createElement("div")
    host.className = "interop-outlet"
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = html
    return { host, root, at: (id: string) => root.getElementById(id) }
  }
  /** A press as a browser reports it at the document: its path names each open root it crossed. */
  const press = (path: any[]) => {
    const e = new window.Event("pointerdown", { bubbles: true })
    e.composedPath = () => [...path, document.body, document.documentElement, document, window]
    document.dispatchEvent(e)
  }

  // The messages, loaded from scratch: the reply box gets the focus, heard at the document from the host.
  const messages = section(`<div id="reply" contenteditable="true"><p></p></div>`)
  focus([[document, messages.host], [messages.root, messages.at("reply")]])
  messages.host.dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.deepEqual(seen, ["focus:reply"])

  // To the feed: the messages go with the focus in them, and no blur comes. The field is let go all the same.
  const oldReply = messages.at("reply")
  messages.host.remove()
  focus([[document, document.body], [messages.root, null]])
  await tick()
  assert.deepEqual(seen, ["focus:reply", "blur"], "the field that left the page is no field")
  // Its root is let go: what happens in it isn't heard any more.
  await tick(350)
  oldReply.dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.deepEqual(seen, ["focus:reply", "blur"])

  // The post window in a new root: a press on its frame first (the focus lands on the dialog, never heard as a
  // field), then the editor in the same root: only the root hears that move, and it's listened to since the press.
  const post = section(`<div id="dialog" tabindex="-1"><div id="editor" contenteditable="true"><p></p></div></div>`)
  press([post.at("dialog"), post.root, post.host])
  focus([[document, post.host], [post.root, post.at("editor")]])
  post.at("editor").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.equal(seen.at(-1), "focus:editor", "a root met only by a press is listened to")

  // Back to the messages: a new reply box that the site focuses itself, before any root of it was known (no focus
  // heard for it). It's taken up at the next caret move.
  post.host.remove()
  await tick()
  const back = section(`<div id="reply2" contenteditable="true"><p></p></div><input id="pass2" type="password">`)
  focus([[document, back.host], [back.root, back.at("reply2")]])
  document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }))
  assert.equal(seen.at(-1), "focus:reply2", "the focused reply box is the field")
  const count = seen.length
  document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }))
  assert.equal(seen.length, count, "told once")
  // A password that has the focus is never taken up.
  focus([[document, back.host], [back.root, back.at("pass2")]])
  document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }))
  assert.equal(seen.at(-1), "focus:reply2")

  // Our own panel's root (open in test builds) is never listened to, even when a press goes through it.
  const own = document.createElement("contextflow-root")
  document.documentElement.appendChild(own)
  const ownRoot = own.attachShadow({ mode: "open" })
  ownRoot.innerHTML = `<textarea id="ask"></textarea>`
  press([ownRoot.getElementById("ask"), ownRoot, own])
  ownRoot.getElementById("ask").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.equal(seen.at(-1), "focus:reply2")
  own.remove()

  stop()
  // Stopped: nothing is heard.
  back.at("reply2").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  press([back.at("reply2"), back.root, back.host])
  assert.equal(seen.at(-1), "focus:reply2")
  back.host.remove()
})

test("a section's new host is listened to as it comes, its nested roots too, before any press or focus of the page's", async () => {
  document.getSelection = () => null
  const seen: string[] = []
  const stop = W.watchFields({ focus: (f: any) => seen.push(`focus:${f.el.id}`), blur: () => seen.push("blur"), input: () => undefined, keydown: () => undefined, copy: () => undefined })
  // Drawn in one go, as a section is: the host already has its root and a component two roots deep.
  const host = document.createElement("div")
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<div id="list" tabindex="-1"></div><cf-thread id="thread"></cf-thread>`
  const inner = root.getElementById("thread").attachShadow({ mode: "open" })
  inner.innerHTML = `<div id="nested-reply" contenteditable="true"><p></p></div>`
  document.body.appendChild(host)
  await new Promise((r) => setTimeout(r, 0))
  // The focus moves inside the nested root (only that root hears it): heard, though nothing pressed there.
  focus([[document, host], [root, root.getElementById("thread")], [inner, inner.getElementById("nested-reply")]])
  inner.getElementById("nested-reply").dispatchEvent(new window.Event("focusin", { bubbles: true }))
  assert.deepEqual(seen, ["focus:nested-reply"])
  stop()
  host.remove()
})

test("no button on a search inside a component's root, or inside a search form around the host", () => {
  const search = document.createElement("cf-search-box")
  document.body.appendChild(search)
  search.attachShadow({ mode: "open" }).innerHTML = `<input id="q" type="text" placeholder="Find people">`
  assert.equal(noButtonField(search.shadowRoot.getElementById("q")), true, "the component's name says search")
  const wrapped = document.getElementById("wrapped")
  wrapped.attachShadow({ mode: "open" }).innerHTML = `<input id="w" type="text">`
  assert.equal(noButtonField(wrapped.shadowRoot.getElementById("w")), true, "a role=search form around the host")
  const notes = document.createElement("research-notes")
  document.body.appendChild(notes)
  notes.attachShadow({ mode: "open" }).innerHTML = `<input id="n" type="text">`
  assert.equal(noButtonField(notes.shadowRoot.getElementById("n")), false, "research isn't search")
  notes.remove()
  const o = outlet()
  assert.equal(noButtonField(o.at("headline")), false, "a plain text field in a root keeps the button")
  assert.equal(noButtonField(o.at("post")), false)
  search.remove()
  o.host.remove()
})

test("a code editor around the host, and the site's menu drawn inside the field's root", () => {
  const pre = document.createElement("div")
  pre.className = "cm-editor"
  document.body.appendChild(pre)
  const host = document.createElement("cf-code")
  pre.appendChild(host)
  host.attachShadow({ mode: "open" }).innerHTML = `<div id="c" contenteditable="true"></div>`
  assert.equal(codeField(host.shadowRoot.getElementById("c")), true)
  pre.remove()

  const o = outlet()
  const view = document.defaultView ?? window
  view.getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" })
  const rect = (top: number) => () => ({ top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40 })
  o.at("post").getBoundingClientRect = rect(100)
  assert.equal(siteMenuOpen({ el: o.at("post") }), false)
  const menu = document.createElement("div")
  menu.setAttribute("role", "listbox")
  menu.getBoundingClientRect = rect(150)
  o.root.appendChild(menu)
  assert.equal(siteMenuOpen({ el: o.at("post") }), true, "the mention list in the outlet's root")
  o.host.remove()
})
