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
    `export { languageChoices, shortMark } from "${src}languages.ts"`,
    `export { readerLanguage } from "${new URL("../src/content/answerLanguage.ts", import.meta.url).pathname}"`
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
  <button class="btn btn-icon">Merken</button>
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
  for (const want of ["Produkte", "Dienstleistungen", "Warenkorb", "Kopfhörer X", "In den Warenkorb", "Jetzt bestellen", "Merken", "Impressum", "placeholder:Wonach suchen Sie?", "value:Suchen"]) {
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
  // Build 109: aria-hidden alone doesn't keep words from being translated (a shop writes its filter's visible words
  // in an aria-hidden element); what the `hidden` attribute hides waits until it's taken off.
  assert.equal(drawer.textContent!.includes("RU"), true, "aria-hidden: read with the page")
  assert.equal(document.getElementById("menu")!.textContent!.includes("RU"), false, "hidden: not yet")
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
  // An English web app of short labels the guess can't place, marked lang="ru" or lang="de": not offered (the guess
  // knows Russian and German when it sees them). The owner's «99% страницы и так на нужном языке».
  assert.deepEqual(J({ "?": 3_000 }, { "?": 3_000 }, "en", "ru"), { from: null, part: null })
  assert.deepEqual(J({ "?": 3_000, en: 120 }, { "?": 3_200, en: 150 }, "en", "de"), { from: null, part: null })
  // No main content to speak of (a <main> around a search box): judged by the whole page.
  assert.deepEqual(J({ en: 20 }, { ar: 5_000, en: 60 }, "ru", "ar"), { from: "ar", part: null })
  assert.deepEqual(J({}, { ru: 5_000, en: 100 }, "ru", "ru"), { from: null, part: null })
})

test("A5: what isn't shown isn't weighed; a page marked aria-hidden behind its cookie dialog is", () => {
  const AR = "افتتحت المدينة الجسر الجديد فوق النهر يوم الاثنين، وهو ليس للسيارات فقط بل للمشاة أيضا."
  // Al Jazeera with its consent dialog open: the page is aria-hidden="true" for screen readers, and still on screen.
  const aj = page(`<div aria-hidden="true"><main>${words(AR, 10)}</main></div><div role="dialog"><p>${AR}</p><button>موافق</button></div>`, "ar").document
  const a = lib.pageShares(aj)
  assert.ok(a.main.letters > 500, `the page behind the dialog is weighed (${a.main.letters})`)
  assert.equal(lib.judgeShares(a.main, a.page, "ru", "ar").from, "ar")
  // Yandex Market keeps its data in <noframes> inside the page: never words, whatever holds them.
  const RU = "В понедельник город открыл новый мост через реку, и он предназначен не только для машин, но и для пешеходов."
  const json = `{"widgets":{"banner":{"type":"banner","block":"showcase","creative":"de la casa que no se puede para os dados com uma"}}}`.repeat(40)
  const ym = page(`<main><div><noframes>${json}</noframes>${words(RU, 8)}<span hidden>${json}</span></div></main>`, "ru").document
  const y = lib.pageShares(ym)
  assert.deepEqual([...y.main.langs.keys()], ["ru"], JSON.stringify([...y.main.langs]))
  assert.deepEqual(lib.judgeShares(y.main, y.page, "ru", "ru"), { from: null, part: null })
  // And never sent to be translated.
  assert.ok(!lib.collectBlocks(ym.body).some((b: any) => b.text.includes("widgets")))
  // A wrapper with display: contents has no box (the browser's check says "not shown"), and its words show.
  const wrapped = page(`<main><div id="w" class="contents">${words(AR, 8)}</div><div id="gone">${words(RU, 8)}</div></main>`, "ar")
  const w = wrapped.document.getElementById("w")!
  const gone = wrapped.document.getElementById("gone")!
  ;(w as any).checkVisibility = () => false
  ;(gone as any).checkVisibility = () => false
  for (const p of Array.from(wrapped.document.querySelectorAll("p,main,body"))) (p as any).checkVisibility = () => true
  ;(wrapped.document.defaultView as any).getComputedStyle = (el: Element) => ({ display: el === w ? "contents" : "none" })
  const c = lib.pageShares(wrapped.document)
  assert.deepEqual([...c.main.langs.keys()], ["ar"], "the wrapper's words count; the one that's really hidden doesn't")
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

// ------------------------------------------------------------------ the page's controls, judged on their own

test("controls: what the reader presses or fills in is told from the page's words", () => {
  const { document } = page(`
    <header><nav><ul><li><a href="/p">Προϊόντα</a></li><li><a href="/y">Υπηρεσίες</a></li></ul></nav><button>Βρες ένα κατάστημα</button></header>
    <main>
      <h1>Wireless headphones</h1>
      <p>A light pair of headphones with a long battery life and <a href="/more">a link inside the words</a> of a paragraph.</p>
      <h3><a href="/news/1">A headline that links to the whole story about the new bridge</a></h3>
      <a class="btn" href="/order">Order now</a>
      <div role="tablist"><div role="tab">Details</div><div role="tab">Reviews</div></div>
      <form><label for="q">Your email</label><input id="q" placeholder="name@example.com or a phone"><input type="submit" value="Subscribe"></form>
      <div role="dialog"><h2>Added to your cart</h2><p>The item is waiting for you in the cart.</p><button>Checkout</button></div>
    </main>`, "en")
  const blocks = lib.collectBlocks(document.body)
  const controls = blocks.filter((b: any) => lib.controlBlock(b)).map((b: any) => b.text.replace(/<\/?\d+\/?>/g, ""))
  assert.deepEqual(controls, ["Προϊόντα", "Υπηρεσίες", "Βρες ένα κατάστημα", "Order now", "Details", "Reviews", "Your email", "Added to your cart", "Checkout", "name@example.com or a phone", "Subscribe"])
  const words = blocks.filter((b: any) => !lib.controlBlock(b)).map((b: any) => b.text.replace(/<\/?\d+\/?>/g, ""))
  assert.deepEqual(words, ["Wireless headphones", "A light pair of headphones with a long battery life and a link inside the words of a paragraph.", "A headline that links to the whole story about the new bridge", "The item is waiting for you in the cart."])
  assert.deepEqual(lib.controlLabels(document).slice(0, 3), ["Προϊόντα", "Υπηρεσίες", "Βρες ένα κατάστημα"])
})

test("controls in another language are offered whatever their share of the page; stray words never are", () => {
  const C = (labels: string[], reader: string, lang = "") => lib.judgeControls(labels, reader, lang)
  const EN_SITE = ["Home", "Products", "Add to cart", "Sign in", "Search the site", "Contact us", "About the company", "Terms of use"]
  // public.cy in English, as the owner saw it: English words, the menu and buttons in Greek.
  assert.deepEqual(C([...EN_SITE, "Βρες ένα κατάστημα", "Προϊόντα", "Υπηρεσίες"], "en", "el"), { lang: "el", labels: 3, offer: true })
  // One Greek label (a language switcher's «Ελληνικά»): the entry by the circle, no offer.
  assert.deepEqual(C([...EN_SITE, "Ελληνικά"], "en"), { lang: "el", labels: 1, offer: false })
  // A language switcher in many scripts: one label each, no offer.
  assert.equal(C([...EN_SITE, "Ελληνικά", "Русский", "日本語", "العربية", "한국어", "עברית"], "en")?.offer, false)
  // A Russian site with stray English: single words, brands, a sign-in button. Nothing, not even the entry.
  const RU_SITE = ["Главная", "Каталог", "Корзина", "Войти", "Поиск по сайту", "О компании", "Доставка и оплата", "Контакты"]
  assert.equal(C([...RU_SITE, "OK", "Login", "Sale", "iPhone", "Samsung Galaxy", "Black Friday", "Sign in with Google"], "ru", "ru"), null)
  // The same for a German, a Turkish and a Japanese site with stray English.
  assert.equal(C(["Startseite", "Warenkorb", "Anmelden", "Mehr erfahren", "Alle akzeptieren", "OK", "Sale", "Newsletter", "Sign in with Google", "Black Friday Deals"], "de", "de"), null)
  assert.equal(C(["Ana Sayfa", "Sepetim", "Giriş yap", "Kampanyalar", "Login", "Outlet", "Sign in with Apple"], "tr", "tr"), null)
  assert.equal(C(["ホーム", "カートに入れる", "ログイン", "お問い合わせ", "OK", "SALE", "Sign in with Google"], "ja", "ja"), null)
  // A Russian page with an English interface (several labels of several words the lists agree on): offered.
  const en = C([...RU_SITE.slice(0, 2), "Add to cart", "Sign in to your account", "Search the site", "Terms of use", "Go to the next page", "Contact us"], "ru", "ru")
  assert.equal(en?.lang, "en")
  assert.equal(en?.offer, true)
  // An English page with a German interface: the same script, so only labels the word lists place count.
  const de = C(["Buy now", "Read more", "In den Warenkorb legen", "Zur Kasse gehen und bezahlen", "Alle Cookies akzeptieren und schließen", "Mit dem Konto anmelden", "Nicht mehr anzeigen", "Seite auf Deutsch lesen"], "en", "en")
  assert.equal(de?.lang, "de")
  assert.equal(de?.offer, true)
  // A Ukrainian interface for a Russian reader (the same letters but і, ї, є).
  const uk = C(["Головна", "Увійти", "Кошик", "Пошук по сайту", "Про компанію", "Доставка і оплата", "Зв’язатися з нами", "Мої замовлення", "Підтримка", "Зареєструватися"], "ru", "uk")
  assert.equal(uk?.lang, "uk")
  assert.equal(uk?.offer, true)
  // Not the other way: Ukrainian words without і, ї, є read as Russian, so a Ukrainian reader isn't offered them.
  assert.equal(C(["Головна", "Кошик", "Каталог", "Пошук по сайту", "Контакти", "Допомога"], "uk", "uk"), null)
  // The reader's own language, in its own script or another variety: nothing.
  assert.equal(C(RU_SITE, "ru", "ru"), null)
  assert.equal(C(EN_SITE, "en", "en"), null)
  assert.equal(C(["首頁", "購物車", "登入", "聯絡我們"], "zh-Hans", "zh-Hant"), null)
  assert.equal(C([], "en"), null)
})

test("only the controls are translated when the page's words are the reader's; the ones that show later too", async () => {
  const { document } = page(`<nav><a href="/p">Προϊόντα</a><a href="/y">Υπηρεσίες</a></nav>
    <main><h1>Wireless headphones</h1><p>A light pair of headphones with a long battery life.</p><button>Παραγγελία</button></main>`, "el")
  const { translator, asks } = engine(document)
  await translator.start("en", "el", "controls")
  await wait(80)
  assert.equal(document.querySelector("nav")!.textContent, "RU ΠροϊόνταRU Υπηρεσίες")
  assert.equal(document.querySelector("button")!.textContent, "RU Παραγγελία")
  assert.equal(document.querySelector("h1")!.textContent, "Wireless headphones", "the page's words aren't sent")
  assert.equal(document.querySelector("p")!.textContent, "A light pair of headphones with a long battery life.")
  assert.ok(asks.every((a: any) => a.blocks.every((b: any) => !b.text.includes("headphones"))))
  // A dialog that shows later: its button and title, not its paragraph.
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  dialog.innerHTML = `<h2>Προστέθηκε στο καλάθι</h2><p>Some words of the dialog in English.</p><button>Ταμείο</button>`
  document.body.appendChild(dialog)
  FakeObserver.last!.cb([{ type: "childList", target: document.body, addedNodes: [dialog], removedNodes: [] }])
  await wait(400)
  assert.equal(dialog.querySelector("h2")!.textContent, "RU Προστέθηκε στο καλάθι")
  assert.equal(dialog.querySelector("button")!.textContent, "RU Ταμείο")
  assert.equal(dialog.querySelector("p")!.textContent, "Some words of the dialog in English.")
  assert.equal(asks.filter((a: any) => a.first).length, 1, "one page, one answer")
  translator.original()
  assert.equal(document.querySelector("button")!.textContent, "Παραγγελία")
})

test("controls only: asked as such in small requests (free on the server); past the day's cap the state says so, and the page as a page still goes", async () => {
  const many = Array.from({ length: 120 }, (_, i) => `<li><a href="/m${i}">Κατηγορία προϊόντων αριθμός ${i}</a></li>`).join("")
  const { document } = page(`<nav><ul>${many}</ul></nav><main><p>A light pair of headphones with a long battery life.</p><button>Παραγγελία</button></main>`, "el")
  const asks: any[] = []
  let cap = false
  const translator = new lib.PageTranslator({
    doc: document,
    observers: { mutation: FakeObserver },
    url: () => "https://shop.example/en",
    ask: (ask: any, on: (r: any) => void) => {
      const req = asks.push(ask)
      setTimeout(() => {
        if (cap && ask.kind === "controls") return on({ type: "error", req, code: "CONTROLS_CAP" })
        on({ type: "items", req, items: ask.blocks.map((b: any) => ({ id: b.id, text: `EN ${b.text}` })) })
        on({ type: "done", req, charged: ask.kind !== "controls" && ask.first })
      }, 1)
      return () => undefined
    },
    cache: { load: async () => new Map(), save: () => undefined }
  })
  await translator.start("en", "el", "controls")
  await wait(300)
  assert.ok(asks.length >= 2, "more than one request")
  for (const a of asks) {
    assert.equal(a.kind, "controls")
    assert.ok(a.blocks.reduce((n: number, b: any) => n + b.text.length, 0) <= 2_500, "each within what the server takes as controls")
    assert.ok(a.blocks.every((b: any) => b.text.length <= 80))
  }
  assert.equal(document.querySelector("button")!.textContent, "EN Παραγγελία")
  // The whole page then: the controls come from what's kept (not sent again); only the page's words are asked.
  const n = asks.length
  translator.original()
  await translator.start("en", "el")
  await wait(200)
  const later = asks.slice(n)
  assert.ok(later.length >= 1)
  assert.ok(later.every((a) => a.kind === undefined), "a page translation, counted as one")
  assert.deepEqual(later.flatMap((a) => a.blocks.map((b: any) => b.text)), ["A light pair of headphones with a long battery life."])
  assert.equal(document.querySelector("button")!.textContent, "EN Παραγγελία", "from what's kept")
  translator.original()
  // Past the day's cap: nothing is translated, and the state says which limit it is.
  cap = true
  const fresh = page(`<nav><a href="/a">Προϊόντα</a><a href="/b">Υπηρεσίες</a></nav><main><p>Words of the page.</p></main>`, "el").document
  const second = new lib.PageTranslator({
    doc: fresh, observers: { mutation: FakeObserver }, url: () => "https://shop.example/other",
    ask: (ask: any, on: (r: any) => void) => {
      setTimeout(() => on({ type: "error", req: 1, code: "CONTROLS_CAP" }), 1)
      return () => undefined
    },
    cache: { load: async () => new Map(), save: () => undefined }
  })
  await second.start("en", "el", "controls")
  await wait(80)
  assert.deepEqual(second.state(), { at: "limit", controls: true })
  assert.equal(fresh.querySelector("nav")!.textContent, "ΠροϊόνταΥπηρεσίες")
})

test("the reader's language comes from the languages they read, never from the region of the device's locale", () => {
  // An English reader living in Germany or Cyprus, a Russian one in Cyprus, an Arabic one in the Emirates, a reader
  // of Traditional Chinese in the US: each reads their own language, whatever the country.
  const R = (languages: string[], device = "", panel = "") => lib.readerLanguage({ languages, language: languages[0] }, device, panel)
  assert.equal(R(["en-DE"], "en-DE", "en"), "en")
  assert.equal(R(["en-CY"], "en-CY", "en"), "en")
  assert.equal(R(["zh-Hant-US"], "zh-Hant-US", "zh-Hant"), "zh-Hant")
  assert.equal(R(["ru-CY"], "ru-CY", "ru"), "ru")
  assert.equal(R(["ar-AE"], "ar-AE", "ar"), "ar")
  // Safari takes the extension's UI locale from the device's locale: where that says the country's language
  // ("de-DE" for English in Germany on a device set that way), the languages the person reads still decide.
  assert.equal(R(["en-DE"], "de-DE", "en"), "en")
  assert.equal(R(["en-GB", "de-DE"], "de-DE", "en"), "en", "German second in their list: English is theirs")
  assert.equal(R(["zh-Hans-MO"], "zh-MO", "zh-Hans"), "zh-Hans", "the script that's said, not the place")
  assert.equal(R(["zh-TW"], "zh-TW", "zh-Hant"), "zh-Hant")
  // Nothing listed: the UI locale, then the panel's own language.
  assert.equal(lib.readerLanguage({ languages: [], language: "" }, "pl-PL", "en"), "pl")
  assert.equal(lib.readerLanguage({}, "", "ru"), "ru")
  assert.equal(lib.readerLanguage({ languages: ["*"] }, "", ""), "en")
  // So an English page isn't offered to them, and a German one is, into English.
  for (const languages of [["en-DE"], ["en-CY"]]) {
    const reader = R(languages, "de-DE", "en")
    assert.deepEqual(lib.judgeShares(shares({ en: 6_000 }), shares({ en: 6_500, de: 40 }), reader, "en"), { from: null, part: null })
    assert.equal(lib.judgeShares(shares({ de: 6_000 }), shares({ de: 6_500 }), reader, "de").from, "de")
  }
  assert.deepEqual(lib.judgeShares(shares({ ru: 6_000 }), shares({ ru: 6_000, el: 60 }), R(["ru-CY"], "el-CY", "ru"), "ru"), { from: null, part: null })
  assert.deepEqual(lib.judgeShares(shares({ ar: 6_000 }), shares({ ar: 6_000 }), R(["ar-AE"]), "ar"), { from: null, part: null })
  assert.deepEqual(lib.judgeShares(shares({ zh: 6_000 }), shares({ zh: 6_000 }), R(["zh-Hant-US"], "en-US", "zh-Hant"), "zh-Hant"), { from: null, part: null })
  // The pill takes it from there.
  const pill = readFileSync(new URL("../src/content/translate/TranslatePill.tsx", import.meta.url), "utf8")
  assert.match(pill, /const ownLanguage = \(\) => readerLanguage\(navigator, uiLanguage\(\), uiLang\(\)\)/)
  assert.doesNotMatch(pill, /targetCode\(uiLanguage\(\)\)/)
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
    for (const k of ["trLangPick", "trPart", "trEntry", "trControls", "trControlsCap"]) assert.ok(s[k], `${lang}: ${k}`)
    assert.ok(s.trControls.includes("{0}"), `${lang}: trControls`)
    assert.ok(s.trPart.includes("{0}") && s.trPart.includes("{1}"), `${lang}: trPart`)
  }
})
