// 2.7 build 109, the owner's test of TestFlight 108, page translation:
//  T1 the engine says it's busy while something shown is being translated, later pieces too;
//  T2 the sites translated whole: the list, the question asked once, the day the answers ran out;
//  T5 words kept from screen readers that the eye sees (a mailbox's dates, a shop's filter), tooltips, a view's
//     heading rewritten for each view;
//  T6 what the page shows later goes first; what it holds but doesn't show yet is translated ahead; the same words
//     are asked once; a site's short words are kept for its next page.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-translate-109-"))
  const src = new URL("../src/content/translate/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, [
    `export * from "${src}blocks.ts"`,
    `export * from "${src}engine.ts"`,
    `export * from "${src}autoSites.ts"`
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

function engine(document: Document, opts: { io?: boolean; hold?: boolean; siteWords?: Map<string, string>; delay?: number } = {}): Made {
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
  return { translator, asks, states, site, release: () => held.splice(0).forEach((f) => f()) }
}

const added = (target: Element, node: Node) => FakeObserver.last!.cb([{ type: "childList", target, addedNodes: [node], removedNodes: [] }])

// ------------------------------------------------------------------ T5: words the eye sees, tooltips

test("T5: words under aria-hidden that the eye sees are translated (a filter's labels, a mailbox's dates); an icon's word isn't", () => {
  const { document } = page(`
    <ul><li><label><input type="checkbox"><span aria-hidden="true">Kopfhörer (66)</span><span class="visually-hidden">Kopfhörer (66 Produkte)</span></label></li></ul>
    <table><tr><td><span title="Montag, 16. November" aria-label="Montag, 16. November"><span aria-hidden="true">16. Nov.</span></span></td></tr></table>
    <button><span aria-hidden="true">close</span> Schließen</button>
    <p>Weiter <span aria-hidden="true">arrow_forward</span></p>
    <div hidden><p>Versteckt</p></div>`)
  const texts = lib.collectBlocks(document.body).map((b: any) => b.text)
  assert.ok(texts.some((t: string) => t.includes("Kopfhörer (66)")), JSON.stringify(texts))
  assert.ok(texts.some((t: string) => t.includes("16. Nov.")), JSON.stringify(texts))
  assert.ok(texts.some((t: string) => t.includes("Schließen")))
  // The icon words stay where they are, as kept elements (never sent as words).
  assert.ok(!texts.some((t: string) => /\bclose\b|arrow_forward/.test(t)), JSON.stringify(texts))
  assert.ok(!texts.some((t: string) => t.includes("Versteckt")), "the hidden attribute still waits")
})

test("T5: a control with no words of its own has its label and tooltip translated with the page; one with words, or a landmark, hasn't", () => {
  const { document } = page(`
    <div role="button" id="reply" aria-label="Antworten" data-tooltip="Antworten"><svg></svg></div>
    <button id="arch" title="Archivieren"><span class="material-icons">archive</span></button>
    <button id="send" aria-label="Nachricht senden">Senden</button>
    <nav aria-label="Hauptmenü"><a href="/a" title="Zur Startseite">Start</a></nav>
    <a id="pic" href="/b" title="Ein sehr langes Bild"><img src="x.png" alt=""></a>`)
  const attrs = lib.collectBlocks(document.body).filter((b: any) => b.attr).map((b: any) => `${b.parent.id}:${b.attr}:${b.text}`)
  assert.deepEqual(attrs.sort(), ["arch:title:Archivieren", "pic:title:Ein sehr langes Bild", "reply:aria-label:Antworten", "reply:data-tooltip:Antworten"])
})

test("T5: a tooltip is translated when the pointer comes to it (and the elements around it), written into the attribute, and put back by Original", async () => {
  const { document } = page(`<main><p>Ein Absatz über Kopfhörer.</p><a id="l" href="/k" title="Mehr über Kopfhörer"><span id="in">Kopfhörer</span></a><p id="plain" title="Tooltip ohne Zeiger">Noch ein Absatz.</p></main>`)
  const { translator, asks } = engine(document)
  await translator.start("ru", "de")
  await wait(40)
  const link = document.getElementById("l")!
  assert.equal(link.getAttribute("title"), "Mehr über Kopfhörer", "not with the page: a page of links with titles doesn't cost twice")
  const n = asks.length
  // The pointer on the words inside the link: the link's title is the tooltip shown.
  const over = new (document.defaultView as any).Event("pointerover", { bubbles: true })
  document.getElementById("in")!.dispatchEvent(over)
  await wait(300)
  assert.equal(link.getAttribute("title"), "RU Mehr über Kopfhörer")
  assert.equal(asks.length, n + 1)
  assert.equal(document.getElementById("plain")!.getAttribute("title"), "Tooltip ohne Zeiger")
  // A finger shows no tooltip: nothing asked for a touch.
  const touch = new (document.defaultView as any).Event("pointerover", { bubbles: true })
  touch.pointerType = "touch"
  document.getElementById("plain")!.dispatchEvent(touch)
  await wait(300)
  assert.equal(document.getElementById("plain")!.getAttribute("title"), "Tooltip ohne Zeiger")
  // Again: nothing asked twice.
  document.getElementById("in")!.dispatchEvent(new (document.defaultView as any).Event("pointerover", { bubbles: true }))
  await wait(300)
  assert.equal(asks.length, n + 1)
  translator.original()
  assert.equal(link.getAttribute("title"), "Mehr über Kopfhörer")
})

test("T5: a label the site rewrites after it was translated is translated again", async () => {
  const { document } = page(`<main><p>Ein Absatz.</p><div role="button" id="mark" aria-label="Als gelesen markieren"><svg></svg></div></main>`)
  const { translator } = engine(document)
  await translator.start("ru", "de")
  await wait(40)
  const mark = document.getElementById("mark")!
  assert.equal(mark.getAttribute("aria-label"), "RU Als gelesen markieren")
  mark.setAttribute("aria-label", "Als ungelesen markieren")
  FakeObserver.last!.cb([{ type: "attributes", target: mark, attributeName: "aria-label", addedNodes: [], removedNodes: [] }])
  await wait(200)
  assert.equal(mark.getAttribute("aria-label"), "RU Als ungelesen markieren")
})

test("T5: a heading the site rewrites for each view is translated every time; one that changes in a row (a clock) is left alone", async () => {
  const { document } = page(`<main><h1 id="h">Posteingang</h1><p>Ein Absatz.</p><p id="clock">Es ist zehn Uhr</p></main>`)
  const { translator } = engine(document)
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await translator.start("ru", "de")
    await wait(40)
    const text = document.getElementById("h")!.firstChild as Text
    for (const view of ["Gesendet", "Entwürfe", "Papierkorb", "Archiv", "Wichtig"]) {
      // A view opened now and then (20 s apart).
      now += 20_000
      text.data = view
      FakeObserver.last!.cb([{ type: "characterData", target: text, addedNodes: [], removedNodes: [] }])
      await wait(150)
      assert.equal(document.getElementById("h")!.textContent, `RU ${view}`)
    }
    const clock = document.getElementById("clock")!.firstChild as Text
    const shown: string[] = []
    for (let i = 1; i <= 6; i++) {
      now += 1_000
      clock.data = `Es ist zehn Uhr und ${i} Sekunden`
      FakeObserver.last!.cb([{ type: "characterData", target: clock, addedNodes: [], removedNodes: [] }])
      await wait(150)
      shown.push(document.getElementById("clock")!.textContent!)
    }
    assert.ok(shown.slice(0, 2).every((s) => s.startsWith("RU ")), JSON.stringify(shown))
    assert.ok(shown.slice(-2).every((s) => !s.startsWith("RU ")), `left alone once it keeps changing: ${JSON.stringify(shown)}`)
  } finally {
    Date.now = realNow
  }
})

// ------------------------------------------------------------------ T1: busy

test("T1: the state is busy while a later piece is being translated, and not once it's shown", async () => {
  const { document } = page(`<main><p>Ein Absatz über Kopfhörer.</p></main>`)
  const { translator, states, release } = engine(document, { hold: true })
  await translator.start("ru", "de")
  await wait(40)
  assert.deepEqual(states.map((s) => s.at), ["working", "on"].slice(0, states.length))
  // The first piece came: the page is on, and soon no longer busy.
  await wait(600)
  assert.deepEqual(translator.state(), { at: "on" })
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  dialog.innerHTML = `<p>Zum Warenkorb hinzugefügt</p><button>Zur Kasse</button>`
  document.body.appendChild(dialog)
  added(document.body, dialog)
  await wait(150)
  assert.deepEqual(translator.state(), { at: "on", busy: true }, "the pop-up is on its way")
  assert.equal(dialog.querySelector("button")!.textContent, "Zur Kasse")
  release()
  await wait(20)
  assert.equal(dialog.querySelector("button")!.textContent, "RU Zur Kasse")
  await wait(600)
  assert.deepEqual(translator.state(), { at: "on" })
})

// ------------------------------------------------------------------ T6: later pieces

test("T6: what the page shows later is asked before what was waiting, in a lane of its own", async () => {
  const many = Array.from({ length: 150 }, (_v, i) => `<p>Absatz Nummer ${i} mit einigen Wörtern darin, damit die Anfrage voll wird und weitere warten müssen.</p>`).join("")
  const { document } = page(`<main>${many}</main>`)
  const { translator, asks, release } = engine(document, { hold: true })
  await translator.start("ru", "de")
  await wait(80)
  // The first request came back; two more are out (both lanes), the rest of the page waits.
  assert.equal(asks.length, 3)
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  dialog.innerHTML = `<button>Zur Kasse</button>`
  document.body.appendChild(dialog)
  added(document.body, dialog)
  await wait(150)
  assert.equal(asks.length, 4, "a lane of its own: not behind the two requests under way")
  assert.deepEqual(asks[3].blocks.map((b: any) => b.text), ["Zur Kasse"])
  release()
  await wait(60)
  assert.equal(dialog.querySelector("button")!.textContent, "RU Zur Kasse")
  release()
})

test("T6: the same words in two places are asked once and written in both", async () => {
  const menu = `<ul><li><a href="/a">Startseite</a></li><li><a href="/b">Kontakt</a></li></ul>`
  const { document } = page(`<header><nav>${menu}</nav></header><main><p>Ein Absatz.</p></main><footer>${menu}</footer>`)
  const { translator, asks } = engine(document)
  await translator.start("ru", "de")
  await wait(120)
  const sent = asks.flatMap((a) => a.blocks.map((b: any) => b.text))
  assert.equal(sent.filter((t: string) => t === "Startseite").length, 1, JSON.stringify(sent))
  assert.deepEqual(Array.from(document.querySelectorAll("a")).map((a) => a.textContent), ["RU Startseite", "RU Kontakt", "RU Startseite", "RU Kontakt"])
})

test("T6: what the page holds but doesn't show yet (a list behind «More») is translated ahead while nothing waits, within the page's allowance; what's further down waits for the scroll", async () => {
  const { document } = page(`<main><p id="top">Ein Absatz über Kopfhörer.</p>
    <ul><li id="shown">Kabel (3)</li><li class="more" id="h1">Ladegeräte (5)</li><li class="more" id="h2">Hüllen (62)</li></ul>
    <p id="far">Weit unten auf der Seite.</p></main>`)
  const { translator, asks, states } = engine(document, { io: true })
  await translator.start("ru", "de")
  const hidden = (el: Element) => el.classList.contains("more")
  FakeIO.last!.report((el) => el.id === "top" || el.id === "shown", hidden)
  await wait(700)
  assert.equal(document.getElementById("top")!.textContent, "RU Ein Absatz über Kopfhörer.")
  assert.equal(document.getElementById("h1")!.textContent, "RU Ladegeräte (5)", "ahead: there when it opens")
  assert.equal(document.getElementById("h2")!.textContent, "RU Hüllen (62)")
  assert.equal(document.getElementById("far")!.textContent, "Weit unten auf der Seite.", "further down: as it scrolls in")
  assert.equal(asks.length, 2, "what's shown first, then what's ahead")
  assert.deepEqual(states.map((s) => (s.busy ? "busy" : s.at)), ["working", "busy", "on"], "busy for what's shown, not for what nobody sees")
  assert.equal(asks.filter((a) => a.first).length, 1)
})

test("T6: translated ahead only so much a page", async () => {
  const items = Array.from({ length: 80 }, (_v, i) => `<li class="more">Eine ziemlich lange Menüzeile Nummer ${i} mit vielen Wörtern, die zusammen über hundertfünfzig Zeichen lang ist, damit das Kontingent der Seite schnell erreicht wird.</li>`).join("")
  const { document } = page(`<main><p id="top">Ein Absatz.</p><ul>${items}</ul></main>`)
  const { translator, asks } = engine(document, { io: true })
  await translator.start("ru", "de")
  FakeIO.last!.report((el) => el.id === "top", (el) => el.classList.contains("more"))
  await wait(300)
  const ahead = asks.slice(1).flatMap((a) => a.blocks).reduce((n: number, b: any) => n + b.text.length, 0)
  assert.ok(ahead > 0 && ahead <= lib.AHEAD_CHARS, `ahead ${ahead}`)
})

test("T6: a site's short words are kept for its next page: its menu needs no request there", async () => {
  const words = new Map<string, string>()
  const menu = `<ul><li><a href="/a">Startseite</a></li><li><a href="/b">Kontakt</a></li></ul>`
  const first = page(`<nav>${menu}</nav><main><p>Ein langer Absatz über Kopfhörer, der gewiss länger als achtzig Zeichen ist und deshalb nur für diese Seite behalten wird.</p></main>`)
  const one = engine(first.document, { siteWords: words })
  await one.translator.start("ru", "de")
  await wait(120)
  one.translator.original()
  assert.deepEqual([...words.keys()].sort(), ["Kontakt", "Startseite"], "short words only")
  const second = page(`<nav>${menu}</nav><main><p>Ein anderer Absatz.</p></main>`)
  const two = engine(second.document, { siteWords: words })
  await two.translator.start("ru", "de")
  await wait(120)
  assert.deepEqual(Array.from(second.document.querySelectorAll("nav a")).map((a) => a.textContent), ["RU Startseite", "RU Kontakt"])
  assert.deepEqual(two.asks.flatMap((a) => a.blocks.map((b: any) => b.text)), ["Ein anderer Absatz."])
})

// ------------------------------------------------------------------ T2: the whole site

test("T2: the sites translated whole: on the list with the language, off again, most recent first, capped", () => {
  let raw: unknown = undefined
  raw = lib.withAuto(raw, { s: "a.example", to: "ru" })
  raw = lib.withAuto(raw, { s: "b.example", to: "en", only: "controls" })
  raw = lib.withAuto(raw, { s: "a.example", to: "de" })
  assert.deepEqual(raw, [{ s: "a.example", to: "de" }, { s: "b.example", to: "en", only: "controls" }])
  assert.deepEqual(lib.autoFor(raw, "b.example"), { s: "b.example", to: "en", only: "controls" })
  assert.equal(lib.autoFor(raw, "c.example"), null)
  assert.deepEqual(lib.withoutAuto(raw, "a.example"), [{ s: "b.example", to: "en", only: "controls" }])
  let many: unknown = []
  for (let i = 0; i < lib.KEPT + 20; i++) many = lib.withAuto(many, { s: `s${i}.example`, to: "ru" })
  assert.equal((many as unknown[]).length, lib.KEPT)
  assert.equal(lib.autoFor("garbage", "a.example"), null)
  assert.equal(lib.autoFor([{ s: 1 }, null, "x"], "a.example"), null)
})

test("T2: the question is asked once per site; the day the answers ran out is today only until the day ends (UTC)", async () => {
  const data: Record<string, unknown> = {}
  const store = { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set: async (items: Record<string, unknown>) => void Object.assign(data, items) }
  assert.equal(await lib.askOnce(store, "a.example"), true)
  assert.equal(await lib.askOnce(store, "a.example"), false)
  assert.equal(await lib.askOnce(store, "b.example"), true)
  await lib.setAuto(store, { s: "a.example", to: "ru" })
  assert.deepEqual(await lib.autoOn(store, "a.example"), { s: "a.example", to: "ru" })
  await lib.clearAuto(store, "a.example")
  assert.equal(await lib.autoOn(store, "a.example"), null)
  const noon = Date.UTC(2026, 10, 18, 12)
  assert.equal(lib.limitedToday(noon, noon + 3 * 3_600_000), true)
  assert.equal(lib.limitedToday(noon, noon + 13 * 3_600_000), false)
  assert.equal(lib.limitedToday(undefined, noon), false)
})
