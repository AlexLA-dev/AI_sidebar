// Build 91: the plans message in the chat (out of answers, the chat's memory, a Pro or Ultra feature): Pro or Ultra,
// monthly or yearly with the App Store's price and the yearly saving, the choice handed to the app, logged once shown
// and on every tap, and Retry alive once the answers are back. Also: the conversation is cached for the next question.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

// The App Store's prices as the app shares them (ContextFlow.storekit).
const PRICES = {
  "com.contextflow.pro.monthly": "$6.99", "com.contextflow.pro.yearly": "$59.99",
  "com.contextflow.pro.yearly#perMonth": "$5.00", "com.contextflow.pro.yearly#percent": "28",
  "com.contextflow.ultra.monthly": "$12.99", "com.contextflow.ultra.yearly": "$119.99"
}
const STATUS = {
  plan: "free", store: { active: false, productId: null, prices: PRICES },
  plans: { proWeekly: 300, similarWeekly: 10, speakWeeklySeconds: 7200, watch: { free: 2, pro: 10, ultra: 30 } }
}

let ui: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element })
  const dir = mkdtempSync(join(tmpdir(), "cf-offer-"))
  const src = JSON.stringify(new URL("../src/content/ux/PlanOffer.tsx", import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { PlanOffer } from ${src}
    export function offer(container: Element, props: unknown) { render(h(PlanOffer, props as never), container) }
    export function clear(container: Element) { render(null, container) }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname], loader: { ".css": "empty" }
  })
  ui = await import(pathToFileURL(out).href)
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const click = async (el: any) => {
  el.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  await tick()
}

test("Pro or Ultra, monthly or yearly: the App Store's price, the yearly saving, the choice to the app", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  const events: Array<[string, unknown]> = []
  const chosen: unknown[] = []
  ui.offer(el, { place: "limit", status: STATUS, title: "You're out of answers", body: "5 more at 3:00 AM.", onChoose: (c: unknown) => chosen.push(c), onEvent: (a: string, c: unknown) => events.push([a, c]) })
  // Effects run after the next frame (Preact falls back to a 100 ms timer without one).
  await new Promise((r) => setTimeout(r, 150))
  // Shown once, on Pro yearly (the first plan, the yearly period).
  assert.deepEqual(events, [["shown", { plan: "pro", period: "yearly" }]])
  const text = () => el.textContent as string
  assert.match(text(), /\$59\.99/)
  assert.match(text(), /28/)
  assert.match(text(), /\$5\.00/)
  const segs = el.querySelectorAll(".cf-seg button")
  assert.equal(segs.length, 4) // Pro, Ultra; Monthly, Yearly
  await click(segs[1]) // Ultra
  assert.match(text(), /\$119\.99/)
  await click(segs[2]) // Monthly
  assert.match(text(), /\$12\.99/)
  assert.doesNotMatch(text(), /\$119\.99/)
  await click(el.querySelector(".cf-primary"))
  assert.deepEqual(chosen, [{ plan: "ultra", period: "monthly" }])
  assert.deepEqual(events.at(-1), ["choose", { plan: "ultra", period: "monthly" }])
})

test("one plan only (an Ultra feature, or Pro at its limit): no plan switch; without prices, still the choice", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  ui.offer(el, { place: "ultra_only", status: { plan: "free" }, title: "Find similar", lines: ["Checked links", "Your conditions"], plans: ["ultra"], onChoose() {}, onEvent() {} })
  await tick()
  assert.equal(el.querySelectorAll(".cf-seg button").length, 2)
  assert.equal(el.querySelectorAll(".cf-upsell-list li").length, 2)
  assert.ok(el.querySelector(".cf-primary"))
  assert.equal(el.querySelector(".cf-plan-price"), null)
})

test("Retry: off until the answers are back, then the question goes again", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  let retried = 0
  ui.offer(el, { place: "limit", status: STATUS, title: "Out", retryAt: Date.now() + 3_600_000, onRetry: () => retried++, onChoose() {}, onEvent() {} })
  await tick()
  const button = [...el.querySelectorAll(".cf-secondary")].find((b: any) => /Retry/.test(b.textContent))
  assert.ok(button)
  assert.equal(button.disabled, true)
  assert.ok(el.querySelector(".cf-offer-retry-at"))
  const back = dom.document.createElement("div")
  dom.document.body.appendChild(back)
  ui.offer(back, { place: "limit", status: STATUS, title: "Out", retryAt: Date.now() - 1_000, onRetry: () => retried++, onChoose() {}, onEvent() {} })
  await tick()
  const live = [...back.querySelectorAll(".cf-secondary")].find((b: any) => /Retry/.test(b.textContent))
  assert.equal(live.disabled, false)
  await click(live)
  assert.equal(retried, 1)
  // Gone from the chat: its timer with it.
  ui.clear(el)
  ui.clear(back)
})

test("the conversation is cached for the next question once there is one", async () => {
  const { cachedConversation } = await import("../netlify/shared/answer.mts")
  const one = [{ role: "user" as const, content: "q" }]
  assert.deepEqual(cachedConversation(one), one)
  const three = [{ role: "user" as const, content: "q1" }, { role: "assistant" as const, content: "a1" }, { role: "user" as const, content: "q2" }]
  const cached = cachedConversation(three)
  assert.deepEqual(cached.slice(0, 2), three.slice(0, 2))
  assert.deepEqual(cached[2], { role: "user", content: [{ type: "text", text: "q2", cache_control: { type: "ephemeral" } }] })
})

test("the plans message is logged: shown and every tap, by place, plan and period", async () => {
  const { useFields } = await import("../src/shared/usage.ts")
  assert.deepEqual(useFields({ f: "chat_plans", a: "choose", via: "memory", plan: "ultra", period: "monthly" }), { f: "chat_plans", a: "choose", via: "memory", plan: "ultra", period: "monthly" })
  assert.deepEqual(useFields({ f: "chat_plans", a: "shown", via: "limit", plan: "pro", period: "yearly" }), { f: "chat_plans", a: "shown", via: "limit", plan: "pro", period: "yearly" })
  assert.equal(useFields({ f: "chat_plans", a: "buy" }), null)
})
