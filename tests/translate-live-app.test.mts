// 2.7 build 110: page translation on a page that behaves like a web mailbox (tests/stands/live-app.mjs, built from a
// record of what a real one does to its page on each switch). For each switch: the translation holds, what's new is
// translated, words translated before never show in the original once the site's change is over (no flash), and
// nothing of it is another page for the server (a letter inside the mailbox isn't a new answer).
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { HINT, mountLiveApp, wordsOf } from "./stands/live-app.mjs"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-translate-live-"))
  const src = new URL("../src/content/translate/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, [
    `export * from "${src}blocks.ts"`,
    `export * from "${src}engine.ts"`,
    `export { urlKey } from "${new URL("../src/shared/conversation.ts", import.meta.url).pathname}"`
  ].join("\n"))
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const marked = (mark: string) => (text: string) => text.replace(/(^|>)([^<]+)/g, (_m: string, a: string, w: string) => `${a}${mark}${w}`)
const CYRILLIC = /\p{Script=Cyrillic}/u
const LETTERS = /\p{L}/gu

class Observer {
  static last: Observer | null = null
  cb: (records: unknown[]) => void
  constructor(cb: (records: unknown[]) => void) {
    this.cb = cb
    Observer.last = this
  }
  observe() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

/** Not shown: it, or something that holds it, is hidden the way the app hides a view (or by the attribute). */
const hiddenEl = (el: Element | null): boolean => {
  for (let at = el; at; at = at.parentElement) if (/display:\s*none/.test(at.getAttribute("style") ?? "") || at.hasAttribute("hidden")) return true
  return false
}

/** An IntersectionObserver for a page without layout: what's connected and not hidden is on screen. */
class Layout {
  static last: Layout | null = null
  cb: (entries: unknown[]) => void
  seen = new Set<Element>()
  constructor(cb: (entries: unknown[]) => void) {
    this.cb = cb
    Layout.last = this
  }
  observe(el: Element) {
    this.seen.add(el)
  }
  unobserve(el: Element) {
    this.seen.delete(el)
  }
  disconnect() {
    this.seen.clear()
  }
  look() {
    if (!this.seen.size) return
    const root = { top: -300, bottom: 1700, left: 0, right: 400 }
    this.cb([...this.seen].map((target) => {
      const on = target.isConnected && !hiddenEl(target)
      return { target, isIntersecting: on, rootBounds: root, boundingClientRect: on ? { top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20 } : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } }
    }))
  }
}

interface Stand {
  document: Document
  app: any
  translator: any
  asks: any[]
  flashes: string[]
  settle: (ms?: number) => Promise<void>
  shownWords: () => string[]
  untranslated: () => string[]
}

const running: any[] = []
afterEach(() => {
  for (const t of running.splice(0)) t.original()
})

/** The words a reader can see: text that shows, outside what's the reader's own or marked as names. */
function shownTexts(document: Document): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(document.body, 4)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const el = n.parentElement
    if (!el || (n.data.match(LETTERS)?.length ?? 0) < 2) continue
    if (el.closest('[translate="no"],[contenteditable],[role=textbox],script,style') || hiddenEl(el)) continue
    out.push(n)
  }
  return out
}

interface StandOpts {
  delay?: number
  // "ru-en": a Russian interface around letters in English, translated into English («EN »); else all German → «RU ».
  words?: "de" | "ru-en"
}

function stand(opts: StandOpts = {}): Stand {
  const mark = opts.words === "ru-en" ? "EN " : "RU "
  const fake = marked(mark)
  const done = new RegExp(`^\\s*${mark}`)
  // What should be translated: everything (a German page), or what's in Russian (the interface around the letters).
  const due = (text: string) => opts.words !== "ru-en" || CYRILLIC.test(text)
  const { document } = parseHTML(`<!doctype html><html lang="de"><head><title>Postfach</title></head><body></body></html>`)
  const asks: any[] = []
  const flashes: string[] = []
  // Every original the reader has seen in their language already, by where it stands (the kind of element): seeing
  // it there in the original again is a flash. (The same words in another kind of place, a letter's heading after
  // its row in the list, are new to the engine and take a request.)
  const translatedOnce = new Set<string>()
  const place = (n: Text, words: string) => `${n.parentElement!.tagName}.${n.parentElement!.getAttribute("class") ?? ""}|${words}`
  const note = () => {
    for (const n of shownTexts(document)) if (done.test(n.data)) translatedOnce.add(place(n, n.data.replace(done, "").trim()))
  }
  let address = ""
  let watched: Set<string> | null = null
  const app = mountLiveApp(document, {
    manual: true,
    words: opts.words,
    onAddress: (u: string) => (address = u),
    records: (list: any[]) => {
      // As a browser reports them to the engine's observer: its own choice of attributes, all in one call.
      watched ??= new Set(["hidden", "aria-hidden", "open", ...lib.WORD_ATTRS])
      const seen = list.filter((r) => r.type !== "attributes" || watched!.has(r.attributeName))
      if (seen.length) Observer.last?.cb(seen)
      // The site's change is over, the screen is drawn: nothing translated before may show in the original.
      for (const n of shownTexts(document)) if (translatedOnce.has(place(n, n.data.trim()))) flashes.push(n.data.trim())
      Layout.last?.look()
    }
  })
  address = app.url()
  const translator = new lib.PageTranslator({
    doc: document,
    observers: { mutation: Observer, intersection: Layout },
    url: () => address,
    site: () => "post.example",
    ask: (ask: any, on: (r: any) => void) => {
      const req = asks.push(ask)
      setTimeout(() => {
        on({ type: "items", req, items: ask.blocks.map((b: any) => ({ id: b.id, text: fake(b.text) })) })
        on({ type: "done", req, charged: ask.first })
      }, opts.delay ?? 2)
      return () => undefined
    },
    cache: { load: async () => new Map(), save: () => undefined, loadSite: async () => new Map(), saveSite: () => undefined }
  })
  running.push(translator)
  const settle = async (ms = 260) => {
    // The engine's own short waits (reading again, sending), with what shows looked at as a browser would.
    for (let t = 0; t < ms; t += 40) {
      Layout.last?.look()
      await wait(40)
    }
    note()
  }
  return {
    document, app, translator, asks, flashes, settle,
    shownWords: () => shownTexts(document).map((n) => n.data.trim()),
    untranslated: () => shownTexts(document).map((n) => n.data.trim()).filter((t) => due(t) && !t.startsWith(mark))
  }
}

async function translated(opts: StandOpts = {}): Promise<Stand> {
  const s = stand(opts)
  if (opts.words === "ru-en") await s.translator.start("en", "ru", "controls")
  else await s.translator.start("ru", "de")
  await s.settle(400)
  return s
}

const labels = (root: Element | Document, sel = "[role=toolbar] [role=button]") => Array.from(root.querySelectorAll(sel)).filter((b) => !hiddenEl(b))

// ------------------------------------------------------------------ the mailbox as it opens

test("live app: the list, its tabs, its buttons' names, its tooltip elements and its hints are translated; senders' names aren't", async () => {
  const s = await translated()
  assert.deepEqual(s.untranslated(), [], "everything that shows is in the reader's language")
  const { document } = s
  assert.equal(document.querySelector("tr .name")!.textContent, "Stadtwerke Köln", "a name stays")
  assert.equal(document.querySelector("tr .subject")!.textContent, "RU Ihre Abrechnung für Oktober")
  assert.equal(document.querySelector("tr .when span span")!.textContent, "RU 16. Nov.", "the date the eye sees (aria-hidden)")
  assert.equal(s.app.els.search.getAttribute("placeholder"), "RU In allen Nachrichten suchen")
  for (const b of labels(document)) assert.match(b.getAttribute("aria-label")!, /^RU /, "an icon button's name")
  assert.ok(s.asks.length > 0 && s.asks.filter((a) => a.first).length === 1)
})

// ------------------------------------------------------------------ list → letter → list (A, B, D, F, K, I)

test("live app: a letter opened inside the mailbox is translated, late pieces and late labels too; it isn't another page", async () => {
  const s = await translated()
  const page = lib.urlKey(s.asks[0].url)
  s.app.open(0)
  await s.settle()
  s.app.run(200)
  await s.settle()
  s.app.run(600)
  await s.settle()
  assert.match(s.app.url(), /#inbox\/letter0$/, "the address changed after #")
  assert.deepEqual(s.untranslated(), [])
  const view = s.document.querySelector("[data-view=letter]")!
  assert.equal(view.querySelector("h2")!.textContent, "RU Ihre Abrechnung für Oktober")
  assert.deepEqual(Array.from(view.querySelectorAll(".quick button")).map((b) => b.textContent), ["RU Vielen Dank!", "RU Ich melde mich später.", "RU Das passt mir gut."], "what came 600 ms later")
  for (const b of labels(view)) {
    assert.match(b.getAttribute("aria-label")!, /^RU /)
    assert.match(b.getAttribute("data-tooltip")!, /^RU /, "the tooltip the site moved from title")
    assert.equal(b.hasAttribute("title"), false)
  }
  // One page for the server, charged once: the same address before #, and only the first request says `first`.
  assert.ok(s.asks.every((a) => lib.urlKey(a.url) === page), "every request goes by the mailbox's address")
  assert.equal(s.asks.filter((a) => a.first).length, 1)
  assert.deepEqual(s.flashes, [])
})

test("live app: back to the list, its rows redrawn by the site in three waves: no word shows in the original, and nothing is asked for again", async () => {
  const s = await translated()
  s.app.open(1)
  await s.settle()
  s.app.run(700)
  await s.settle()
  const asked = s.asks.length
  s.app.back()
  assert.deepEqual(s.untranslated(), [], "the list comes back translated (the same nodes)")
  const firstCell = s.document.querySelector("tr td.what")
  // The line that comes up at +500 ms is new to the page: it takes a request. Everything else was seen before.
  const line = ["Die Unterhaltung wurde als ungelesen markiert.", "Rückgängig"]
  for (const ms of [300, 800, 400]) {
    s.app.run(ms)
    // At once: the site's change is over and the words are the reader's again.
    assert.deepEqual(s.untranslated().filter((t) => !line.includes(t)), [], `after the wave at +${ms} ms`)
    await wait(120)
  }
  assert.notEqual(s.document.querySelector("tr td.what"), firstCell, "the cells are new ones")
  await s.settle()
  assert.deepEqual(s.untranslated(), [], "the line too, a moment later")
  assert.equal(s.document.querySelector(".toast .undo")!.textContent, "RU Rückgängig")
  assert.deepEqual(s.flashes, [], "words translated before never showed in the original")
  const since = s.asks.slice(asked).flatMap((a) => a.blocks.map((b: any) => b.text))
  assert.ok(since.every((t: string) => line.some((l) => t.includes(l))), `only the new line was asked for: ${JSON.stringify(since)}`)
  s.app.run(4200)
  assert.equal(s.document.querySelector(".toast"), null, "and it goes away")
})

test("live app: the same letter opened again is in the reader's language at once, from what's kept", async () => {
  const s = await translated()
  s.app.open(0)
  await s.settle()
  s.app.run(700)
  await s.settle()
  s.app.back()
  s.app.run(2000)
  await s.settle()
  const asked = s.asks.length
  s.app.open(0)
  assert.equal(s.document.querySelector("[data-view=letter] h2")!.textContent, "RU Ihre Abrechnung für Oktober", "no wait")
  assert.deepEqual(s.untranslated(), [])
  s.app.run(700)
  assert.deepEqual(s.untranslated(), [])
  await s.settle()
  assert.equal(s.asks.length, asked)
  assert.deepEqual(s.flashes, [])
})

// ------------------------------------------------------------------ folders, tabs, search, pages (A, B, C, F, K)

test("live app: a folder's list is translated when first opened, and still is when the inbox comes back (hidden meanwhile, the same nodes)", async () => {
  const s = await translated()
  s.app.folder("sent")
  await s.settle()
  s.app.run(200)
  await s.settle()
  assert.deepEqual(s.untranslated(), [])
  assert.equal(s.document.querySelector("[data-view=sent] .subject")!.textContent, "RU Frage zur Nebenkostenabrechnung")
  const asked = s.asks.length
  s.app.folder("inbox")
  assert.deepEqual(s.untranslated(), [])
  s.app.folder("sent")
  assert.deepEqual(s.untranslated(), [])
  s.app.run(200)
  await s.settle()
  assert.equal(s.asks.length, asked, "both lists were translated already")
  assert.deepEqual(s.flashes, [])
})

test("live app: a tab changes the search field's hint, which is translated; the first tab's hint comes back at once", async () => {
  const s = await translated()
  s.app.tab(1)
  await s.settle()
  assert.equal(s.app.els.search.getAttribute("placeholder"), "RU In der Werbung suchen")
  assert.equal(s.app.els.search.getAttribute("aria-label"), "RU Nachrichten durchsuchen", "a label written again with its own value stays translated")
  assert.deepEqual(s.untranslated(), [])
  const asked = s.asks.length
  s.app.tab(0)
  assert.equal(s.app.els.search.getAttribute("placeholder"), "RU In allen Nachrichten suchen", "kept: no wait")
  await s.settle()
  assert.equal(s.asks.length, asked)
  assert.match(s.app.url(), /#inbox$/, "a tab doesn't change the address")
})

test("live app: search results that come a moment later are translated; the view is gone when left and the inbox is as it was", async () => {
  const s = await translated()
  s.app.search()
  await s.settle()
  assert.deepEqual(s.untranslated(), [], "«searching…» too")
  s.app.run(500)
  await s.settle()
  assert.deepEqual(s.untranslated(), [])
  assert.equal(s.document.querySelectorAll("[data-view=search] tr").length, 2)
  s.app.folder("inbox")
  assert.equal(s.document.querySelector("[data-view=search]"), null)
  assert.deepEqual(s.untranslated(), [])
  assert.deepEqual(s.flashes, [])
})

test("live app: the next page of the list, arriving in chunks, is translated chunk by chunk", async () => {
  const s = await translated()
  s.app.nextPage()
  for (let chunk = 1; chunk <= 3; chunk++) {
    s.app.run(350)
    await s.settle()
    assert.equal(s.document.querySelectorAll("[data-view=page2] tr").length, chunk * 2)
    assert.deepEqual(s.untranslated(), [], `chunk ${chunk}`)
  }
  assert.equal(s.asks.filter((a) => a.first).length, 1, "still the same page for the server")
})

// ------------------------------------------------------------------ inside a letter (E, G, H)

test("live app: a collapsed letter of a thread, opened, is translated; a tooltip added at the pointer says the translated name at once", async () => {
  const s = await translated()
  s.app.open(0)
  await s.settle()
  s.app.run(700)
  await s.settle()
  assert.equal(s.app.expand(0), true)
  await s.settle()
  assert.deepEqual(s.untranslated(), [])
  assert.match(s.document.querySelector("[data-view=letter] .collapsed .body p")!.textContent!, /^RU Vielen Dank/)
  const asked = s.asks.length
  const button = s.app.hover(1)
  const tip = s.document.querySelector(".tip.floating")!
  assert.equal(tip.textContent, button.getAttribute("aria-label"), "the tooltip element says what the button is called")
  assert.match(tip.textContent!, /^RU /, "at once: the words were kept")
  await s.settle()
  assert.equal(s.asks.length, asked)
})

test("live app: the reply box: its fields' names and its buttons are translated; what's in the editor and in the fields stays as it is", async () => {
  const s = await translated()
  s.app.open(2)
  await s.settle()
  s.app.run(700)
  await s.settle()
  s.app.reply()
  await s.settle()
  s.app.run(150)
  await s.settle()
  const box = s.document.querySelector(".compose")!
  assert.equal(box.querySelector(".editor blockquote")!.textContent, "Bitte denken Sie an Ihren Termin am Donnerstag.", "the quoted letter in the editor isn't touched")
  assert.equal(box.querySelector(".editor")!.getAttribute("aria-label"), "Nachrichtentext")
  const subject = box.querySelector('input[placeholder]')!
  assert.equal(subject.getAttribute("value"), "Re: Erinnerung an Ihren Termin", "what's typed in a field stays")
  assert.equal(subject.getAttribute("placeholder"), "RU Betreff")
  assert.equal(box.querySelector(".send")!.textContent, "RU Senden")
  for (const b of labels(box)) if (!b.classList.contains("send")) assert.match(b.getAttribute("aria-label")!, /^RU /)
  assert.deepEqual(s.untranslated(), [])
  assert.match(s.app.url(), /letter2$/, "no address change for the reply box")
})

// ------------------------------------------------------------------ what never stops (J, L)

test("live app: the quiet tick (wordless nodes, styles) costs no request and changes nothing", async () => {
  const s = await translated()
  const asked = s.asks.length
  const before = s.shownWords().join("|")
  for (let i = 0; i < 8; i++) {
    s.app.tick()
    await wait(30)
  }
  await s.settle()
  assert.equal(s.asks.length, asked)
  assert.equal(s.shownWords().join("|"), before)
})

test("live app: a hint the site writes back on a timer stays translated, with no flash; one it defends with an observer is left to it", async () => {
  const s = await translated()
  assert.equal(s.app.els.hint.textContent, `RU ${HINT}`)
  const asked = s.asks.length
  // On a timer: when the site finds other words there, it draws its own again; a few times a second, for a while.
  for (let i = 0; i < 20; i++) {
    assert.equal(s.app.hintAgain(), true, "the site sees our words and writes its own")
    assert.equal(s.app.els.hint.textContent, `RU ${HINT}`, `round ${i}: ours again before the screen is drawn`)
    await wait(40)
  }
  assert.deepEqual(s.flashes, [])
  assert.equal(s.asks.length, asked)
  // By an observer: again the moment the words aren't its own. It must end, with the site's words.
  let rounds = 0
  while (s.app.hintAgain() && rounds < 500) rounds++
  assert.ok(rounds < 20, `the two stopped after ${rounds} rounds`)
  assert.equal(s.app.els.hint.textContent, HINT)
  assert.deepEqual(s.untranslated(), [HINT], "only the hint is the site's; the rest stays translated")
})

// ------------------------------------------------------------------ a Russian interface around letters in English
// (the owner's mailbox on 109: «элементы интерфейса НЕ перевелись с русского на английский, как изначально в общем
// меню писем (например даты справа), так и после открытия письма внутри кнопки, даты и прочие элементы вне тела письма»)

test("live app, only buttons and menus translated: the page's own Russian words are, in every row too (chips, dates); the English letters are never sent", async () => {
  const s = await translated({ words: "ru-en" })
  const W = wordsOf("ru-en")
  assert.deepEqual(s.untranslated(), [], "no Russian left on the screen")
  const row = s.document.querySelector("tr[role=row]")!
  assert.equal(row.querySelector(".chip")!.textContent, `EN ${W.chip}`, "the label's chip in a row")
  assert.equal(row.querySelector(".when span span")!.textContent, "EN 16 нояб.", "the date in a row")
  assert.equal(row.querySelector(".subject")!.textContent, "Your October statement", "the letter's own words stay")
  assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[0][1]}`)
  // Free: every request says it's controls, every block is short and Russian; nothing English left the page.
  const sent = s.asks.flatMap((a) => a.blocks.map((b: any) => b.text))
  assert.ok(s.asks.length > 0 && s.asks.every((a) => a.kind === "controls"))
  assert.ok(sent.every((t: string) => CYRILLIC.test(t) && t.replace(/<\/?\d+\/?>/g, "").length <= 80), JSON.stringify(sent.filter((t: string) => !CYRILLIC.test(t))))
})

test("live app, only buttons and menus translated: an opened letter's «to: me», its time, «Reply», «Forward», the badge and the late buttons are translated; its body isn't touched", async () => {
  const s = await translated({ words: "ru-en" })
  const W = wordsOf("ru-en")
  s.app.open(0)
  await s.settle()
  s.app.run(200)
  await s.settle()
  s.app.run(600)
  await s.settle()
  const view = s.document.querySelector("[data-view=letter]")!
  assert.deepEqual(s.untranslated(), [])
  assert.equal(view.querySelector(".tome")!.textContent, `EN ${W.toMe}`)
  assert.equal(view.querySelector(".head .when")!.textContent, `EN ${W.ago}`)
  assert.deepEqual(Array.from(view.querySelectorAll(".answer > [role=link]")).map((b) => b.textContent), [`EN ${W.reply}`, `EN ${W.forward}`, `EN ${W.share}EN ${W.badge}`], "what the page calls links")
  assert.deepEqual(Array.from(view.querySelectorAll(".quick button")).map((b) => b.textContent), W.quick.map((q: string) => `EN ${q}`))
  assert.equal(view.querySelector(".body p")!.textContent, "Hello, your statement for October is ready.")
  assert.equal(view.querySelector("h2")!.textContent, "Your October statement")
  for (const b of labels(view)) assert.match(b.getAttribute("aria-label")!, /^EN /)
  // The site set the search hint again when the view changed: it's still the reader's.
  assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[0][1]}`)
  assert.ok(s.asks.every((a) => a.kind === "controls"))
  assert.deepEqual(s.flashes, [])
})

test("live app, only buttons and menus translated: back in the list the redrawn rows' chips and dates, the hint set again and the line that comes up later are all translated", async () => {
  const s = await translated({ words: "ru-en" })
  const W = wordsOf("ru-en")
  s.app.open(1)
  await s.settle()
  s.app.run(700)
  await s.settle()
  s.app.back()
  assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[0][1]}`, "the hint the site wrote again: ours at once")
  for (const ms of [300, 800, 400]) {
    s.app.run(ms)
    assert.deepEqual(s.untranslated().filter((t) => t !== W.toast && t !== W.undo), [], `after the wave at +${ms} ms`)
    await wait(120)
  }
  await s.settle()
  assert.equal(s.document.querySelector(".toast .toast-words")!.textContent, `EN ${W.toast}`, "a sentence, not a button: the page's own words")
  assert.equal(s.document.querySelector(".toast .undo")!.textContent, `EN ${W.undo}`)
  assert.deepEqual(s.untranslated(), [])
  assert.deepEqual(s.flashes, [])
  assert.ok(s.asks.every((a) => a.kind === "controls" && !a.first === (s.asks.indexOf(a) > 0)))
})

test("live app: after the site has set its search hint again on many switches, a tab's new hint is still translated", async () => {
  const s = await translated({ words: "ru-en" })
  const W = wordsOf("ru-en")
  // Six switches in a row, each setting the hint again with the words it had.
  for (let i = 0; i < 3; i++) {
    s.app.open(i)
    await wait(60)
    s.app.back()
    await wait(60)
    assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[0][1]}`)
  }
  s.app.tab(1)
  await s.settle()
  assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[1][1]}`, "new words: asked for, not taken for a clock")
  s.app.tab(0)
  assert.equal(s.app.els.search.getAttribute("placeholder"), `EN ${W.TABS[0][1]}`)
})

test("live app, only buttons and menus translated: a walk through every switch leaves no Russian on the screen and sends no English", async () => {
  const s = await translated({ words: "ru-en" })
  const steps: Array<[string, () => void, number]> = [
    ["a letter", () => s.app.open(0), 700], ["a collapsed letter", () => s.app.expand(0), 0], ["the reply box", () => s.app.reply(), 150], ["back", () => s.app.back(), 2000],
    ["a tab", () => s.app.tab(1), 0], ["the first tab", () => s.app.tab(0), 0], ["sent", () => s.app.folder("sent"), 200],
    ["search", () => s.app.search(), 500], ["inbox", () => s.app.folder("inbox"), 200], ["next page", () => s.app.nextPage(), 1100]
  ]
  for (const [name, act, ms] of steps) {
    act()
    await s.settle(120)
    if (ms) s.app.run(ms)
    await s.settle()
    assert.deepEqual(s.untranslated(), [], `after: ${name}`)
  }
  const sent = s.asks.flatMap((a) => a.blocks.map((b: any) => b.text))
  assert.ok(sent.every((t: string) => CYRILLIC.test(t)), `English went out: ${JSON.stringify(sent.filter((t: string) => !CYRILLIC.test(t)))}`)
  assert.ok(s.asks.every((a) => a.kind === "controls"))
  assert.deepEqual(s.flashes, [])
})

// ------------------------------------------------------------------ the whole walk

test("live app: a walk through every switch is one page for the server, and «Original» puts everything back", async () => {
  const s = stand()
  const html = () => s.document.body.innerHTML
  const start = html()
  await s.translator.start("ru", "de")
  await s.settle(400)
  const steps: Array<[string, () => void, number]> = [
    ["a letter", () => s.app.open(0), 700], ["a collapsed letter", () => s.app.expand(0), 0], ["back", () => s.app.back(), 2000],
    ["a tab", () => s.app.tab(1), 0], ["the first tab", () => s.app.tab(0), 0], ["sent", () => s.app.folder("sent"), 200],
    ["search", () => s.app.search(), 500], ["inbox", () => s.app.folder("inbox"), 200], ["next page", () => s.app.nextPage(), 1100]
  ]
  for (const [name, act, ms] of steps) {
    act()
    await s.settle(120)
    if (ms) s.app.run(ms)
    await s.settle()
    assert.deepEqual(s.untranslated(), [], `after: ${name}`)
  }
  const page = lib.urlKey(s.asks[0].url)
  assert.ok(s.asks.every((a) => lib.urlKey(a.url) === page))
  assert.equal(s.asks.filter((a) => a.first).length, 1, "one answer")
  assert.deepEqual(s.flashes, [])
  s.translator.original()
  assert.ok(!/RU /.test(html()), "no translated word left")
  assert.ok(!/ lang="ru"/.test(html()))
  void start
})
