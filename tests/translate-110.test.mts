// 2.7 build 110, the owner's test of TestFlight 109, page translation:
//  N1 a system list's rows (<select>) are translated as labels: their text and value stay;
//  N3 a page's frames: the engine says when the page is translated and back; a frame's requests go by the page's address;
//  N4 words the site writes back into a translated part are translated again inside that change (nothing shows of
//     the original), a site that answers every time is left alone.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-translate-110-"))
  const src = new URL("../src/content/translate/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, [
    `export * from "${src}blocks.ts"`,
    `export * from "${src}engine.ts"`,
    `export { frameState } from "${new URL("../src/shared/translate.ts", import.meta.url).pathname}"`
  ].join("\n"))
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const page = (body: string, lang = "de") => parseHTML(`<!doctype html><html lang="${lang}"><head><title>t</title></head><body>${body}</body></html>`)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ru = (text: string) => text.replace(/(^|>)([^<]+)/g, (_m: string, a: string, w: string) => `${a}RU ${w}`)

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

/** An IntersectionObserver the test drives: `show(el)` says the element is on screen, `hide(el, rect)` that it isn't. */
class FakeIO {
  static last: FakeIO | null = null
  cb: (entries: unknown[]) => void
  seen = new Set<Element>()
  constructor(cb: (entries: unknown[]) => void) {
    this.cb = cb
    FakeIO.last = this
  }
  observe(el: Element) {
    this.seen.add(el)
  }
  unobserve(el: Element) {
    this.seen.delete(el)
  }
  disconnect() {}
  report(shown: (el: Element) => boolean, hidden: (el: Element) => boolean) {
    const root = { top: -300, bottom: 1700, left: 0, right: 400 }
    this.cb([...this.seen].map((target) => ({
      target,
      isIntersecting: shown(target),
      rootBounds: root,
      // Hidden: no box. Further down the page: a box below the screen's reach.
      boundingClientRect: shown(target) ? { top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20 } : hidden(target) ? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } : { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 }
    })))
  }
}

interface Made {
  translator: any
  asks: any[]
  states: any[]
  site: Map<string, string>
  release: () => void
}

function engine(document: Document, opts: { io?: boolean; hold?: boolean; siteWords?: Map<string, string>; delay?: number; deps?: Record<string, unknown> } = {}): Made {
  const asks: any[] = []
  const states: any[] = []
  const site = opts.siteWords ?? new Map<string, string>()
  const held: Array<() => void> = []
  const translator = new lib.PageTranslator({
    doc: document,
    observers: { mutation: FakeObserver, intersection: opts.io ? FakeIO : null },
    url: () => "https://shop.example/kopfhoerer",
    site: () => "shop.example",
    ask: (ask: any, on: (r: any) => void) => {
      const req = asks.push(ask)
      const answer = () => {
        on({ type: "items", req, items: ask.blocks.map((b: any) => ({ id: b.id, text: ru(b.text) })) })
        on({ type: "done", req, charged: ask.first })
      }
      if (opts.hold && asks.length > 1) held.push(answer)
      else setTimeout(answer, opts.delay ?? 1)
      return () => undefined
    },
    ...(opts.deps ?? {}),
    cache: {
      load: async () => new Map(),
      save: () => undefined,
      loadSite: async () => new Map(site),
      saveSite: (_s: string, _to: string, entries: Map<string, string>) => {
        site.clear()
        for (const [k, v] of entries) site.set(k, v)
      }
    }
  })
  translator.subscribe((s: any) => states.push(s))
  running.push(translator)
  return { translator, asks, states, site, release: () => held.splice(0).forEach((f) => f()) }
}

// Every translator a test started is stopped after it (its timers would keep the test run from ending).
const running: any[] = []
afterEach(() => {
  for (const t of running.splice(0)) t.original()
})

const added = (target: Element, node: Node) => FakeObserver.last!.cb([{ type: "childList", target, addedNodes: [node], removedNodes: [] }])

// ------------------------------------------------------------------ N1: a system list

const SHOP = `
  <form><label for="sort">Sortieren nach</label>
  <select id="sort" name="sort_by">
    <option value="manual">Empfohlen</option>
    <option value="price" selected>Preis aufsteigend</option>
    <option>Neueste zuerst</option>
    <option value="n">24</option>
    <optgroup label="Nach Marke"><option value="a" label="Marke von A bis Z">A–Z</option></optgroup>
  </select></form>
  <select id="keep" translate="no"><option>Deutsch</option><option>Ελληνικά</option></select>
  <datalist id="dl"><option value="Berlin">Hauptstadt</option></datalist>`

test("N1: a system list's rows are blocks of their labels, the chosen row first; a list marked not to translate, a field's suggestions and numbers aren't", () => {
  const { document } = page(SHOP)
  const blocks = lib.collectBlocks(document.body)
  const rows = blocks.filter((b: any) => b.attr === "label")
  assert.deepEqual(rows.map((b: any) => b.text), ["Preis aufsteigend", "Empfohlen", "Neueste zuerst", "Nach Marke", "Marke von A bis Z"])
  assert.ok(rows.every((b: any) => b.seen === document.getElementById("sort")), "shown where the list is")
  assert.ok(rows.every((b: any) => lib.controlBlock(b)), "a list's rows are controls (free alone)")
  const texts = blocks.filter((b: any) => !b.attr).map((b: any) => b.text)
  assert.ok(texts.includes("Sortieren nach") && !texts.some((t: string) => /Empfohlen|Deutsch|Hauptstadt/.test(t)), JSON.stringify(texts))
})

test("N1: the translation goes into the row's label; its text and value stay, and the form sends what it sent; Original takes the labels off", async () => {
  const { document } = page(SHOP)
  const sort = document.getElementById("sort") as any
  const before = sort.outerHTML
  const options = [...sort.querySelectorAll("option")]
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  assert.equal(options[0].getAttribute("label"), "RU Empfohlen")
  assert.equal(options[1].getAttribute("label"), "RU Preis aufsteigend")
  assert.equal(options[2].getAttribute("label"), "RU Neueste zuerst")
  assert.equal(options[3].hasAttribute("label"), false, "a number is left")
  assert.equal(options[4].getAttribute("label"), "RU Marke von A bis Z")
  assert.equal(sort.querySelector("optgroup").getAttribute("label"), "RU Nach Marke")
  // What the site's scripts read and what the form sends: as the page wrote them.
  assert.deepEqual(options.map((o: any) => o.textContent), ["Empfohlen", "Preis aufsteigend", "Neueste zuerst", "24", "A–Z"])
  assert.deepEqual(options.map((o: any) => o.getAttribute("value")), ["manual", "price", null, "n", "a"])
  assert.equal(document.getElementById("keep")!.querySelector("option")!.hasAttribute("label"), false)
  // Read again (something else changed by it): the rows aren't asked for twice.
  const asked = made.asks.length
  added(sort.parentElement, document.createTextNode(" "))
  await wait(80)
  assert.equal(made.asks.length, asked)
  made.translator.original()
  assert.equal(sort.outerHTML, before)
})

test("N1: a row the site rewrites loses our label at once and is translated again; rows added later are translated", async () => {
  const { document } = page(SHOP)
  const sort = document.getElementById("sort") as any
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  const first = sort.querySelector("option")
  first.firstChild.data = "Beliebteste"
  FakeObserver.last!.cb([{ type: "characterData", target: first.firstChild }])
  assert.equal(first.hasAttribute("label"), false, "the old label doesn't stay over the new words")
  await wait(120)
  assert.equal(first.getAttribute("label"), "RU Beliebteste")
  assert.equal(first.textContent, "Beliebteste")
  const more = document.createElement("option")
  more.textContent = "Preis absteigend"
  sort.appendChild(more)
  added(sort, more)
  await wait(120)
  assert.equal(more.getAttribute("label"), "RU Preis absteigend")
  assert.equal(more.textContent, "Preis absteigend")
})

test("N1: a list on screen is translated when it shows; one that isn't shown is not translated ahead; a very long list is left whole", async () => {
  const rows = Array.from({ length: 400 }, (_v, i) => `<option>Gemeinde Nummer ${i} im Landkreis</option>`).join("")
  const { document } = page(`<p>Lieferung in ganz Deutschland möglich.</p><select id="a"><option>Klein</option><option>Groß</option></select><select id="b" style="display:none"><option>Versteckt gewählt</option></select><select id="long">${rows}</select>`)
  assert.equal(lib.collectBlocks(document.body).filter((b: any) => b.seen?.id === "long").length, 0)
  const made = engine(document, { io: true })
  await made.translator.start("ru", "de")
  const a = document.getElementById("a")!
  FakeIO.last!.report((el) => el.tagName === "P", (el) => el.id === "b")
  await wait(200)
  assert.equal(a.querySelector("option")!.hasAttribute("label"), false, "not before it's on screen")
  FakeIO.last!.report((el) => el.tagName === "P" || el.id === "a", (el) => el.id === "b")
  await wait(200)
  assert.equal(a.querySelector("option")!.getAttribute("label"), "RU Klein")
  await wait(700)
  assert.equal(document.getElementById("b")!.querySelector("option")!.hasAttribute("label"), false, "a hidden list isn't translated ahead")
})

// ------------------------------------------------------------------ N4: the site writes its words back

test("N4: a translated block the site rebuilds with its own words is translated again inside that change, without a request", async () => {
  const { document } = page(`<header><label id="hint"><span>Suche nach Angeboten!</span></label></header><p>Ein leichter Kopfhörer mit langer Akkulaufzeit.</p>`)
  const hint = document.getElementById("hint")!
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  assert.equal(hint.textContent, "RU Suche nach Angeboten!")
  const asked = made.asks.length
  for (let round = 0; round < 3; round++) {
    // The site draws the hint again (a new element with its own words), now and then.
    const old = hint.firstChild!
    const fresh = document.createElement("span")
    fresh.textContent = "Suche nach Angeboten!"
    hint.replaceChild(fresh, old)
    FakeObserver.last!.cb([{ type: "childList", target: hint, addedNodes: [fresh], removedNodes: [old] }])
    // No waiting: the words are ours again when the site's change is over.
    assert.equal(hint.textContent, "RU Suche nach Angeboten!", `round ${round}`)
    await wait(200)
  }
  assert.equal(made.asks.length, asked, "from what's kept")
})

test("N4: the site's words written back into the same text node and into a translated attribute are ours again at once", async () => {
  const { document } = page(`<form><input id="q" placeholder="Wonach suchen Sie?"></form><h2 id="h">Unsere Angebote der Woche</h2>`)
  const q = document.getElementById("q")!
  const h = document.getElementById("h")!
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  const asked = made.asks.length
  for (let round = 0; round < 5; round++) {
    q.setAttribute("placeholder", "Wonach suchen Sie?")
    FakeObserver.last!.cb([{ type: "attributes", target: q, attributeName: "placeholder" }])
    assert.equal(q.getAttribute("placeholder"), "RU Wonach suchen Sie?", `round ${round}`)
    ;(h.firstChild as any).data = "Unsere Angebote der Woche"
    FakeObserver.last!.cb([{ type: "characterData", target: h.firstChild }])
    assert.equal(h.textContent, "RU Unsere Angebote der Woche", `round ${round}`)
    await wait(150)
  }
  assert.equal(made.asks.length, asked)
})

test("N4: a field whose hint the site sets again and again (the same words) is translated, and stays so", async () => {
  const { document } = page(`<form><input id="q" placeholder="Wonach suchen Sie?"></form><p>Ein leichter Kopfhörer mit langer Akkulaufzeit.</p>`)
  const q = document.getElementById("q")!
  const made = engine(document, { delay: 150 })
  const again = () => {
    q.setAttribute("placeholder", "Wonach suchen Sie?")
    FakeObserver.last!.cb([{ type: "attributes", target: q, attributeName: "placeholder" }])
  }
  await made.translator.start("ru", "de")
  // While the translation is on its way, the site sets the hint a few times.
  for (let i = 0; i < 5; i++) {
    again()
    await wait(20)
  }
  await wait(300)
  assert.equal(q.getAttribute("placeholder"), "RU Wonach suchen Sie?")
  const asked = made.asks.length
  for (let i = 0; i < 12; i++) {
    again()
    assert.equal(q.getAttribute("placeholder"), "RU Wonach suchen Sie?", `round ${i}`)
    await wait(60)
  }
  assert.equal(made.asks.length, asked)
})

test("N4: rows a long list takes out and puts back as it's scrolled are translated again each time, never left", async () => {
  const { document } = page(`<ul id="list">${Array.from({ length: 30 }, (_v, i) => `<li>Bestellung Nummer ${i} wurde heute verschickt</li>`).join("")}</ul>`)
  const list = document.getElementById("list")!
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(120)
  const asked = made.asks.length
  // Twice through the list within a second: every row out, then a new element with the same words in.
  for (let pass = 0; pass < 2; pass++) {
    // One change of the site's (a scroll step redraws its rows): the observer hears of them together.
    const records: unknown[] = []
    const drawn: Array<[Element, string]> = []
    for (const old of [...list.children]) {
      const words = old.textContent!.replace(/^RU /, "")
      const fresh = document.createElement("li")
      fresh.textContent = words
      list.replaceChild(fresh, old)
      records.push({ type: "childList", target: list, addedNodes: [fresh], removedNodes: [old] })
      drawn.push([fresh, words])
    }
    FakeObserver.last!.cb(records)
    for (const [fresh, words] of drawn) assert.equal(fresh.textContent, `RU ${words}`)
  }
  assert.equal(made.asks.length, asked, "from what's kept")
})

test("N4: a site that answers every write with its own words is left with them after a few rounds, for good", async () => {
  const { document } = page(`<header><label id="hint"><span>Suche nach Angeboten!</span></label></header><p id="p">Ein leichter Kopfhörer mit langer Akkulaufzeit.</p>`)
  const hint = document.getElementById("hint")!
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  const redraw = () => {
    const old = hint.firstChild!
    const fresh = document.createElement("span")
    fresh.textContent = "Suche nach Angeboten!"
    hint.replaceChild(fresh, old)
    FakeObserver.last!.cb([{ type: "childList", target: hint, addedNodes: [fresh], removedNodes: [old] }])
  }
  let rounds = 0
  // As an observer of the site's own would: again as soon as the words aren't its own.
  while (hint.textContent !== "Suche nach Angeboten!" && rounds < 200) {
    redraw()
    rounds++
  }
  assert.ok(rounds > 2 && rounds <= lib.BACK_BURST + 2, `stopped after ${rounds} rounds`)
  assert.equal(hint.textContent, "Suche nach Angeboten!")
  await wait(300)
  redraw()
  await wait(300)
  assert.equal(hint.textContent, "Suche nach Angeboten!", "left alone from then on")
  assert.equal(document.getElementById("p")!.textContent, "RU Ein leichter Kopfhörer mit langer Akkulaufzeit.", "the rest stays translated")
})

test("N4: words that keep changing to something new are still left after a few changes in a row (a clock), though kept ones go back", async () => {
  const { document } = page(`<p id="clock">Noch 10 Minuten bis zum Ende</p><p>Ein leichter Kopfhörer mit langer Akkulaufzeit.</p>`)
  const clock = document.getElementById("clock")!
  const made = engine(document)
  await made.translator.start("ru", "de")
  await wait(60)
  for (let n = 9; n > 3; n--) {
    ;(clock.firstChild as any).data = `Noch ${n} Minuten bis zum Ende`
    FakeObserver.last!.cb([{ type: "characterData", target: clock.firstChild }])
    await wait(120)
  }
  const asked = made.asks.length
  assert.equal(clock.textContent, "Noch 4 Minuten bis zum Ende", "left as the site writes it")
  ;(clock.firstChild as any).data = "Noch 3 Minuten bis zum Ende"
  FakeObserver.last!.cb([{ type: "characterData", target: clock.firstChild }])
  await wait(120)
  assert.equal(made.asks.length, asked, "no more requests for it")
})

// ------------------------------------------------------------------ N3: frames

test("N3: the engine says when the page is translated and when it's back; a frame's requests go by the page's address", async () => {
  const { document } = page(`<p>Guten Tag, wie kann ich Ihnen heute helfen?</p><button>Neues Gespräch beginnen</button>`)
  const told: any[] = []
  const made = engine(document, { deps: { frames: (s: any) => told.push(s), counted: () => "https://www.portal.example/start" } })
  await made.translator.start("ru", "de", "controls")
  await wait(60)
  assert.deepEqual(told, [{ on: true, to: "ru", only: "controls" }])
  assert.ok(made.asks.length > 0 && made.asks.every((a: any) => a.url === "https://www.portal.example/start"), JSON.stringify(made.asks.map((a: any) => a.url)))
  made.translator.original()
  made.translator.original()
  assert.deepEqual(told.slice(1), [{ on: false, to: "ru", only: "controls" }], "said once")
})

test("N3: what a frame is told is checked before it's believed", () => {
  assert.deepEqual(lib.frameState({ on: true, to: "en", only: "controls", url: "https://a.example/", extra: 1 }), { on: true, to: "en", only: "controls", url: "https://a.example/" })
  assert.deepEqual(lib.frameState({ on: false, to: "en", only: "x", url: "https://a.example/" }), { on: false, to: "en", only: null, url: "https://a.example/" })
  for (const bad of [null, {}, { on: "yes", to: "en", url: "u" }, { on: true, to: 5, url: "u" }, { on: true, to: "en" }, { on: true, to: "e".repeat(40), url: "u" }]) assert.equal(lib.frameState(bad), null)
})
