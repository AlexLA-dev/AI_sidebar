// 2.8, the owner: «Я хочу чтобы пользователи сперва получали кнопку купить по полной цене и например если ушли - получили
// нотификацию о скидке. И при возвращении если даже нотификации не было». The first time at the free limit: full price
// only. The −50 % code on return (the server's earlier-day limit, and on this device at least 6 h after the full-price
// card). One notification may say it: the answers-back reminder, only for someone who opted in (App Review 4.5.4), with
// the opt-out in Settings; its tap opens the page with #cf-offer=1 and the panel on the discount.
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
const H = 3_600_000

let lib: any
let ui: any
let dom: any
const sent: any[] = []
const stored: Record<string, unknown> = {}
before(async () => {
  dom = parseHTML("<!doctype html><html><body></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element })
  ;(globalThis as any).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (message: any, reply: (r: unknown) => void) => {
        sent.push(message)
        reply(message?.type === "remind" ? { outcome: "scheduled" } : null)
      }
    },
    storage: { local: {
      get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
      remove: async (key: string) => void delete stored[key]
    } }
  }
  const dir = mkdtempSync(join(tmpdir(), "cf-offer-return-"))
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { AnswersBack } from ${JSON.stringify(join(root, "src/content/ux/AnswersBack.tsx"))}
    export * from ${JSON.stringify(join(root, "src/content/ux/offerReturn.ts"))}
    export function back(container: Element, props: unknown) { render(h(AnswersBack, props as never), container) }
    export function clear(container: Element) { render(null, container) }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [join(root, "node_modules")], loader: { ".css": "empty" }
  })
  lib = await import(pathToFileURL(out).href)
  ui = lib
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test("a return: the server's earlier-day limit, and 6 h since the full-price card here (23:50 isn't one 10 minutes later)", () => {
  const now = Date.UTC(2026, 10, 26, 0, 0)
  // Ran out at 23:50 UTC: at 00:00 the answers are back and the server says «earlier day», but it's 10 minutes on.
  assert.equal(lib.isReturn(true, now - 10 * 60_000, now), false)
  assert.equal(lib.isReturn(true, now - 6 * H, now), true)
  // Back within the hour, the same day: the server's day hasn't turned; full price again.
  assert.equal(lib.isReturn(false, now - 40 * 60_000, now), false)
  // No record on this device (another device, an older panel): the server's day alone.
  assert.equal(lib.isReturn(true, null, now), true)
  assert.equal(lib.isReturn(undefined, null, now), false)
  // A reminder carries the discount only when it fires on a return.
  assert.equal(lib.returnBy(now + 7 * H, now), true)
  assert.equal(lib.returnBy(now + 10 * 60_000, now), false)
})

test("the notification's mark: added to the page's address, taken off at once with the rest of the fragment kept", () => {
  assert.equal(lib.withOfferMark("https://example.com/a?b=1#top"), "https://example.com/a?b=1#cf-offer=1")
  const calls: string[] = []
  const where = (hash: string) => ({ location: { hash, pathname: "/a", search: "?b=1" }, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) } })
  assert.equal(lib.takeOfferMark(where("#cf-offer=1")), true)
  assert.equal(lib.takeOfferMark(where("#x=2&cf-offer=1")), true)
  assert.equal(lib.takeOfferMark(where("#top")), false)
  assert.equal(lib.takeOfferMark(where("#cf-offer=10")), false)
  assert.deepEqual(calls, ["/a?b=1", "/a?b=1#x=2"])
})

test("the reminder says the discount only for someone who opted in; the opt-in shows once it's set, and re-sets it", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  const at = Date.now() + 8 * H
  const events: unknown[][] = []
  const ons: boolean[] = []
  const props = (offerOn: boolean, offer: number | null = 50) => ({
    resetsAt: at, count: 5, url: "https://example.com/page", short: true, offer, offerOn,
    onOfferOn: (on: boolean) => ons.push(on), onEvent: (...a: unknown[]) => events.push(a)
  })
  sent.length = 0
  ui.back(el, props(false))
  await tick(20)
  // Before it's set: «Remind me at …» only, no opt-in yet.
  assert.equal(el.querySelector("input[type=checkbox]"), null)
  el.querySelector("button").dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  await tick(50)
  const first = sent.find((m) => m.type === "remind")
  assert.equal(first.url, "https://example.com/page")
  assert.equal(first.body, "Your 5 free answers are back. Ask about any page.")
  assert.deepEqual(events.at(-1), ["remind_set", "full"])
  // Set: the opt-in, unticked, in so many words.
  const box = el.querySelector("input[type=checkbox]")
  assert.ok(box)
  assert.ok(!box.checked, "unticked")
  assert.match(el.textContent, /Also tell me about a Pro discount in this reminder/)
  box.checked = true
  box.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  assert.deepEqual(ons, [true])
  // Opted in: the same reminder again (one per reset), with the discount and the page's mark.
  sent.length = 0
  ui.back(el, props(true))
  await tick(50)
  const again = sent.find((m) => m.type === "remind")
  assert.equal(again.chat, "cf-limit")
  assert.equal(again.message, "answers-back")
  assert.equal(again.url, "https://example.com/page#cf-offer=1")
  assert.equal(again.body, "Your 5 free answers are back. And if you'd like more, your first month of Pro is 50% off.")
  assert.deepEqual(events.at(-1), ["remind_set", "discount"])
  // Not on a return when it fires (offer null): no opt-in shown, nothing about a discount.
  ui.clear(el)
  const el2 = dom.document.createElement("div")
  stored["cf:answersBack"] = at
  ui.back(el2, props(true, null))
  await tick(30)
  assert.equal(el2.querySelector("input[type=checkbox]"), null)
  ui.clear(el2)
  delete stored["cf:answersBack"]
})

test("the panel: the code only on return everywhere it shows; full price noted; the reminder goes once bought", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const offer = offerGiven && fullAt !== undefined && isReturn\(status\?\.limitedBefore, fullAt\) \? offerGiven : null/)
  assert.match(app, /if \(!isReturn\(status\.limitedBefore, fullAt\) \|\| !status\.offer/)
  assert.match(app, /if \(action === "shown" && state === "full"\) void noteFullAt\(\)\.then\(setFullAt\)/)
  assert.match(app, /status\.plan === "free"[\s\S]{0,200}type: "remind", chat: "cf-limit", message: "answers-back", at: null/)
  assert.match(app, /offer=\{returnDiscount && fullAt !== undefined && returnBy\(Date\.parse\(resetsAt\), fullAt\) \? returnDiscount : null\}/)
  assert.match(app, /offerOn=\{settings\.offerNotify\}/)
  // The tap's mark opens the panel on the discount, counted.
  assert.match(app, /if \(!takeOfferMark\(\)\) return\s*void sendBackground\(\{ type: "useEvent", f: "notif", a: "panel", what: "offer" \}\)/)
  assert.match(app, /what: "offer" \}\)[\s\S]{0,300}setView\("chat"\)[\s\S]{0,120}if \(limitUpRef\.current\) return/)
  // The limit card says which state it was shown in.
  assert.match(read("src/content/ux/LimitCard.tsx"), /onEvent\("shown", LIMIT_BUY, undefined, offer \? "discount" : "full"\)/)
  // Off by default; the opt-out in Settings, for free people.
  assert.match(read("src/shared/types.ts"), /offerNotify: false\n\}/)
  assert.match(read("src/content/Settings.tsx"), /TARGET === "safari" && plan === "free" && \([\s\S]{0,300}t\("setOfferNotify"\)[\s\S]{0,200}onChange\(\{ offerNotify: on \}\)/)
  // The app counts the tap.
  for (const p of ["ContextFlow/iOS (App)/AppDelegate.swift", "ContextFlow/macOS (App)/AppDelegate.swift"]) {
    assert.match(read(p), /open\.contains\("cf-offer=1"\)[\s\S]{0,200}"f": "notif", "a": "tap", "what": "offer"/)
  }
  const usage = read("src/shared/usage.ts")
  assert.match(usage, /what: \["remind", "remind_page", "setup", "watch", "similar", "offer"\]/)
  assert.match(usage, /via: \["limit", "memory", "pro_only", "ultra_only", "return", "settings"\]/)
})

test("15 languages: the opt-in, the notification (no price, the two numbers) and Settings' switch", () => {
  const langs = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json"))
  assert.equal(langs.length, 15)
  const en = JSON.parse(read("src/locales/en.json"))
  for (const f of langs) {
    const d = JSON.parse(read(`src/locales/${f}`))
    for (const key of ["answersBackOfferAsk", "answersBackOfferBody", "setOfferNotify", "setOfferNotifyHint"]) {
      assert.ok(d[key]?.trim(), `${f} ${key}`)
      if (f !== "en.json") assert.notEqual(d[key], en[key], `${f} ${key} untranslated`)
    }
    assert.ok(d.answersBackOfferBody.includes("{0}") && d.answersBackOfferBody.includes("{1}"), f)
    // No price in the notification: no currency, no amount (ja's «1か月» is a month, not a price).
    assert.doesNotMatch(d.answersBackOfferBody.replace(/\{\d\}/g, ""), /[$€£¥₽]|\d[.,]\d|\d{2,}/, f)
    assert.match(d.answersBackOfferAsk, /Pro/, f)
  }
})
