// 2.7 build 107, the owner's test of the page translated in place:
//  A4 the page's interface is translated too (menus, the site's header and footer, buttons, placeholders), its
//     elements and listeners kept, never fields, code or icon fonts;
//  A3 what the page shows later while it's translated (a dialog added, a menu or drawer that shows itself);
//  A5 the pill only when the main content is in another language, a smaller part said at the entry.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-translate-107-"))
  const src = new URL("../src/content/translate/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, [
    `export * from "${src}blocks.ts"`,
    `export { PageTranslator } from "${src}engine.ts"`,
    `export * from "${src}decide.ts"`,
    `export * from "${src}share.ts"`,
    `export { languageChoices, shortMark } from "${src}languages.ts"`
  ].join("\n"))
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const page = (body: string, lang = "de") => parseHTML(`<!doctype html><html lang="${lang}"><head><title>t</title></head><body>${body}</body></html>`)

// ------------------------------------------------------------------ A4: the interface

const SHOP = `
<header>
  <a href="/" class="logo"><img src="/logo.png" alt=""></a>
  <nav><ul><li><a id="n1" href="/produkte">Produkte</a></li><li><a href="/dienste">Dienstleistungen</a></li></ul></nav>
  <button id="cart" type="button"><span class="material-icons">shopping_cart</span> Warenkorb</button>
  <form role="search"><input id="q" type="search" placeholder="Wonach suchen Sie?"><input id="go" type="submit" value="Suchen"><input type="submit" name="sort" value="Preis"></form>
</header>
<main>
  <h1>Kopfhörer X</h1>
  <p>Ein leichter Kopfhörer mit langer Akkulaufzeit.</p>
  <button id="buy" class="btn">In den Warenkorb</button>
  <div role="button" id="order">Jetzt bestellen</div>
  <select id="size"><option>Klein</option><option>Groß</option></select>
  <input id="qty" value="eins">
  <div contenteditable="true">Ihre Bewertung</div>
  <pre>npm install kopfhoerer</pre>
</main>
<footer><a href="/impressum">Impressum</a></footer>`

test("A4: menus, the site's header and footer, buttons, placeholders and button inputs are translated; fields, selects, code, editors and icon fonts are not", () => {
  const { document } = page(SHOP)
  const blocks = lib.collectBlocks(document.body)
  const texts = blocks.map((b: any) => (b.attr ? `${b.attr}:${b.text}` : b.text))
  for (const want of ["Produkte", "Dienstleistungen", "Warenkorb", "Kopfhörer X", "In den Warenkorb", "Jetzt bestellen", "Impressum", "placeholder:Wonach suchen Sie?", "value:Suchen"]) {
    assert.ok(texts.includes(want), `translated: ${want} (got ${JSON.stringify(texts)})`)
  }
  for (const never of ["shopping_cart", "Klein", "Groß", "eins", "Ihre Bewertung", "npm install kopfhoerer", "value:Preis"]) {
    assert.ok(!texts.some((t: string) => t.includes(never)), `left as it is: ${never}`)
  }
})

test("A4: a translated button and link keep their elements and listeners; Original puts every word and attribute back", () => {
  const { document } = page(SHOP)
  const before = document.body.innerHTML
  const buy = document.getElementById("buy")!
  const cart = document.getElementById("cart")!
  let bought = 0
  buy.addEventListener("click", () => bought++)
  const done = lib.collectBlocks(document.body).map((b: any) => {
    const text = b.attr ? `RU ${b.text}` : b.text.replace(/(^|>)([^<]+)/g, (_m: string, a: string, w: string) => `${a}RU ${w}`)
    const applied = lib.applyBlock(b, text, "ru")
    assert.ok(applied, `applied: ${b.text}`)
    return applied
  })
  assert.equal(buy.textContent, "RU In den Warenkorb")
  assert.equal(document.getElementById("buy"), buy, "the same button")
  buy.dispatchEvent(new (document.defaultView as any).Event("click"))
  assert.equal(bought, 1, "its listener still runs")
  assert.equal(cart.querySelector(".material-icons")!.textContent, "shopping_cart", "the icon font's word stays")
  assert.equal(document.getElementById("n1")!.getAttribute("href"), "/produkte")
  assert.equal(document.getElementById("q")!.getAttribute("placeholder"), "RU Wonach suchen Sie?")
  assert.equal(document.getElementById("go")!.getAttribute("value"), "RU Suchen")
  assert.equal((document.getElementById("qty") as any).getAttribute("value"), "eins", "a field's value never")
  for (const d of done.reverse()) lib.restore(d)
  assert.equal(document.body.innerHTML, before, "Original: exactly as it was")
})

test("A4: an attribute's translation with tags in it isn't written", () => {
  const { document } = page(`<input id="q" placeholder="Suche">`)
  const [block] = lib.collectBlocks(document.body)
  assert.equal(block.attr, "placeholder")
  assert.equal(lib.applyBlock(block, "<1>Поиск</1>", "ru"), null)
  assert.equal(document.getElementById("q")!.getAttribute("placeholder"), "Suche")
})

// ------------------------------------------------------------------ A3: what the page shows later

class FakeObserver {
  static last: FakeObserver | null = null
  static watched: unknown[] = []
  cb: (records: unknown[]) => void
  constructor(cb: (records: unknown[]) => void) {
    this.cb = cb
    FakeObserver.last = this
    FakeObserver.watched = []
  }
  observe(target: unknown) {
    FakeObserver.watched.push(target)
  }
  disconnect() {}
  takeRecords() {
    return []
  }
}

function engine(document: Document) {
  const asks: any[] = []
  const translator = new lib.PageTranslator({
    doc: document,
    observers: { mutation: FakeObserver },
    url: () => "https://shop.example/kopfhoerer",
    ask: (ask: any, on: (r: any) => void) => {
      const req = asks.push(ask)
      setTimeout(() => {
        on({ type: "items", req, items: ask.blocks.map((b: any) => ({ id: b.id, text: b.text.replace(/(^|>)([^<]+)/g, (_m: string, a: string, w: string) => `${a}RU ${w}`) })) })
        on({ type: "done", req, charged: ask.first })
      }, 1)
      return () => undefined
    },
    cache: { load: async () => new Map(), save: () => undefined }
  })
  return { translator, asks }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("A3: a dialog added after the translation, a menu that shows itself (aria-hidden, hidden) and a <details> opened are translated too", async () => {
  const { document } = page(`<main><p>Ein Absatz über Kopfhörer.</p></main>
    <div id="drawer" aria-hidden="true"><ul><li><a href="/k">Kopfhörer</a></li><li><a href="/l">Lautsprecher</a></li></ul></div>
    <div id="menu" hidden><button>Abmelden</button></div>`)
  const { translator, asks } = engine(document)
  await translator.start("ru", "de")
  await wait(60)
  assert.equal(document.querySelector("main p")!.textContent, "RU Ein Absatz über Kopfhörer.")
  const drawer = document.getElementById("drawer")!
  assert.equal(drawer.textContent!.includes("RU"), false, "hidden from everyone: not yet")
  // The cart's dialog, added after the translation (the owner's «попапы»).
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  dialog.innerHTML = `<p>Zum Warenkorb hinzugefügt</p><button>Zur Kasse</button><button>Weiter einkaufen</button>`
  document.body.appendChild(dialog)
  FakeObserver.last!.cb([{ type: "childList", target: document.body, addedNodes: [dialog], removedNodes: [] }])
  // The menu drawer shows itself: its aria-hidden taken off; the account menu: its hidden attribute removed.
  drawer.removeAttribute("aria-hidden")
  FakeObserver.last!.cb([{ type: "attributes", target: drawer, attributeName: "aria-hidden", addedNodes: [], removedNodes: [] }])
  const menu = document.getElementById("menu")!
  menu.removeAttribute("hidden")
  FakeObserver.last!.cb([{ type: "attributes", target: menu, attributeName: "hidden", addedNodes: [], removedNodes: [] }])
  await wait(400)
  assert.deepEqual(Array.from(dialog.querySelectorAll("p,button")).map((e) => e.textContent), ["RU Zum Warenkorb hinzugefügt", "RU Zur Kasse", "RU Weiter einkaufen"])
  assert.deepEqual(Array.from(drawer.querySelectorAll("a")).map((e) => e.textContent), ["RU Kopfhörer", "RU Lautsprecher"])
  assert.equal(menu.querySelector("button")!.textContent, "RU Abmelden")
  assert.ok(asks.length >= 2, "asked as they came")
  assert.equal(asks.filter((a) => a.first).length, 1, "one first request: the page counted once")
  // Hidden again and shown again: nothing asked twice.
  const n = asks.length
  drawer.setAttribute("aria-hidden", "true")
  FakeObserver.last!.cb([{ type: "attributes", target: drawer, attributeName: "aria-hidden", addedNodes: [], removedNodes: [] }])
  drawer.removeAttribute("aria-hidden")
  FakeObserver.last!.cb([{ type: "attributes", target: drawer, attributeName: "aria-hidden", addedNodes: [], removedNodes: [] }])
  await wait(300)
  assert.equal(asks.length, n)
  translator.original()
  assert.equal(dialog.querySelector("button")!.textContent, "Zur Kasse")
  assert.equal(drawer.querySelector("a")!.textContent, "Kopfhörer")
})

test("A3: words a site writes later into an empty label are translated", async () => {
  const { document } = page(`<main><p>Ein Absatz über Kopfhörer.</p><p id="status"><span id="s"></span></p></main>`)
  const span = document.getElementById("s")!
  span.appendChild(document.createTextNode(""))
  const { translator } = engine(document)
  await translator.start("ru", "de")
  await wait(60)
  const node = span.firstChild as Text
  node.data = "Artikel wurde hinzugefügt"
  FakeObserver.last!.cb([{ type: "characterData", target: node, addedNodes: [], removedNodes: [] }])
  await wait(400)
  assert.equal(span.textContent, "RU Artikel wurde hinzugefügt")
  translator.original()
})

test("A3: a web component's open shadow root is read and watched", () => {
  const { document } = page(`<main><p>Text</p></main><cookie-banner id="cb"></cookie-banner>`)
  const host = document.getElementById("cb")!
  // linkedom has no shadow DOM: a stand-in with what collectBlocks reads.
  const inner = page(`<div><p>Wir verwenden Cookies.</p><button>Alle ablehnen</button></div>`).document.body.firstElementChild!
  const shadow = { children: [inner], querySelectorAll: (s: string) => inner.querySelectorAll(s) }
  Object.defineProperty(host, "shadowRoot", { value: shadow })
  const seen: unknown[] = []
  const texts = lib.collectBlocks(document.body, (sr: unknown) => seen.push(sr)).map((b: any) => b.text)
  assert.ok(texts.includes("Wir verwenden Cookies."))
  assert.ok(texts.includes("Alle ablehnen"))
  assert.deepEqual(seen, [shadow])
})

// ------------------------------------------------------------------ A5: when the pill offers itself

const shares = (langs: Record<string, number>) => ({ langs: new Map(Object.entries(langs)), letters: Object.values(langs).reduce((a, b) => a + b, 0) })

test("A5: the pill only when the main content is mostly in another language; a smaller part is said at the entry", () => {
  const J = (main: Record<string, number>, page: Record<string, number>, reader: string, lang = "") => lib.judgeShares(shares(main), shares(page), reader, lang)
  // The owner's case: 99 % in the reader's language, 1 % of interface in another: no pill, nothing at the entry.
  assert.deepEqual(J({ ru: 9_900, en: 100 }, { ru: 9_900, en: 100 }, "ru"), { from: null, part: null })
  // An article in the reader's language with a menu in another (public.cy in English, its Greek menu): the entry.
  const part = J({ en: 6_000 }, { en: 6_000, el: 700 }, "en", "el")
  assert.equal(part.from, null)
  assert.equal(part.part.lang, "el")
  assert.equal(Math.round(part.part.share * 100), 10)
  // A few foreign names: not a part.
  assert.deepEqual(J({ en: 6_000 }, { en: 6_000, de: 90 }, "en"), { from: null, part: null })
  // Main content in another language: the pill, from that language.
  assert.deepEqual(J({ el: 5_000, en: 400 }, { el: 6_000, en: 900 }, "en"), { from: "el", part: null })
  assert.deepEqual(J({ ja: 3_000 }, { ja: 3_500, en: 300 }, "ru"), { from: "ja", part: null })
  assert.deepEqual(J({ ar: 4_000 }, { ar: 4_000 }, "ru", "fa"), { from: "fa", part: null }, "Arabic letters, a Persian page")
  assert.deepEqual(J({ tr: 2_000, en: 300 }, { tr: 2_500 }, "en"), { from: "tr", part: null })
  // Half and half: offered (the other half of the page is what the reader can't read).
  assert.equal(J({ de: 1_000, en: 1_000 }, { de: 1_000, en: 1_000 }, "en").from, "de")
  // Under half: the entry says how much.
  assert.equal(J({ de: 800, en: 1_200 }, { de: 800, en: 1_200 }, "en").part.lang, "de")
  // The reader's own language in another script or variety is theirs.
  assert.deepEqual(J({ zh: 5_000 }, { zh: 5_000 }, "zh-Hant"), { from: null, part: null })
  assert.deepEqual(J({ pt: 5_000 }, { pt: 5_000 }, "pt"), { from: null, part: null })
  // Words the guess can't place: the page's markup tells.
  assert.deepEqual(J({ "?": 3_000 }, { "?": 3_000 }, "en", "lt"), { from: "lt", part: null })
  assert.deepEqual(J({ "?": 3_000 }, { "?": 3_000 }, "en", "en"), { from: null, part: null })
  // Too little main content to judge: no pill.
  assert.equal(J({ de: 100 }, { de: 100 }, "en").from, null)
})

const words = (text: string, n: number) => Array.from({ length: n }, () => `<p>${text}</p>`).join("")

test("A5: by the page as it shows: the main content weighs, not the site's first menus", () => {
  const EN = "The city opened the new bridge over the river on Monday, and it is not only for cars but also for people on foot."
  const EL = "Ο δήμος άνοιξε τη νέα γέφυρα πάνω από το ποτάμι τη Δευτέρα, και δεν είναι μόνο για αυτοκίνητα αλλά και για πεζούς."
  const RU = "В понедельник город открыл новый мост через реку, и он предназначен не только для машин, но и для пешеходов."
  const menu = ["Βρες ένα κατάστημα", "Προϊόντα", "Υπηρεσίες", "Προσφορές", "Βιβλία", "Τηλεφωνία", "Υπολογιστές", "Τηλεοράσεις", "Κλιματισμός", "Οικιακές συσκευές"]
  const greekMenu = `<div class="drawer"><ul>${[...menu, ...menu.map((w) => `${w} και αξεσουάρ`)].map((w) => `<li><a href="#">${w}</a></li>`).join("")}</ul></div>`
  // public.cy as the owner saw it: an English page with a Greek menu, marked lang="el". The old sample read the menu.
  const cy = page(`${greekMenu}<main>${words(EN, 12)}</main>`, "el").document
  const s = lib.pageShares(cy)
  const j = lib.judgeShares(s.main, s.page, "en", "el")
  assert.equal(j.from, null, "no pill: the article is English")
  assert.equal(j.part?.lang, "el", "the entry says the Greek part")
  // The same page for a Russian reader: the article is in another language: the pill.
  assert.equal(lib.judgeShares(s.main, s.page, "ru", "el").from, "en")
  // A Greek article with an English menu, for an English reader: the pill, from Greek.
  const gr = page(`<nav><a href="#">Home</a><a href="#">Shop</a><a href="#">Contact</a></nav><article>${words(EL, 10)}</article>`, "en").document
  const g = lib.pageShares(gr)
  assert.equal(lib.judgeShares(g.main, g.page, "en", "en").from, "el")
  // A Russian article quoting one English sentence, for a Russian reader: nothing at all.
  const ru = page(`<main>${words(RU, 9)}<p>${EN}</p></main>`, "ru").document
  const r = lib.pageShares(ru)
  assert.deepEqual(lib.judgeShares(r.main, r.page, "ru", "ru"), { from: null, part: null })
  // Quoting three English paragraphs: no pill; the entry says how much.
  const ru3 = page(`<main>${words(RU, 9)}${words(EN, 3)}</main>`, "ru").document
  const r3 = lib.pageShares(ru3)
  const j3 = lib.judgeShares(r3.main, r3.page, "ru", "ru")
  assert.equal(j3.from, null)
  assert.equal(j3.part.lang, "en")
  assert.ok(j3.part.share > 0.2 && j3.part.share < 0.35, String(j3.part.share))
})

test("A1: the languages to pick from: the person's own first, then the ones they read, then the rest by name; never the page's", () => {
  const list = lib.languageChoices("ru", ["ru-RU", "en-US", "de"], "ru", "el")
  assert.deepEqual(list.slice(0, 3).map((c: any) => c.code), ["ru", "en", "de"])
  assert.equal(list[0].name, "Русский")
  assert.ok(!list.some((c: any) => c.code === "el"), "not the page's own language")
  assert.ok(list.some((c: any) => c.code === "zh-Hant") && list.some((c: any) => c.code === "tr") && list.some((c: any) => c.code === "he"))
  const rest = list.slice(3).map((c: any) => c.name)
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b, "ru")), "the rest by name")
  assert.equal(new Set(list.map((c: any) => c.code)).size, list.length, "each once")
  assert.equal(lib.shortMark("zh-Hant"), "繁")
  assert.equal(lib.shortMark("pt"), "PT")
})

test("the pill's new strings are in every language, with their placeholders", () => {
  const dir = new URL("../src/locales/", import.meta.url)
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const s = JSON.parse(readFileSync(new URL(`${lang}.json`, dir), "utf8"))
    for (const k of ["trLangPick", "trPart", "trEntry"]) assert.ok(s[k], `${lang}: ${k}`)
    assert.ok(s.trPart.includes("{0}") && s.trPart.includes("{1}"), `${lang}: trPart`)
  }
})
