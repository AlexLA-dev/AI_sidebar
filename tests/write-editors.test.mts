// «Проверить» in rich-text fields that keep spaces their own way (110, the owner's iPad in Gmail: an underline on a space
// that wasn't there, a «Fix» lit for good, extra spaces after fixes). The field is the sample editor
// (fixtures/sample-editor.mts), with the behaviours recorded on the real Gmail switched on one by one; the code under
// test is the real one: the live check's memory (takeCheck), the underlines (liveState), one fix (fixIssue), all of
// them (fixIssues). The model's stand-in writes plain spaces back, as Haiku does, and puts the planted typos right.
// In real engines (Chromium and WebKit, the same cases): ~/ContextFlow-work/write-110/matrix-pw.mjs.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { paragraphs } from "../src/shared/writing.ts"
import { installEngine, NB, SampleEditor, type Behaviours } from "./fixtures/sample-editor.mts"

let L: any
let document: any

before(async () => {
  let window: any
  ;({ window, document } = parseHTML(`<!doctype html><html><body></body></html>`))
  installEngine(window, document)
  Object.assign(globalThis as any, {
    window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver, location: { href: "https://mail.example/", hostname: "mail.example" },
    chrome: { runtime: { sendMessage: (_m: unknown, cb?: (r: unknown) => void) => cb?.(undefined), lastError: undefined }, storage: { local: { get: (_k: unknown, cb?: (r: unknown) => void) => (cb ? cb({}) : Promise.resolve({})) } }, i18n: { getMessage: () => "", getUILanguage: () => "en" } }
  })
  const dir = mkdtempSync(join(tmpdir(), "cf-write-editors-"))
  const out = join(dir, "live.mjs")
  await build({
    stdin: { contents: `export { fixIssue, fixIssues, liveState, takeCheck } from "./src/content/insert/Underlines"; export { readText } from "./src/content/insert/fieldtext"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"], jsx: "automatic", jsxImportSource: "preact",
    define: { __API_BASE__: '"http://stand"', __VERSION__: '"0"', __TARGET__: '"safari"', __SHADOW_MODE__: '"open"', __TIPS__: "[]", __WATCH_EVERY_S__: "900", "process.env.NODE_ENV": '"test"' }
  })
  L = await import(pathToFileURL(out).href)
})

// The model's stand-in: plain spaces for no-break ones, one space for a run, the planted typos put right.
const FIX: Record<string, string> = { teh: "the", posible: "possible", recieve: "receive", tommorow: "tomorrow", сдесь: "здесь", morgn: "morgen", demian: "demain", tambien: "también", yarin: "yarın", надіюсь: "сподіваюся", wrte: "write" }
const model = (text: string) => text.replace(/[  ]/g, " ").replace(/ {2,}/g, " ").replace(/[\p{L}']+/gu, (w) => FIX[w] ?? w)

const field = (ed: SampleEditor) => ({ el: ed.el, control: false, start: 0, end: 0, range: null })
const make = (is: Behaviours = {}) => {
  const ed = new SampleEditor(document, is)
  ed.focus()
  return ed
}
/** Puts text in as iOS's suggestions do (insertText with the characters as given: G3). */
const suggest = (ed: SampleEditor, text: string) => document.execCommand("insertText", false, text)
/** The check after a pause: every paragraph sent, the reply taken. The underlines as the person sees them. */
const check = (ed: SampleEditor) => {
  const ft = L.readText(ed.el)
  for (const p of paragraphs(ft.text)) L.takeCheck(ed.el, p.text, model(p.text))
  return issues(ed)
}
const issues = (ed: SampleEditor) => L.liveState(field(ed))?.issues ?? []
const was = (i: any) => i.para.slice(i.rel.from, i.rel.to).replace(/ /g, "⍽")
const doubled = (ed: SampleEditor) => /[  ]{2,}/.test(ed.el.textContent)

test("the sample field keeps spaces as Gmail does (G1, G2): a lone one plain, a run ⍽␠, a line's end ⍽, lines as <div>s", () => {
  const ed = make()
  ed.type("One two  three   four \nLine two\rsoft break")
  assert.equal(ed.el.firstChild?.nodeType, 3, "the first line is a bare text node")
  assert.equal(ed.shown(), "One two⍽ three⍽ ⍽four⍽Line twosoft break")
  assert.equal(ed.el.querySelectorAll("div").length, 1)
  assert.equal(ed.el.querySelectorAll("div br").length, 1, "Shift+Return: a <br> inside the line")
  ed.remove()
})

test("the owner's sentence: a no-break space isn't underlined (109, «the- ␣root»)", () => {
  const ed = make()
  suggest(ed, `Is it possible to find the${NB}root of the problem?`)
  assert.deepEqual(check(ed), [])
  // Typed with spaces as the browser keeps them, a whole letter: nothing either.
  const typed = make()
  typed.type("Thanks for the update. \nWe can start on Monday, if that works. ")
  assert.match(typed.shown(), /⍽/)
  assert.deepEqual(check(typed), [])
  ed.remove()
  typed.remove()
})

test("real fixes beside no-break spaces, one by one: each lands, no doubled space, nothing left lit (en ru de fr es tr uk)", async () => {
  for (const text of [`Is it posible to find teh${NB}root of the problem?`, `Мы готовы${NB}начать, но сдесь${NB}нужен ответ.`, `Wir können morgn${NB}anfangen.`, `Merci pour le message ! On commence demian${NB}matin.`, `Gracias, tambien podemos${NB}empezar.`, `Toplantı yarin${NB}sabah başlıyor.`, `Дякую,${NB}надіюсь на відповідь.`]) {
    const ed = make()
    suggest(ed, text)
    let found = check(ed)
    assert.ok(found.length >= 1, text)
    assert.ok(found.every((i: any) => /\p{L}/u.test(was(i))), `only words underlined: ${found.map(was)}`)
    while (found.length) {
      const undo = await L.fixIssue(ed.el, found[0])
      assert.ok(undo && undo !== "refused", `fixed: ${was(found[0])}`)
      found = issues(ed)
    }
    // The words put right; every space as the field had it.
    assert.equal(ed.el.textContent, text.replace(/[\p{L}']+/gu, (w) => FIX[w] ?? w), text)
    assert.equal(doubled(ed), false, text)
    ed.remove()
  }
})

test("a doubled space typed (⍽␠) is a real fix: it goes in, and the typo next to it, with no space too many (G2, G4)", async () => {
  const ed = make()
  ed.type("Thanks teh  team, we recieve the files tommorow.")
  assert.match(ed.shown(), /teh⍽ team/)
  const found = check(ed)
  assert.deepEqual(found.map(was), ["teh⍽ ", "recieve", "tommorow"])
  const done = await L.fixIssues(ed.el, found)
  assert.equal(done.failed, 0)
  assert.equal(ed.el.textContent, "Thanks the team, we receive the files tomorrow.")
  assert.deepEqual(issues(ed), [])
  ed.remove()
})

test("an editor that keeps its own spaces (G10, the owner's iPad): no underline on them, fixes beside them hold", async () => {
  const ed = make({ keepSpaces: true })
  suggest(ed, `Is it posible to find the${NB}root of the problem?`)
  const found = check(ed)
  assert.deepEqual(found.map(was), ["posible"])
  assert.ok(await L.fixIssue(ed.el, found[0]))
  assert.equal(ed.shown(), "Is it possible to find the⍽root of the problem?")
  assert.deepEqual(issues(ed), [])
  ed.remove()
})

test("a field that won't take a fix: the fix goes with its underline, not left lit with a dead «Fix» (one, and all)", async () => {
  const ed = make({ refuse: true })
  ed.type("Thanks teh team, we recieve it.")
  const found = check(ed)
  assert.equal(found.length, 2)
  assert.equal(await L.fixIssue(ed.el, found[0]), "refused")
  assert.equal(ed.el.textContent, "Thanks teh team, we recieve it.", "the field as it was")
  assert.deepEqual(issues(ed).map(was), ["recieve"], "that one's underline is gone; the other is still there")
  const all = await L.fixIssues(ed.el, issues(ed))
  assert.equal(all.undo, null)
  assert.deepEqual(issues(ed), [], "nothing left lit")
  ed.remove()
})

test("an editor that draws its text again after each input (G5: React and the like): every fix lands", async () => {
  const ed = make({ rebuild: true })
  suggest(ed, `Thanks teh${NB}team, we recieve the files tommorow.`)
  const done = await L.fixIssues(ed.el, check(ed))
  assert.equal(done.failed, 0)
  assert.equal(ed.shown(), "Thanks the⍽team, we receive the files tomorrow.")
  assert.equal(doubled(ed), false)
  assert.deepEqual(issues(ed), [])
  ed.remove()
})

test("a page that takes pastes itself and won't be typed into by a script (G6): the fix goes in as a paste", async () => {
  const ed = make({ ownPaste: true, typingRefused: true })
  ed.type("Thanks teh team.")
  const found = check(ed)
  assert.ok(await L.fixIssue(ed.el, found[0]))
  assert.ok(ed.log.includes("paste"))
  assert.equal(ed.el.textContent, "Thanks the team.")
  assert.deepEqual(issues(ed), [])
  ed.remove()
})

test("a reply box with a hint that can't be edited (G9): the hint is never underlined or changed", async () => {
  const ed = make({ hint: "Press / to wrte" })
  ed.type("Thanks teh team.")
  const found = check(ed)
  assert.deepEqual(found.map(was), ["teh"])
  assert.ok(await L.fixIssue(ed.el, found[0]))
  assert.match(ed.el.textContent, /^Press \/ to wrteThanks the team\.$/)
  ed.remove()
})

test("a draft opened again (G8: drawn anew, wrapped, a stray line break after it): read the same, fixes land", async () => {
  const first = make()
  first.type("Thanks teh  team.\nSee you tommorow. ")
  const again = first.reopened()
  again.focus()
  assert.deepEqual(paragraphs(L.readText(again.el).text).map((p: any) => p.text.replace(/ /g, "⍽")), ["Thanks teh⍽ team.", "See you tommorow."])
  const done = await L.fixIssues(again.el, check(again))
  assert.equal(done.failed, 0)
  assert.equal(again.el.textContent.replace(/\n$/, ""), "Thanks the team.See you tomorrow. ")
  assert.deepEqual(issues(again), [])
  again.remove()
})

test("a field taken out of the page (G7/G8: the window closed, the conversation left): no underlines, a fix does nothing", async () => {
  const ed = make()
  ed.type("Thanks teh team.")
  const found = check(ed)
  ed.remove()
  assert.equal(L.liveState(field(ed)), null)
  const r = await L.fixIssue(ed.el, found[0])
  assert.ok(r === null || r === "refused")
})
