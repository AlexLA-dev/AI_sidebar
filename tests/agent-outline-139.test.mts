// Round 139 (the director's «eyes», part 1a): the page as an outline for the model — words and controls together in
// reading order, hints in their own field, a control inside a link kept, twins once, the site's menus folded, parts
// opened by a read that stay open — while every guard keeps reading the map's own words (`text`) and controls.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { parseHTML } from "linkedom"
import { classify } from "../src/shared/agent/classify.ts"
import { weightedLength } from "../src/shared/agent/length.ts"
import { confirmedOnPage, requestWords } from "../src/shared/agent/runner.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"
import { stepMessage } from "../netlify/shared/act.mts"

function domMap(html: string, opts: Record<string, unknown> = {}, url = "https://shop.example/page"): PageMap {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
  const loc = new URL(url)
  Object.defineProperty(document, "location", { configurable: true, get: () => loc })
  Object.defineProperty(document, "baseURI", { configurable: true, get: () => url })
  Object.defineProperty(window, "location", { configurable: true, get: () => loc })
  ;(window as any).getComputedStyle = (el: Element) => {
    const inline = el.getAttribute("style") ?? ""
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`).exec(inline)?.[1]?.trim()
    return { display: get("display") ?? "block", visibility: "visible", contentVisibility: "visible", opacity: "1", pointerEvents: "auto", cursor: "auto", textDecorationLine: "none", color: "rgb(20, 20, 20)", backgroundColor: el.tagName === "BODY" ? "rgb(255, 255, 255)" : "rgba(0, 0, 0, 0)" }
  }
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  if ((document as any).defaultView !== window) Object.defineProperty(document, "defaultView", { configurable: true, get: () => window })
  // (data-top: where an element is against the screen; an element without one sits where its nearest placed parent does.)
  for (const el of document.querySelectorAll("*")) {
    const placed = el.closest("[data-top]")
    const top = Number(placed?.getAttribute("data-top") ?? 100)
    ;(el as any).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 10, right: 80, width: 70, height: 40 })
  }
  return (globalThis as any).__buildMap(document, opts)
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-outline-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export { buildMap } from "${new URL("../src/content/agent/map.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "map.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", define: { __TARGET__: '"safari"', __API_BASE__: '""', __TEST_PLAN__: '""' } })
  ;(globalThis as any).__buildMap = (await import(pathToFileURL(out).href)).buildMap
})

const ctx = (map: PageMap) => ({ map, startHost: "shop.example", request: "Book a room for 2 nights", confirmedHere: false, policy: { amazon: false, block: [], allow: [] } })
const byLabel = (map: PageMap, label: string) => map.items.find((i) => i.label === label)
const lineWith = (map: PageMap, id: string) => (map.outline ?? "").split("\n").find((l) => l.includes(`[#${id} `)) ?? ""

test("words and controls together: a card's control in its card's line, a picker's apply under its dates", () => {
  const map = domMap(`
    <div class="card"><h3>Hotel Sole</h3><div><span>9.1 Superb</span> <span>from €120</span> <button>See availability</button></div></div>
    <div class="card"><h3>Hotel Luna</h3><div><span>8.4 Very good</span> <button>See availability</button></div></div>
    <div class="picker"><div><button aria-pressed="true">4 Dec</button><button aria-pressed="true">6 Dec</button><button>Apply changes</button></div></div>`)
  const outline = map.outline ?? ""
  const lines = outline.split("\n")
  const sole = lines.findIndex((l) => l === "# Hotel Sole")
  const luna = lines.findIndex((l) => l === "# Hotel Luna")
  assert.ok(sole >= 0 && luna > sole, outline)
  const soleLine = lines.slice(sole + 1, luna).join(" ")
  assert.match(soleLine, /9\.1 Superb.*from €120.*\[#\S+ button "See availability"\]/)
  const apply = byLabel(map, "Apply changes")!
  assert.match(lineWith(map, apply.id), /"4 Dec" pressed\].*"6 Dec" pressed\].*"Apply changes"/, "the apply sits with the dates it applies")
  // Every number the outline shows is in the map's list.
  for (const m of outline.matchAll(/\[#([^\s\]]+)/g)) assert.ok(map.items.some((i) => i.id === m[1]), m[1])
})

test("a false «confirmed» before the last press: the outline's words never make the device think a booking is done", () => {
  // A details form that says the booking number will be e-mailed, a card that boasts instant confirmation, a footer
  // that offers an account: all in div/span text, which the outline brings in and today's words don't.
  const html = `<form><div>お客様情報</div><div>予約番号はメールでお送りします</div><div>رقم الحجز سيرسل إليك</div><div>Booking confirmed instantly — no waiting</div>
    <label>電話 <input type="tel" autocomplete="tel"></label><button type="submit">予約する</button></form>
    <footer><div><a href="/signup">Create an account</a></div></footer>`
  const map = domMap(html)
  assert.match(map.outline ?? "", /予約番号はメールでお送りします/, "the model reads it")
  assert.match(map.outline ?? "", /Booking confirmed instantly/)
  assert.ok(!/予約番号|رقم الحجز|confirmed/.test(map.text), "the guards' words don't carry it")
  assert.equal(confirmedOnPage(map), false, "not confirmed before the last press")
  // The guard on the booking's press is the same with or without the outline.
  const submit = byLabel(map, "予約する")!
  const call: ToolCall = { tool: "click", id: submit.id, why: "" }
  assert.deepEqual(classify(call, ctx(map)), classify(call, ctx({ ...map, outline: undefined, sections: undefined })))
  // (The same words in the map's own text do read as confirmed: the channel, not the word list, keeps them apart.)
  assert.equal(confirmedOnPage({ ...map, text: `${map.text}\n予約番号はメールでお送りします` }), true)
})

test("a control with no words gets a hint in its own field: shown to the model, never its name, never a class", () => {
  const map = domMap(`<div><button class="icon close-icon"><svg><use href="#icon-close"></use></svg></button>
    <button data-testid="pay-now-button"><svg></svg></button><button data-testid="next-step"><svg></svg></button><button>Pay now</button></div>`)
  const close = map.items.find((i) => i.hint === "icon-close")
  assert.ok(close, JSON.stringify(map.items))
  assert.equal(close!.label, "", "a hint is never the label")
  const pay = map.items.find((i) => i.hint === "pay-now-button")!
  const next = map.items.find((i) => i.hint === "next-step")!
  for (const it of [close!, pay, next]) {
    const call: ToolCall = { tool: "click", id: it.id, why: "" }
    const without = { ...map, items: map.items.map((i) => (i.id === it.id ? { ...i, hint: undefined } : i)) }
    assert.deepEqual(classify(call, ctx(map)), classify(call, ctx(without)), it.hint)
  }
  assert.equal(classify({ tool: "click", id: byLabel(map, "Pay now")!.id, why: "" }, ctx(map)).cls, "self", "real words still decide")
  assert.match(map.outline ?? "", /\[#\S+ button \(icon-close\)\]/)
  const message = stepMessage({ request: "Close the banner", lang: "en", map, log: [] })
  assert.match(message, /hint=\(pay-now-button\)/)
})

test("a button inside a card link is a control of its own; a link and the button drawn in it, or a day's option and its checkbox, go once", () => {
  const map = domMap(`
    <a href="/specialist/anna"><div><span>Анна</span> <span>Барбер, 5 лет</span></div><button>Записаться</button></a>
    <a href="/book"><button>Book</button></a>
    <div role="option" aria-label="Fri 4 Dec 2026"><span role="checkbox" aria-label="Fri 4 Dec 2026"></span></div>`)
  assert.ok(map.items.some((i) => i.role === "link" && i.href?.includes("/specialist/anna")), "the card's link")
  assert.ok(map.items.some((i) => i.role === "button" && i.label === "Записаться"), "the button inside it")
  assert.equal(map.items.filter((i) => i.label === "Book").length, 1, "a link and its button: once")
  assert.equal(map.items.filter((i) => i.label === "Fri 4 Dec 2026").length, 1, "a day's twins: once")
})

test("the site's own menus fold to a line; a nav in the page's main part, a menu link with the request's words, and a header's fields stay", () => {
  const html = `<header><nav><a href="/">Home</a><a href="/hotels">Hotels</a><a href="/flights">Flights</a><a href="/cars">Car rental</a></nav>
      <form><input aria-label="Where are you going?"></form></header>
    <main><nav><a href="/rooms">Rooms</a><a href="/reviews">Guest reviews</a></nav><p>Choose your room</p></main>
    <footer><a href="/terms">Terms</a><a href="/careers">Careers</a></footer>`
  const map = domMap(html, { words: requestWords("Book flights to Rome") })
  const outline = map.outline ?? ""
  assert.match(outline, /\[the site's menu: Home · Hotels · Flights · Car rental\]/)
  assert.match(outline, /\[#\S+ link "Flights"\]/, "a menu link with the request's words keeps its token")
  assert.ok(!/\[#\S+ link "Hotels"\]/.test(outline), "other menu links are folded")
  assert.match(outline, /\[#\S+ textbox "Where are you going\?"/, "the header's field stays")
  assert.match(outline, /\[#\S+ link "Rooms"\].*\[#\S+ link "Guest reviews"\]/, "a nav inside main stays")
  assert.match(outline, /\[the site's menu: Terms · Careers\]/)
  // The folded links are still controls of the map (the guards and the device see them).
  assert.ok(byLabel(map, "Hotels"), "still in the list")
})

test("the rest of the page is in parts by its headings; a read opens one and it stays open with the next", () => {
  const html = `<div data-top="100"><h2>Your stay</h2><p>2 nights, 2 adults</p></div>
    <div data-top="2000"><h2>Rooms and prices</h2><div><span>Double room €180</span><button>Reserve</button></div></div>
    <div data-top="3000"><h2>Guest reviews</h2><div><span>Clean and quiet</span><a href="/r">Read all reviews</a></div></div>`
  const closed = domMap(html)
  assert.equal(closed.sections, 2)
  assert.match(closed.outline ?? "", /§2 "Rooms and prices" \(below; 1 controls: \[#\S+ button "Reserve"\]\)/)
  assert.match(closed.outline ?? "", /§3 "Guest reviews" \(below/)
  assert.ok(!/Double room/.test(closed.outline ?? ""), "a closed part shows only its line")
  const one = domMap(html, { open: [2], openUrl: "https://shop.example/page" })
  assert.match(one.outline ?? "", /§2 \(opened\):\n# Rooms and prices\nDouble room €180 \[#\S+ button "Reserve"\]/)
  const two = domMap(html, { open: [2, 3], openUrl: "https://shop.example/page" })
  assert.match(two.outline ?? "", /Double room €180/, "the first read stays")
  assert.match(two.outline ?? "", /Clean and quiet/, "the second adds")
  const elsewhere = domMap(html, { open: [2], openUrl: "https://shop.example/other" })
  assert.ok(!/Double room/.test(elsewhere.outline ?? ""), "parts opened on another page aren't open here")
})

test("a personal field's value never reaches the outline, even where the page writes it back", () => {
  const map = domMap(`<form><label>E-mail <input type="email" autocomplete="email" value="alex.test@example.com"></label>
    <div>We'll send the confirmation to alex.test@example.com</div><div contenteditable="true">my private note</div></form>`)
  const outline = map.outline ?? ""
  assert.ok(!outline.includes("alex.test@example.com"), outline)
  assert.match(outline, /\[a filled detail\]/)
  assert.ok(!outline.includes("my private note"), "an editor's own text isn't read")
})

test("the server shows the outline in place of the text, and each log line with the step's own «why»", () => {
  const map = domMap(`<div><h3>Hotel Sole</h3><button>See availability</button></div>`)
  const message = stepMessage({ request: "Book Hotel Sole", lang: "en", map, log: [{ call: { tool: "click", id: "9", why: "Opening the dates" }, target: `button "Dates"`, result: "the page changed" }] })
  assert.match(message, /page in reading order/)
  assert.ok(!/\ntext:\n/.test(message), "no second copy of the words")
  assert.match(message, /1\. click #9 \(button "Dates"\) — why: "Opening the dates" → the page changed/)
  // A map without an outline (an older device) reads as before.
  const old = stepMessage({ request: "Book Hotel Sole", lang: "en", map: { ...map, outline: undefined, sections: undefined }, log: [] })
  assert.match(old, /\ntext:\n/)
  assert.match(old, /controls \(part 1 of 1\)/)
})

test("length rules weigh Han, kana and Hangul characters three", () => {
  assert.equal(weightedLength("Book now"), 8)
  assert.equal(weightedLength("予約する"), 12)
  assert.equal(weightedLength("예약"), 6)
  assert.equal(weightedLength("حجز"), 3)
})
