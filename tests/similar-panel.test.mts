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
  "similarUpsellWatch", "similarGetUltra", "similarOff", "similarLimit"]

test("every language has Find similar's words, with their placeholders", () => {
  const files = readdirSync(locales).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 14)
  for (const file of files) {
    const s = JSON.parse(readFileSync(new URL(file, locales), "utf8")) as Record<string, string>
    for (const key of KEYS) assert.ok(s[key]?.trim(), `${file}: ${key}`)
    for (const key of ["similarInLanguage", "similarAskedWith", "similarStepCheckN", "similarChecked", "similarLimit"]) assert.match(s[key], /\{0\}/, `${file}: ${key}`)
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
    import { SimilarList, SimilarPicker, SimilarUpsell } from ${src("similar/Similar.tsx")}
    import { PageMenu } from ${src("ux/PageMenu.tsx")}
    export function list(container: Element, props: unknown) { render(h(SimilarList, props as never), container) }
    export function picker(container: Element, onFind: (c: string, l: string) => void) { render(h(SimilarPicker, { title: "Aero 2", onFind, onClose() {} }), container) }
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
    { name: "Shop item", url: "https://shop.com/x", host: "shop.com", title: "X", why: "Similar.", fit: "", met: "unknown", source: "item", checked: false }
  ]
  ui.list(el, { answer: { intro: "Here.", items, note: "", condition: "cheaper", asked: "cheaper", at: Date.parse("2026-11-08T10:00:00Z") }, items, onOpen() {}, onWatch() {} })
  assert.equal(el.querySelectorAll(".cf-similar-item").length, 3)
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

test("the start: a chip is the condition (one at a time), the person's words join it", () => {
  const el = root()
  const asked: Array<[string, string]> = []
  ui.picker(el, (c: string, l: string) => asked.push([c, l]))
  const chips = el.querySelectorAll(".cf-similar-chips .cf-chip")
  assert.equal(chips.length, 6)
  el.querySelector(".cf-primary").click()
  assert.deepEqual(asked[0], ["", "Find similar"])
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
