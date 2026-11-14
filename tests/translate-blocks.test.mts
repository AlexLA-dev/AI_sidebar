// 2.7, a page translated in place (src/content/translate): the page's blocks of words (never its menus, header,
// footer, inputs, code or editors), the translation written into the same text nodes and the same elements (a link
// stays that link, with its address and listeners), "Original" putting every word and element back, and the engine:
// what's kept is reused without the server, the page's first request goes alone, the limit stops it.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

type Block = { parent: Element; nodes: Node[]; tags: Map<number, Element>; text: string }
type Applied = unknown
let lib: {
  collectBlocks: (root: Element) => Block[]
  applyBlock: (block: Block, translation: string) => Applied | null
  restore: (done: Applied) => void
  scanRoot: (el: Element) => Element | null
  PageTranslator: new (deps: Record<string, unknown>) => {
    start(to: string, from: string | null): Promise<void>
    original(): void
    state(): { at: string; code?: string }
    subscribe(fn: (s: { at: string }) => void): () => void
  }
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-translate-"))
  const entry = join(dir, "entry.ts")
  const src = new URL("../src/content/translate/", import.meta.url).pathname
  writeFileSync(entry, `export * from "${src}blocks.ts"\nexport { PageTranslator } from "${src}engine.ts"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const page = (body: string) => parseHTML(`<!doctype html><html lang="de"><head><title>t</title></head><body>${body}</body></html>`)

const ARTICLE = `
<header class="site"><nav><a href="/">Startseite</a><a href="/news">Nachrichten</a></nav><div>Mein Konto</div></header>
<main>
  <article>
    <header><h1>Die <em>neue</em> Brücke ist offen</h1></header>
    <p id="p1">Die Stadt hat am Montag die Brücke <a id="l1" href="https://example.de/bruecke">über den Fluss</a> eröffnet.</p>
    <p>Mehr dazu <a href="/mehr">hier</a> und <a href="/dort">dort</a>.<br>Neue Zeile.</p>
    <ul><li>Erster Punkt der Liste</li><li>Zweiter Punkt <ul><li>Unterpunkt eins</li></ul></li></ul>
    <table><tr><td>Länge der Brücke</td><td>420 m</td></tr></table>
    <pre>const brücke = offen</pre>
    <p>Der Befehl <code>npm start</code> startet alles.</p>
    <div contenteditable="true">Ihr Kommentar hier</div>
    <p translate="no">Markenname bleibt</p>
    <p class="notranslate">Auch dieser bleibt</p>
    <form><label>Name <input name="n"></label><button>Absenden</button></form>
    <div>Ein Text ohne Absatz <b>fett</b><p>Absatz im Block</p>und noch ein Rest danach</div>
    <p><span><span>Ganz in Spannen verpackt</span></span></p>
  </article>
</main>
<footer><p>Impressum und Datenschutz</p></footer>
<contextflow-root><p>ContextFlow selbst</p></contextflow-root>`

test("blocks: the words of the content, links and emphasis as tags; never menus, the site's header and footer, inputs, code, editors", () => {
  const { document } = page(ARTICLE)
  const texts = lib.collectBlocks(document.body).map((b) => b.text)
  assert.deepEqual(texts, [
    "Die <1>neue</1> Brücke ist offen",
    "Die Stadt hat am Montag die Brücke <1>über den Fluss</1> eröffnet.",
    "Mehr dazu <1>hier</1> und <2>dort</2>.<3/>Neue Zeile.",
    "Erster Punkt der Liste",
    "Zweiter Punkt",
    "Unterpunkt eins",
    "Länge der Brücke",
    "Der Befehl <1/> startet alles.",
    "Name",
    "Ein Text ohne Absatz <1>fett</1>",
    "Absatz im Block",
    "und noch ein Rest danach",
    "Ganz in Spannen verpackt"
  ])
  const wrapped = lib.collectBlocks(document.body).at(-1)!
  assert.equal(wrapped.parent.tagName, "SPAN", "inside the spans that hold all the words")
})

test("a translation goes into the same nodes: the link is the same element, same address, same listener", () => {
  const { document } = page(ARTICLE)
  const link = document.getElementById("l1")!
  let clicks = 0
  link.addEventListener("click", () => clicks++)
  const block = lib.collectBlocks(document.getElementById("p1")!)[0]
  const before = document.getElementById("p1")!.innerHTML
  const done = lib.applyBlock(block, "В понедельник город открыл мост <1>через реку</1>.")
  assert.ok(done)
  const p = document.getElementById("p1")!
  assert.equal(p.textContent, "В понедельник город открыл мост через реку.")
  assert.equal(document.getElementById("l1"), link)
  assert.equal(link.getAttribute("href"), "https://example.de/bruecke")
  assert.equal(link.textContent, "через реку")
  link.dispatchEvent(new (document.defaultView as any).Event("click"))
  assert.equal(clicks, 1)
  lib.restore(done)
  assert.equal(document.getElementById("p1")!.innerHTML, before, "Original: exactly as it was")
})

test("word order moves the links; Original puts them back; a line break stays a line break", () => {
  const { document } = page(`<p id="p">Mehr dazu <a href="/mehr">hier</a> und <a href="/dort">dort</a>.<br>Neue Zeile.</p>`)
  const p = document.getElementById("p")!
  const before = p.innerHTML
  const [a1, a2] = Array.from(p.querySelectorAll("a"))
  const block = lib.collectBlocks(document.body)[0]
  const done = lib.applyBlock(block, "Подробнее <2>там</2> и <1>здесь</1>.<3/>Новая строка.")
  assert.ok(done)
  assert.equal(p.textContent, "Подробнее там и здесь.Новая строка.")
  const links = Array.from(p.querySelectorAll("a"))
  assert.equal(links[0], a2)
  assert.equal(links[1], a1)
  assert.equal(p.querySelectorAll("br").length, 1)
  lib.restore(done)
  assert.equal(p.innerHTML, before)
})

test("a translation that lost a link's tags isn't written; the page stays as it was", () => {
  const { document } = page(`<p id="p">Lies <a href="/x">das hier</a> bitte.</p>`)
  const before = document.getElementById("p")!.innerHTML
  const block = lib.collectBlocks(document.body)[0]
  assert.equal(lib.applyBlock(block, "Прочитай <1>это</2> пожалуйста."), null)
  assert.equal(document.getElementById("p")!.innerHTML, before)
})

test("Original leaves alone words the site has changed since", () => {
  const { document } = page(`<p id="p">Guten Morgen</p>`)
  const block = lib.collectBlocks(document.body)[0]
  const done = lib.applyBlock(block, "Доброе утро")!
  const text = document.getElementById("p")!.firstChild as Text
  text.data = "Guten Abend (neu)"
  lib.restore(done)
  assert.equal(document.getElementById("p")!.textContent, "Guten Abend (neu)")
})

test("where to read again after a change: the nearest element that isn't part of the words", () => {
  const { document } = page(`<div id="d"><p id="p">Ein <a id="a" href="#"><b id="b">Link</b></a> hier</p></div>`)
  assert.equal(lib.scanRoot(document.getElementById("b")!)!.id, "p")
  assert.equal(lib.scanRoot(document.getElementById("p")!)!.id, "p")
})

// ------------------------------------------------------------------ the engine

const TRANSLATIONS: Record<string, string> = {
  "Erster Absatz mit einem <1>Link</1>.": "Первый абзац со <1>ссылкой</1>.",
  "Zweiter Absatz.": "Второй абзац.",
  "Dritter Absatz ohne Link.": "Третий абзац без ссылки."
}

/** WebKit's MutationObserver as far as the engine needs it: the test hands it the records the browser would. */
class FakeObserver {
  static last: FakeObserver | null = null
  cb: (records: unknown[]) => void
  constructor(cb: (records: unknown[]) => void) {
    this.cb = cb
    FakeObserver.last = this
  }
  observe() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

function engine(document: Document, replies: (ask: any) => any[]) {
  const asks: any[] = []
  const saved = new Map<string, Map<string, string>>()
  const translator = new lib.PageTranslator({
    doc: document,
    observers: { mutation: FakeObserver },
    url: () => "https://zeitung.example/artikel?utm_source=x",
    ask: (ask: any, on: (r: any) => void) => {
      const req = asks.push(ask)
      setTimeout(() => {
        for (const r of replies(ask)) on({ ...r, req })
      }, 1)
      return () => undefined
    },
    cache: {
      load: async (url: string, to: string) => new Map(saved.get(`${url}|${to}`) ?? []),
      save: (url: string, to: string, entries: Map<string, string>) => saved.set(`${url}|${to}`, new Map(entries))
    }
  })
  return { translator, asks, saved }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PAGE = `<main><p>Erster Absatz mit einem <a href="/l">Link</a>.</p><p>Zweiter Absatz.</p><p>Dritter Absatz ohne Link.</p></main>`

test("engine: the page translated, its first request alone; Original puts it back; again from what's kept, no request", async () => {
  const { document } = page(PAGE)
  const before = document.body.innerHTML
  const { translator, asks } = engine(document, (ask) => [
    { type: "items", items: ask.blocks.map((b: any) => ({ id: b.id, text: TRANSLATIONS[b.text] })) },
    { type: "done", charged: ask.first }
  ])
  await translator.start("ru", "de")
  await wait(120)
  assert.equal(translator.state().at, "on")
  assert.equal(document.querySelector("main")!.textContent, "Первый абзац со ссылкой.Второй абзац.Третий абзац без ссылки.")
  assert.equal(asks.length, 1)
  assert.equal(asks[0].first, true)
  assert.equal(asks[0].to, "ru")
  assert.equal(asks[0].from, "de")
  assert.equal(asks[0].blocks.length, 3)

  translator.original()
  assert.equal(translator.state().at, "off")
  assert.equal(document.body.innerHTML, before)

  await translator.start("ru", "de")
  await wait(50)
  assert.equal(document.querySelector("main")!.textContent, "Первый абзац со ссылкой.Второй абзац.Третий абзац без ссылки.")
  assert.equal(asks.length, 1, "taken from what's kept: no request, nothing counted")
  translator.original()
})

test("engine: out of free answers, the page stays as it is and the state says so", async () => {
  const { document } = page(PAGE)
  const before = document.body.innerHTML
  const { translator } = engine(document, () => [{ type: "error", code: "LIMIT_REACHED" }])
  await translator.start("ru", "de")
  await wait(60)
  assert.equal(translator.state().at, "limit")
  assert.equal(document.body.innerHTML, before)
})

test("engine: a block the site added later is translated; one it renders back in its own words gets ours again", async () => {
  const { document } = page(PAGE)
  const { translator, asks } = engine(document, (ask) => [
    { type: "items", items: ask.blocks.map((b: any) => ({ id: b.id, text: TRANSLATIONS[b.text] ?? `RU:${b.text}` })) },
    { type: "done", charged: false }
  ])
  await translator.start("ru", "de")
  await wait(60)
  const main = document.querySelector("main")!
  const p = document.createElement("p")
  p.textContent = "Ein neuer Kommentar unten."
  main.appendChild(p)
  FakeObserver.last!.cb([{ type: "childList", target: main, addedNodes: [p], removedNodes: [] }])
  await wait(400)
  assert.equal(p.textContent, "RU:Ein neuer Kommentar unten.")
  assert.equal(asks.length, 2)
  assert.equal(asks[1].first, false)
  // The site writes its own words back into a translated text node (a re-render).
  const second = document.querySelectorAll("p")[1].firstChild as Text
  second.data = "Zweiter Absatz."
  FakeObserver.last!.cb([{ type: "characterData", target: second, addedNodes: [], removedNodes: [] }])
  assert.equal(second.data, "Второй абзац.")
  // New words of its own there: that block is read again as it is now.
  second.data = "Ganz neuer Text."
  FakeObserver.last!.cb([{ type: "characterData", target: second, addedNodes: [], removedNodes: [] }])
  await wait(400)
  assert.equal(second.data, "RU:Ganz neuer Text.")
  translator.original()
})
