// Find similar in the panel (2.6, Ultra): its words in every language, the background asking engine A only (never
// Google's), the list as the person sees it (checked price and stock, "Not confirmed", Watch price where the page
// states a price), and the plan's one seam.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

const locales = new URL("../src/locales/", import.meta.url)
const KEYS = ["actSimilar", "uxSimilar", "similarTitle", "similarConditions", "similarCheaper", "similarInStock", "similarNewer",
  "similarFree", "similarMyLanguage", "similarShorter", "similarInLanguage", "similarCustom", "similarHint", "similarFind",
  "similarAsked", "similarAskedWith", "similarStockIn", "similarStockOut", "similarFromList", "similarNotConfirmed",
  "similarNotOpened", "similarWatchPrice", "similarStepPlan", "similarStepSearch", "similarStepCheck", "similarStepCheckN",
  "similarStepWrite", "similarNone", "similarChecked", "similarUpsellText", "similarUpsellChecked", "similarUpsellConditions",
  "similarUpsellWatch", "similarGetUltra", "similarOff", "similarLimit",
  // Build 91: an app's price, read on its App Store page or its pricing page.
  "similarPayFree", "similarPayFreeStart", "similarPaySub", "similarPayOnce", "similarPayIap", "similarPerWeek", "similarPerMonth", "similarPerYear",
  // Build 93: where to look, the less similar ones, their country's store, what reviewers say.
  "similarWhere", "similarWorld", "similarLocal", "similarLocalIn", "similarWhereHint", "similarLess", "similarPercent", "similarDiffers", "similarRegionLocked", "similarRatings", "similarReviewersSay",
  // Build 94: one line of what people say, the share estimated from a description, the app's "found" notification.
  "similarSay", "similarPros", "similarCons", "similarEstimated", "similarNotifyTitle", "similarNotifyFound", "similarNotifyNone", "similarNotifyFailed"]

test("every language has Find similar's words, with their placeholders", () => {
  const files = readdirSync(locales).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 14)
  for (const file of files) {
    const s = JSON.parse(readFileSync(new URL(file, locales), "utf8")) as Record<string, string>
    for (const key of KEYS) assert.ok(s[key]?.trim(), `${file}: ${key}`)
    for (const key of ["similarInLanguage", "similarAskedWith", "similarStepCheckN", "similarChecked", "similarLimit", "similarPaySub", "similarPayOnce", "similarPayIap", "similarPerWeek", "similarPerMonth", "similarPerYear", "similarLocalIn", "similarPercent", "similarDiffers", "similarRatings", "similarReviewersSay", "similarPros", "similarCons", "similarNotifyFound"]) assert.match(s[key], /\{0\}/, `${file}: ${key}`)
    assert.match(s.similarLimit, /\{1\}/, `${file}: similarLimit's day`)
    // The menu item is the action's name with an ellipsis (it opens a card first).
    assert.equal(s.uxSimilar.replace(/…$/, ""), s.actSimilar, file)
  }
})

const { cleanItem, factsFrom, similarAllowed, similarMarkdown } = await import("../src/shared/similar.ts")

test("the plan's seam: Ultra only (Pro, Own key and Free see Ultra's card)", () => {
  assert.equal(similarAllowed("ultra"), true)
  for (const plan of ["pro", "free", "byok", null, undefined]) assert.equal(similarAllowed(plan), false)
})

test("the page's own price and stock go along, read like page watch reads them", () => {
  assert.deepEqual(factsFrom({ ldPrice: "129 USD", ldStock: "InStock" }, "en"), { price: 129, currency: "USD", stock: "in", lang: "en" })
  assert.deepEqual(factsFrom({ metaPrice: "1.299,00", metaStock: "OutOfStock" }, ""), { price: 1299, stock: "out" })
  assert.deepEqual(factsFrom({}, ""), {})
})

test("only well-formed items reach the panel; the Markdown copy keeps the checked links", () => {
  assert.equal(cleanItem({ name: "X", url: "javascript:alert(1)" }), null)
  assert.equal(cleanItem({ name: "", url: "https://a.com" }), null)
  const item = cleanItem({ name: "Acme Q1", url: "https://a.com/q1", host: "a.com", why: "Same kind.", fit: "Cheaper.", met: "yes", price: "79 USD", stock: "in", date: "2026-03-01", watch: { source: "ld-price", value: "79 USD" }, source: "item", checked: true })!
  assert.deepEqual(item.watch, { source: "ld-price", value: "79 USD" })
  assert.equal(cleanItem({ name: "B", url: "https://b.com", watch: { source: "text", value: "1" } })?.watch, undefined)
  const md = similarMarkdown({ intro: "Here.", items: [item, { ...item, name: "Zeta", url: "https://z.com", met: "unknown", checked: false, price: undefined, stock: undefined }], note: "" },
    { inStock: "in stock", outOfStock: "out", notConfirmed: "not confirmed", notOpened: "not opened" })
  assert.match(md, /\*\*\[Acme Q1\]\(https:\/\/a\.com\/q1\)\*\*/)
  assert.match(md, /79 USD · in stock/)
  assert.match(md, /not confirmed · not opened/)
})

test("the background asks engine A only, with the page and the condition", async () => {
  const sent: Array<Record<string, unknown>> = []
  ;(globalThis as any).__API_BASE__ = "https://api.test"
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    const body = [
      `data: ${JSON.stringify({ type: "progress", step: "search", queries: ["q"] })}`,
      `data: ${JSON.stringify({ type: "item", item: { name: "Acme", url: "https://a.com", host: "a.com", met: "n/a", source: "item", checked: true } })}`,
      ": ping",
      `data: ${JSON.stringify({ type: "result", intro: "", items: [{ name: "Acme", url: "https://a.com" }], note: "", condition: "none" })}`,
      `data: ${JSON.stringify({ type: "done" })}`
    ].join("\n\n") + "\n\n"
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), "cf-similar-bg-"))
  const out = join(dir, "bg.mjs")
  await build({
    entryPoints: [new URL("../src/background/similar.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out,
    logLevel: "silent", define: { __API_BASE__: JSON.stringify("https://api.test"), __VERSION__: '"0"', __TARGET__: '"safari"', __SHADOW_MODE__: '"closed"' }
  }).catch(() => build({ entryPoints: [new URL("../src/background/similar.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" }))
  const { askSimilar } = await import(pathToFileURL(out).href)
  const events: Array<{ type: string }> = []
  await askSimilar({ installId: "i", client: {}, entitlement: null, payload: { page: { title: "T", url: "https://p.com", text: "x", facts: {} }, condition: "cheaper" } }, (e: { type: string }) => events.push(e), new AbortController().signal)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].engine, "a")
  assert.equal(sent[0].condition, "cheaper")
  assert.deepEqual(events.map((e) => e.type), ["progress", "item", "result", "done"])
})

// ------------------------------------------------------------ the list, rendered

let ui: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
  const dir = mkdtempSync(join(tmpdir(), "cf-similar-ui-"))
  const src = (p: string) => JSON.stringify(new URL(`../src/content/${p}`, import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { SimilarList, SimilarPicker, SimilarUpsell, whereLabel } from ${src("similar/Similar.tsx")}
    export { whereLabel }
    import { PageMenu } from ${src("ux/PageMenu.tsx")}
    export function list(container: Element, props: unknown) { render(h(SimilarList, props as never), container) }
    export function picker(container: Element, onFind: (c: string, l: string) => void, region?: unknown) { render(h(SimilarPicker, { title: "Aero 2", onFind, onClose() {}, ...(region as object ?? {}) }), container) }
    export function upsell(container: Element) { render(h(SimilarUpsell, { onUpgrade() {}, onClose() {} }), container) }
    export function menu(container: Element, onSimilar: (() => void) | undefined, locked: boolean) {
      render(h(PageMenu, { reminders: 0, watches: null, onLater() {}, onSimilar, similarLocked: locked, onReminders() {}, onWatching() {}, onSettings() {}, onClose() {} }), container)
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname], loader: { ".css": "empty" }
  })
  ui = await import(pathToFileURL(out).href)
})

const root = () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  return el
}

test("the list: checked price and stock, a condition met or Not confirmed, Watch price only where the page states a price", () => {
  const el = root()
  const items = [
    { name: "Acme Q1", url: "https://a.com/q1", host: "a.com", title: "Acme Q1", why: "Same kind.", fit: "Cheaper: $79 vs $129.", met: "yes", source: "item", checked: true, price: "79 USD", stock: "in", watch: { source: "ld-price", value: "79 USD" } },
    { name: "Zeta Z9", url: "https://list.com/best", host: "list.com", title: "Best", why: "Named in a review.", fit: "No price on the page.", met: "unknown", source: "list", checked: true },
    { name: "Shop item", url: "https://shop.com/x", host: "shop.com", title: "X", why: "Similar.", fit: "", met: "unknown", source: "item", checked: false },
    // A free app: its price is 0, nothing to watch.
    { name: "Free timer", url: "https://free.app/", host: "free.app", title: "Free timer", why: "Same idea.", fit: "", met: "yes", source: "item", checked: true, price: "0 USD", watch: { source: "ld-price", value: "0 USD" } }
  ]
  ui.list(el, { answer: { intro: "Here.", items, note: "", condition: "cheaper", asked: "cheaper", at: Date.parse("2026-11-08T10:00:00Z") }, items, onOpen() {}, onWatch() {} })
  assert.equal(el.querySelectorAll(".cf-similar-item").length, 4)
  assert.equal(el.querySelectorAll(".cf-similar-fit.ok").length, 1)
  assert.equal(el.querySelectorAll(".cf-similar-nc").length, 2)
  assert.equal(el.querySelectorAll(".cf-similar-watch").length, 1)
  assert.equal(el.querySelectorAll(".cf-similar-unopened").length, 1)
  assert.match(el.textContent, /\$79\.00|79/)
  assert.ok(el.querySelector(".cf-similar-checked"))
  // While it comes: the step, no "checked at" yet.
  const busy = root()
  ui.list(busy, { items: items.slice(0, 1), step: "check", pages: 12, onOpen() {} })
  assert.ok(busy.querySelector(".cf-similar-step"))
  assert.ok(!busy.querySelector(".cf-similar-checked"))
  assert.equal(busy.querySelectorAll(".cf-similar-watch").length, 0)
})

test("an app's price as its pages say, linked to where it was read; links open as the browser opens them", async () => {
  const el = root()
  const items = [
    { name: "Glarity", url: "https://apps.apple.com/us/app/glarity/id1", host: "apps.apple.com", title: "Glarity", why: "Same idea.", fit: "Free to download; Pro from $9.99/month.", met: "yes", source: "item", checked: true, price: "0 USD",
      pricing: { model: "subscription", from: "9.99 USD", period: "month", freeStart: true, url: "https://apps.apple.com/us/app/glarity/id1" } },
    { name: "Raycast", url: "https://raycast.com/", host: "raycast.com", title: "Raycast", why: "Same idea.", fit: "", met: "yes", source: "item", checked: true,
      pricing: { model: "subscription", from: "10 USD", period: "month", freeStart: true, url: "https://raycast.com/pricing" } },
    { name: "Things 3", url: "https://apps.apple.com/us/app/things-3/id2", host: "apps.apple.com", title: "Things 3", why: "", fit: "", met: "n/a", source: "item", checked: true, price: "9.99 USD",
      pricing: { model: "one_time", from: "9.99 USD", url: "https://apps.apple.com/us/app/things-3/id2" } },
    { name: "Pages", url: "https://apps.apple.com/us/app/pages/id3", host: "apps.apple.com", title: "Pages", why: "", fit: "", met: "yes", source: "item", checked: true, price: "0 USD",
      pricing: { model: "free", url: "https://apps.apple.com/us/app/pages/id3" } }
  ]
  const opened: string[] = []
  ui.list(el, { items, onOpen: (u: string) => opened.push(u) })
  const pay = [...el.querySelectorAll(".cf-similar-pay")].map((a: any) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")])
  assert.deepEqual(pay, [
    ["Free · Subscription from $9.99/month", "https://apps.apple.com/us/app/glarity/id1", "_blank"],
    ["Free · Subscription from $10.00/month", "https://raycast.com/pricing", "_blank"],
    ["One-time purchase $9.99", "https://apps.apple.com/us/app/things-3/id2", "_blank"],
    ["Free, no in-app purchases", "https://apps.apple.com/us/app/pages/id3", "_blank"]
  ])
  // The store's $0.00 doesn't show next to it.
  assert.ok(!/\$0\.00/.test(el.textContent))
  // Title, host and price line are links to a new tab; the click is the browser's own.
  const title = el.querySelector(".cf-similar-name")
  assert.equal(title.getAttribute("target"), "_blank")
  assert.equal(el.querySelector(".cf-similar-host a").getAttribute("href"), items[0].url)
  const click = new dom.window.Event("click", { bubbles: true, cancelable: true })
  title.dispatchEvent(click)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(click.defaultPrevented, false)
  assert.deepEqual(opened, [])
  // A page that stops links itself: the background opens it.
  const stopped = new dom.window.Event("click", { bubbles: true, cancelable: true })
  stopped.preventDefault()
  el.querySelectorAll(".cf-similar-name")[1].dispatchEvent(stopped)
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(opened, ["https://raycast.com/"])
})

test("build 93: the less similar ones apart with how close and how they differ, a store that doesn't sell it, reviewers", async () => {
  const el = root()
  const base = { url: "https://a.example", host: "a.example", title: "A", why: "Same idea.", fit: "", met: "n/a", source: "item", checked: true }
  const items = [
    { ...base, name: "Merlin", url: "https://apps.apple.com/ru/app/id222", host: "apps.apple.com", similarity: 100,
      reviews: { rating: { value: 4.6, best: 5, count: 1234 }, summary: "Fast summaries; the free plan is limited.", sources: ["https://apps.apple.com/ru/app/id222", "https://techreview.example/merlin"] } },
    { ...base, name: "Glarity", url: "https://apps.apple.com/us/app/id111", host: "apps.apple.com", similarity: 50, differs: "No translation", regionLocked: true },
    { ...base, name: "Beta", url: "https://b.example", host: "b.example", similarity: 25, differs: "Chrome only" }
  ]
  ui.list(el, { answer: { intro: "", items, note: "", condition: "none", asked: "", at: Date.now() }, items, onOpen() {} })
  const text = el.textContent as string
  assert.equal(el.querySelectorAll(".cf-similar-less .cf-similar-item").length, 2)
  assert.match(el.querySelector(".cf-similar-less-head").textContent, /Less similar/)
  assert.match(text, /50% similar/)
  assert.match(text, /Differs: No translation/)
  assert.match(el.querySelector(".cf-similar-locked").textContent, /Not in your country's App Store/)
  assert.match(el.querySelector(".cf-similar-stars").textContent, /★ 4\.6/)
  assert.match(text, /1,234 ratings/)
  // An answer kept from build 93: its one-sentence summary on the same line, after "What people say:".
  assert.match(el.querySelector(".cf-similar-reviews").textContent, /^What people say:★ 4\.6 · 1,234 ratings · Fast summaries; the free plan is limited\. · apps\.apple\.com · techreview\.example$/)
  assert.deepEqual([...el.querySelectorAll(".cf-similar-src")].map((a: any) => [a.textContent, a.getAttribute("target")]), [["apps.apple.com", "_blank"], ["techreview.example", "_blank"]])
  // Build 94: the close one says how close too (the owner: the only item showed no share).
  assert.match(el.querySelector(".cf-similar-list .cf-similar-pct").textContent, /^100% similar$/)
  assert.equal(el.querySelector(".cf-similar-list .cf-similar-pct").closest(".cf-similar-less"), null)
})

test("build 93: where to look is asked the first time (Find waits for it), then shown as chosen", async () => {
  const el = root()
  let chosen: unknown = null
  const found: string[] = []
  ui.picker(el, (c: string) => found.push(c), { region: null, country: "DE", onRegion: (r: unknown) => (chosen = r) })
  await new Promise((r) => setTimeout(r, 0))
  const find = el.querySelector(".cf-similar-pick .cf-primary")
  assert.equal(find.disabled, true)
  assert.ok(el.querySelector(".cf-similar-where-hint"))
  const options = [...el.querySelectorAll(".cf-similar-where button")]
  assert.equal(options.length, 2)
  assert.match(options[1].textContent, /Near me · Germany/)
  options[0].dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  assert.equal(chosen, "world")
  // Chosen before: shown as such, Find goes.
  const again = root()
  ui.picker(again, (c: string) => found.push(c), { region: "local", country: "DE", onRegion() {} })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(again.querySelector(".cf-similar-where button.on").textContent.includes("Germany"), true)
  assert.equal(again.querySelector(".cf-similar-pick .cf-primary").disabled, false)
})

test("the start: a chip is the condition (one at a time), the person's words join it", async () => {
  const el = root()
  const asked: Array<[string, string]> = []
  ui.picker(el, (c: string, l: string) => asked.push([c, l]))
  const chips = el.querySelectorAll(".cf-similar-chips .cf-chip")
  assert.equal(chips.length, 6)
  el.querySelector(".cf-primary").click()
  assert.deepEqual(asked[0], ["", "Find similar"])
  // A chip: the bubble says the chip's words, no "Find similar:" prefix (the icon says it; build 90).
  chips[0].click()
  await new Promise((r) => setTimeout(r, 20))
  el.querySelector(".cf-primary").click()
  assert.deepEqual(asked[1], ["Cheaper", "Cheaper"])
})

test("no zoom on iOS: Find similar's field and quick insert's are 16px on touch screens", () => {
  const css = (p: string) => readFileSync(new URL(`../src/content/${p}`, import.meta.url), "utf8")
  assert.match(css("similar/similar.css"), /\.cf\[data-touch\] \.cf-similar-words \{ font-size: 16px; \}/)
  assert.match(css("insert/insert.css"), /@media \(pointer: coarse\) \{\s*\.cf-qi-area, \.cf-qi-blank, \.cf-qi-fill-text \{ font-size: 16px; \}/)
  assert.match(css("watch/watch.css"), /\.cf-watch-cond \{[^}]*font-size: 16px/)
})

test("the menu: Find similar… where there is a page, with Ultra's badge for someone without it", () => {
  const el = root()
  ui.menu(el, () => undefined, true)
  const item = el.querySelector(".cf-page-similar")
  assert.ok(item)
  assert.ok(item.querySelector(".cf-ultra-badge"))
  const none = root()
  ui.menu(none, undefined, false)
  assert.equal(none.querySelector(".cf-page-similar"), null)
  const upsell = root()
  ui.upsell(upsell)
  assert.ok(upsell.querySelector(".cf-ultra-badge"))
})

test("build 94: every item's share, estimated when its page wasn't opened; one line of what people say", async () => {
  const el = root()
  const base = { why: "Same idea.", fit: "", met: "n/a", source: "item", checked: true, title: "" }
  const items = [
    { ...base, name: "Fanwoli Rolling Vacuum Backpack", url: "https://www.amazon.com/dp/B0X", host: "amazon.com", checked: false, similarity: 75, estimated: true },
    { ...base, name: "Backvac Pro", url: "https://mybackvac.com/products/backvacpro", host: "mybackvac.com", similarity: 50, differs: "No trolley; the brand's Pro Max has one, at 272.95 EUR — over your budget",
      reviews: { rating: { value: 4.6, best: 5, count: 687 }, pros: "compression, sturdy zips", cons: "the price", sources: ["https://mybackvac.com/products/backvacpro"] } },
    { ...base, name: "PacknTrip ProPack", url: "https://packntrip.store/p", host: "packntrip.store", similarity: 50, reviews: { pros: "carry-on fit", sources: ["https://packntrip.store/p"] } }
  ]
  ui.list(el, { answer: { intro: "", items, note: "", condition: "cheaper", asked: "", at: Date.now() }, items, onOpen() {} })
  const pct = [...el.querySelectorAll(".cf-similar-pct")].map((p: any) => p.textContent)
  assert.deepEqual(pct, ["75% similar · estimated from the description", "50% similar", "50% similar"])
  const lines = [...el.querySelectorAll(".cf-similar-reviews")].map((p: any) => p.textContent)
  assert.deepEqual(lines, [
    "What people say:★ 4.6 · 687 ratings · like compression, sturdy zips · dislike the price · mybackvac.com",
    "What people say:like carry-on fit · packntrip.store"
  ])
  assert.match(el.textContent, /Differs: No trolley; the brand's Pro Max has one/)
})

test("build 94: the question line says where it looked", () => {
  assert.equal(ui.whereLabel("world"), "Worldwide")
  assert.equal(ui.whereLabel("local", "CY"), "Near me · Cyprus")
  assert.equal(ui.whereLabel("local"), "Near me")
})
