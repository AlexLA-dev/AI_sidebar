// 2.8 (Р19, the owner «да, упрощай»): the free answers' limit card, simpler. One plan box (Pro, monthly), one buy button
// (with the −50 % code when this person has it, through the App Store's code page), «Remind me at …», and «More» holding
// yearly, Ultra, a note and the own key. A subscriber at the limit keeps their card. Events: "more" opened, and what was
// tapped inside it with from "more". No «Cancel anytime in two taps» (not true), in any language.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const PRICES = {
  "com.contextflow.pro.monthly": "$6.99", "com.contextflow.pro.yearly": "$59.99", "com.contextflow.pro.yearly#percent": "28",
  "com.contextflow.ultra.monthly": "$12.99", "com.contextflow.ultra.yearly": "$119.99"
}
const STATUS = {
  plan: "free", store: { active: false, productId: null, prices: PRICES },
  plans: { proWeekly: 375, similarWeekly: 10, speakWeeklySeconds: 7200, watch: { free: 2, pro: 10, ultra: 30 } }
}
const OFFER = { code: "HALF", discount: 50 }

let ui: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element })
  const dir = mkdtempSync(join(tmpdir(), "cf-limit-"))
  const src = JSON.stringify(join(root, "src/content/ux/LimitCard.tsx"))
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { LimitCard } from ${src}
    export function card(container: Element, props: unknown) { render(h(LimitCard, props as never), container) }
    export function clear(container: Element) { render(null, container) }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [join(root, "node_modules")], loader: { ".css": "empty" }
  })
  ui = await import(pathToFileURL(out).href)
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const click = async (el: any) => {
  el.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  await tick()
}

function mount(props: Record<string, unknown>) {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  const events: unknown[][] = []
  const calls: unknown[][] = []
  ui.card(el, {
    status: STATUS, title: "You've used today's free answers", body: "5 new free answers at 2:00 AM, in 1 h 40 min.",
    offer: null, retryAt: Date.now() + 3_600_000, ownKey: true, onRetry: () => calls.push(["retry"]),
    onChoose: (c: unknown) => calls.push(["choose", c]), onRedeem: (code: string) => calls.push(["redeem", code]),
    onNote: () => calls.push(["note"]), onOwnKey: () => calls.push(["own_key"]),
    onEvent: (...args: unknown[]) => events.push(args.filter((a) => a !== undefined)),
    ...props
  })
  return { el, events, calls, text: () => el.textContent as string, buttons: () => [...el.querySelectorAll("button")] as any[] }
}

test("no offer: one box (Pro, monthly price), one buy button with the price, the renewal said, More closed", async () => {
  const card = mount({})
  await tick(150)
  // Shown in its full-price state (the first time at the limit, 2.8: the owner).
  assert.deepEqual(card.events, [["shown", { plan: "pro", period: "monthly" }, "full"]])
  // Three controls: the buy button and More (the reminder is passed in by the panel; Retry waits for the answers).
  assert.equal(card.buttons().length, 2)
  assert.equal(card.el.querySelectorAll(".cf-seg").length, 0)
  assert.match(card.el.querySelector(".cf-plan-price").textContent, /\$6\.99 \/ month/)
  // One short line of what Pro gives (the card fits the panel as it opens on the smallest iPhone).
  assert.equal(card.el.querySelector(".cf-limit-pro-line").textContent, "Up to 375 answers a week")
  assert.equal(card.el.querySelectorAll(".cf-plan-lines li").length, 0)
  assert.equal(card.el.querySelector(".cf-limit-buy").textContent.trim(), "Get Pro — $6.99 a month")
  assert.equal(card.el.querySelector(".cf-limit-terms").textContent.replace(/\u00a0/g, " "), "Cancel anytime in the App Store.")
  assert.equal(card.el.querySelector(".cf-limit-more"), null)
  assert.doesNotMatch(card.text(), /\$59\.99|\$12\.99/)
  await click(card.el.querySelector(".cf-limit-buy"))
  assert.deepEqual(card.calls, [["choose", { plan: "pro", period: "monthly" }]])
  assert.deepEqual(card.events.at(-1), ["choose", { plan: "pro", period: "monthly" }])
  ui.clear(card.el)
})

test("with the offer: the button says the first month and goes to the code page; the line under it says it's a code", async () => {
  const card = mount({ offer: OFFER })
  await tick()
  // Said once, by the button: no second line about it in the box.
  assert.doesNotMatch(card.el.querySelector(".cf-offer-plan-card").textContent, /50/)
  assert.equal(card.el.querySelector(".cf-limit-buy").textContent.trim(), "Get Pro — first month 50% off")
  assert.equal(card.el.querySelector(".cf-limit-terms").textContent.replace(/\u00a0/g, " "), "Applied with a code in the App Store.")
  // One price in the box: no second, discounted price.
  assert.equal((card.el.querySelector(".cf-offer-plan-card").textContent.match(/\$/g) ?? []).length, 1)
  await click(card.el.querySelector(".cf-limit-buy"))
  assert.deepEqual(card.calls, [["redeem", "HALF"]])
  assert.deepEqual(card.events.at(-1), ["discount"])
  ui.clear(card.el)
})

test("More: yearly with its saving, Ultra, a note, the own key; each tap logged with from \"more\"", async () => {
  const card = mount({})
  await tick(150)
  await click(card.el.querySelector(".cf-limit-more-toggle"))
  assert.deepEqual(card.events.at(-1), ["more"])
  assert.equal(card.el.querySelector(".cf-limit-more-toggle").getAttribute("aria-expanded"), "true")
  const rows = [...card.el.querySelectorAll(".cf-limit-more li")] as any[]
  assert.deepEqual(rows.map((r) => r.querySelector("span").textContent.trim()), [
    "Yearly: $59.99 a year, save 28%",
    "Ultra: $12.99 a month, everything in Pro plus Listen and Find similar",
    "Notes stay free and unlimited",
    "Have an API key?"
  ])
  for (const row of rows) await click(row.querySelector("button"))
  assert.deepEqual(card.calls, [["choose", { plan: "pro", period: "yearly" }], ["choose", { plan: "ultra", period: "monthly" }], ["note"], ["own_key"]])
  assert.deepEqual(card.events.slice(-4), [
    ["choose", { plan: "pro", period: "yearly" }, "more"], ["choose", { plan: "ultra", period: "monthly" }, "more"], ["note", "more"], ["own_key", "more"]
  ])
  // Closing it isn't logged.
  await click(card.el.querySelector(".cf-limit-more-toggle"))
  assert.equal(card.el.querySelector(".cf-limit-more"), null)
  assert.deepEqual(card.events.at(-1), ["own_key", "more"])
  ui.clear(card.el)
})

test("no own key row where the panel has none; no prices yet: still one button, nothing made up", async () => {
  const card = mount({ ownKey: false, status: { plan: "free" } })
  await tick()
  assert.equal(card.el.querySelector(".cf-limit-buy").textContent.trim(), "Get Pro")
  assert.equal(card.el.querySelector(".cf-plan-price"), null)
  await click(card.el.querySelector(".cf-limit-more-toggle"))
  const rows = [...card.el.querySelectorAll(".cf-limit-more li span")].map((s: any) => s.textContent.trim())
  assert.deepEqual(rows, ["Yearly", "Ultra: everything in Pro plus Listen and Find similar", "Notes stay free and unlimited"])
  ui.clear(card.el)
})

test("Retry only once the answers are back", async () => {
  const out = mount({ retryAt: Date.now() + 3_600_000 })
  await tick()
  assert.ok(!out.buttons().some((b) => /Retry/.test(b.textContent)))
  ui.clear(out.el)
  const unknown = mount({ retryAt: "unknown" })
  await tick()
  assert.ok(!unknown.buttons().some((b) => /Retry/.test(b.textContent)))
  ui.clear(unknown.el)
  const back = mount({ retryAt: Date.now() - 1000 })
  await tick()
  const retry = back.buttons().find((b) => /Retry/.test(b.textContent))
  assert.ok(retry)
  await click(retry)
  assert.deepEqual(back.calls, [["retry"]])
  ui.clear(back.el)
})

test("the panel: free people get this card, a Pro subscriber keeps Ultra in their own period; events allowed", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /if \(!byok && !hasPro\(plan\)\) \{\s*const event = offerEvent\("limit"\)\s*return \(\s*<LimitCard/)
  assert.match(app, /A Pro subscriber: Ultra[\s\S]{0,400}if \(!byok && !isUltra\(plan\)\) \{[\s\S]{0,800}plans=\{\["ultra"\]\}/)
  assert.match(app, /\.\.\.\(from \? \{ from \} : \{\}\)/)
  // Its title and when-line, each one line on the smallest iPhone (the director on #263).
  assert.match(app, /<LimitCard[\s\S]{0,200}title=\{long \? t\("limitLongTitle"\) : t\("limitCardTitle"\)\}[\s\S]{0,500}answersBackShort\(clockTime\(resetsAt\), timeUntil\(resetsAt\)\) : t\("limitCardBackNow"\)\)/)
  const usage = read("src/shared/usage.ts")
  assert.match(usage, /chat_plans: \{[\s\S]*?"remind_app", "more", "offer_notify_on", "offer_notify_off", "later"\][\s\S]*?from: \["more"\], state: \["full", "discount"\]/)
  assert.match(read("src/content/ux/LimitCard.tsx"), /export const LIMIT_BUY: OfferChoice = \{ plan: "pro", period: "monthly" \}/)
})

test("15 languages: every string translated, placeholders kept, no «two taps» anywhere", () => {
  const keys = ["limitCardTitle", "limitCardBack", "limitCardBackNow", "limitProLine", "limitCancel", "limitBuyOffer", "limitBuyPrice", "answersBackAt", "limitMore", "moreYearly", "moreYearlySave", "moreUltra", "moreUltraNoPrice", "moreChoose", "moreNotes", "moreOwnKey", "moreOwnKeyLink"]
  const en = JSON.parse(read("src/locales/en.json"))
  const langs = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json"))
  assert.equal(langs.length, 15)
  for (const f of langs) {
    const d = JSON.parse(read(`src/locales/${f}`))
    for (const key of keys) {
      assert.ok(typeof d[key] === "string" && d[key].trim(), `${f} ${key}`)
      for (const slot of en[key].match(/\{\d\}/g) ?? []) assert.ok(d[key].includes(slot), `${f} ${key} ${slot}`)
      if (f !== "en.json" && !["limitMore"].includes(key)) assert.notEqual(d[key], en[key], `${f} ${key} untranslated`)
    }
    assert.match(d.limitCancel, /App Store/, f)
    for (const text of Object.values(d) as string[]) assert.doesNotMatch(text, /two taps|двух касани|два касани|zwei Tipp|deux touch/i, f)
  }
})
