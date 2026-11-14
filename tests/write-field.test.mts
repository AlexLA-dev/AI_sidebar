// «Проверить» и «Переписать» (2.7): a field's text as they work on it. An editor's text block by block, a signature and
// quoted mail kept out, the part with the caret or the selection worked on, and each character's place in the DOM, so a
// fix lands on its own words. Making the changes in real engines: ~/ContextFlow-work/proofread-27/panel (Chromium).
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let F: any
let document: any

before(async () => {
  let window: any
  ;({ window, document } = parseHTML(`<!doctype html><html><body>
<textarea id="note">  Hi Anna, see you tomorow.  </textarea>
<div id="mail" contenteditable="true"><div dir="ltr">Hi Katarina,<br><br>Thanks for teh update. <b>Friday</b> works.<br></div><br><span class="gmail_signature_prefix">-- </span><div class="gmail_signature" data-smartmail="gmail_signature">Alex Smith<br>Northwind</div><div class="gmail_quote">On Mon, Katarzyna wrote:<blockquote>Can we move it?</blockquote></div></div>
<div id="post" contenteditable="true"><p>Great post <span contenteditable="false">@Siddharth Raghunathan</span> realy.</p><p>Second line here</p></div>
<div id="reply" contenteditable="true"><blockquote>Quoted first</blockquote><p>My answer is here</p></div>
<form><input id="cc" autocomplete="cc-number"><input id="name" type="text" value="Alex"></form>
</body></html>`))
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  const dir = mkdtempSync(join(tmpdir(), "cf-write-field-"))
  const out = join(dir, "fieldtext.mjs")
  await build({
    stdin: { contents: `export * from "./src/content/insert/fieldtext"; export { sensitiveForm } from "./src/content/insert/field"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"]
  })
  F = await import(pathToFileURL(out).href)
})

const $ = (id: string) => document.getElementById(id)

test("a textarea: its value, the white space at its ends left out, or the selection", () => {
  const el = $("note")
  const ft = F.readText(el)
  assert.equal(ft.text, "  Hi Anna, see you tomorow.  ")
  const all = F.workRange({ el, control: true, start: 3, end: 3, range: null }, ft)
  assert.equal(ft.text.slice(all.from, all.to), "Hi Anna, see you tomorow.")
  assert.equal(all.selected, false)
  const sel = F.workRange({ el, control: true, start: 11, end: 27, range: null }, ft)
  assert.deepEqual([ft.text.slice(sel.from, sel.to), sel.selected], ["see you tomorow.", true])
})

test("a mail's editor: lines and paragraphs as line breaks; the signature and the quoted mail never worked on", () => {
  const el = $("mail")
  const ft = F.readText(el)
  assert.ok(ft.text.startsWith("Hi Katarina,\n\nThanks for teh update. Friday works.\n"))
  assert.equal(ft.skips.length, 4, "the signature's \"-- \", the signature, the quote, and the blockquote inside it")
  // The caret in the first line: the part before the signature.
  const textNode = el.querySelector("div").firstChild
  const first = { startContainer: textNode, startOffset: 2, endContainer: textNode, endOffset: 2, collapsed: true }
  const r = F.workRange({ el, control: false, start: 0, end: 0, range: first }, ft)
  assert.equal(ft.text.slice(r.from, r.to), "Hi Katarina,\n\nThanks for teh update. Friday works.")
  // No caret known: the longest part.
  const none = F.workRange({ el, control: false, start: 0, end: 0, range: null }, ft)
  assert.equal(none.from, r.from)
})

/** linkedom's Range has no setStart: one that keeps its ends and reads the text between them, node by node. */
function fakeRanges(ft: any) {
  document.createRange = () => {
    const r: any = { setStart(n: any, o: number) { r.sc = n; r.so = o }, setEnd(n: any, o: number) { r.ec = n; r.eo = o } }
    r.toString = () => {
      const i = ft.spans.findIndex((s: any) => s.node === r.sc)
      const j = ft.spans.findIndex((s: any) => s.node === r.ec)
      if (i === j) return r.sc.data.slice(r.so, r.eo)
      return [r.sc.data.slice(r.so), ...ft.spans.slice(i + 1, j).map((s: any) => s.node.data), r.ec.data.slice(0, r.eo)].join("")
    }
    return r
  }
}

test("each character's place in the DOM: a fix's range covers its own words, across a bold word too", () => {
  const el = $("mail")
  const ft = F.readText(el)
  fakeRanges(ft)
  const at = ft.text.indexOf("teh")
  const range = F.domRange(el, ft, at, at + 3)
  assert.equal(range.toString(), "teh")
  const name = ft.text.indexOf("Katarina")
  assert.equal(F.domRange(el, ft, name, name + 8).toString(), "Katarina")
  const span = ft.text.indexOf("update. Friday")
  assert.equal(F.domRange(el, ft, span, span + "update. Friday".length).toString(), "update. Friday")
  // Offsets back from a DOM point.
  const b = el.querySelector("b")
  assert.equal(F.offsetOf(ft, b.firstChild, 0), ft.text.indexOf("Friday"))
  assert.equal(F.offsetOf(ft, b, 0), ft.text.indexOf("Friday"))
})

test("what a fix one by one never touches: a mention chip, a paragraph break", () => {
  const el = $("post")
  const ft = F.readText(el)
  assert.equal(ft.text, "Great post @Siddharth Raghunathan realy.\nSecond line here\n")
  const chip = ft.text.indexOf("Siddharth")
  assert.equal(F.editBlocked(ft, chip, chip + 4), true)
  const typo = ft.text.indexOf("realy")
  assert.equal(F.editBlocked(ft, typo, typo + 5), false)
  assert.equal(F.editBlocked(ft, ft.text.indexOf("realy."), ft.text.indexOf("Second") + 2), true)
  assert.equal(F.editBlocked(F.readText($("note")), 0, 5), false, "a textarea's line breaks are its own")
})

test("a reply under a quote: the answer is worked on, not the quote", () => {
  const el = $("reply")
  const ft = F.readText(el)
  const r = F.workRange({ el, control: false, start: 0, end: 0, range: null }, ft)
  assert.equal(ft.text.slice(r.from, r.to), "My answer is here")
})

test("text compared after a change: an editor's no-break spaces and blank lines don't count", () => {
  assert.equal(F.sameText("Hi Anna,\n\n\nthere ", "Hi Anna,\nthere"), true)
  assert.equal(F.sameText("Hi Anna", "Hi Ann"), false)
  assert.equal(F.changedEnd("abcdef", "abXYZdef", 3), 5)
})

test("a card field's form is never read", () => {
  assert.equal(F.sensitiveForm($("name")), true)
  assert.equal(F.sensitiveForm($("note")), false)
})
