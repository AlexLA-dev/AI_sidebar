// Page watch's background engine end to end, on stand-ins for Safari's extension APIs: making a watch,
// checks by the alarm, a change that isn't it, one that is (the notification), a site the background can't
// read, the open page's read, the AI asked only after a change, and the alarm set again when Safari starts.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

// ---- Safari's APIs, in memory ----------------------------------------------------------------
let store: Record<string, unknown> = {}
const listeners: Array<(m: any, s: unknown, r: (x: unknown) => void) => boolean | void> = []
let alarmFire: ((a: { name: string }) => void) | null = null
let startup: (() => void) | null = null
let alarms = new Map<string, unknown>()
let native: Array<Record<string, any>> = []
let nativeReply: Record<string, unknown> = {}

;(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (o: Record<string, unknown>) => { Object.assign(store, structuredClone(o)) }
    }
  },
  runtime: {
    onMessage: { addListener: (f: any) => listeners.push(f) },
    onStartup: { addListener: (f: any) => (startup = f) },
    onInstalled: { addListener: () => undefined }
  },
  alarms: {
    create: (name: string, info: unknown) => alarms.set(name, info),
    get: async (name: string) => alarms.get(name),
    clear: async (name: string) => alarms.delete(name),
    onAlarm: { addListener: (f: any) => (alarmFire = f) }
  },
  i18n: { getMessage: () => "", getUILanguage: () => "en" }
}
;(globalThis as any).browser = {
  runtime: {
    sendNativeMessage: async (_id: string, msg: Record<string, any>) => {
      native.push(msg)
      return { success: true, data: nativeReply[msg.command] ?? {} }
    }
  }
}

// ---- the network: shop pages, the watch API, the counters --------------------------------------
let pages: Record<string, string> = {}
let plan: Record<string, unknown> | null = null
let judge: Record<string, unknown> | null = null
let aiCalls: Array<Record<string, any>> = []
let events: Array<Record<string, any>> = []
let tier: "free" | "pro" | "byok" | "ultra" = "free"

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url === "https://api.test/api/v2/watch") {
    const body = JSON.parse(String(init!.body))
    aiCalls.push(body)
    const answer = body.action === "plan" ? plan : judge
    return answer ? new Response(JSON.stringify({ ok: true, ...answer })) : new Response(JSON.stringify({ code: "UPSTREAM" }), { status: 502 })
  }
  if (url === "https://api.test/api/v2/event") {
    events.push(JSON.parse(String(init!.body)))
    return new Response("{}")
  }
  if (url in pages) return new Response(pages[url], { status: pages[url].startsWith("403") ? 403 : 200 })
  return new Response("not found", { status: 404 })
}) as typeof fetch

const shop = (price: string, stock = "InStock") => `<html><head><title>Mug</title>
<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"${price}","priceCurrency":"EUR","availability":"https://schema.org/${stock}"}}</script>
</head><body><h1>Mug</h1><p>Price <b>${price} €</b></p></body></html>`

const URL_A = "https://shop.example/mug"
const draft = (over: Record<string, unknown> = {}) => ({
  url: URL_A, title: "Mug", selection: "129 €", what: "price", condition: "when it drops below 100",
  around: "Mug Price 129 € Add to cart", before: "Mug Price ", after: "", candidates: { ldPrice: "129 EUR", ldStock: "InStock" },
  value: "129 €", ...over
})

const send = (message: Record<string, unknown>) =>
  new Promise<any>((resolve) => {
    for (const f of listeners) if (f(message, {}, resolve) === true) return
    resolve(undefined)
  })
const tick = () => new Promise((r) => setTimeout(r, 30))
const watches = () => (store["cf:watches"] as any[]) ?? []
const ageAll = () => { for (const w of watches()) w.checkedAt -= 16 * 60_000 }
const round = async () => {
  ageAll()
  alarmFire!({ name: "cf-watch" })
  for (let i = 0; i < 20; i++) await tick()
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-watch-"))
  const out = join(dir, "watch.mjs")
  await build({
    entryPoints: [new URL("../src/background/watch.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  const mod = await import(pathToFileURL(out).href)
  mod.startWatch({ installId: async () => "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01", clientInfo: async () => ({ version: "2.5.0", platform: "ios", build: "80" }), consented: async () => true, plan: async () => tier })
})

beforeEach(() => {
  store = {}
  alarms = new Map()
  native = []
  nativeReply = {}
  pages = { [URL_A]: shop("129") }
  plan = { what: "price", source: "ld-price", rule: { kind: "below", n: 100 }, label: "Mug price", site: "shop" }
  judge = null
  aiCalls = []
  events = []
})

// 2.6.1, filmed for X: the system's question about notifications came in the middle of the first Watch (the window
// said "Looking at the page…"). Saving only reads whether they're allowed; the question has its own message, sent when
// the person taps "Turn on notifications" under the set watch.
test("a watch is saved without the system's question; it's asked on its own message", async () => {
  nativeReply = { watch_permission: { outcome: "not-asked" } }
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  const saved = await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  assert.equal(saved.ok, true)
  assert.equal(saved.notify, "not-asked")
  assert.deepEqual(native.filter((m) => m.command === "watch_permission").map((m) => m.ask), [false])
  nativeReply = { watch_permission: { outcome: "ok" } }
  assert.deepEqual(await send({ type: "watchNotifyAsk" }), { notify: "ok" })
  assert.deepEqual(native.filter((m) => m.command === "watch_permission").map((m) => m.ask), [false, true])
})

test("a watch: planned once, read by the background, checked by the alarm, met once", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  assert.equal(prepared.readable, true)
  assert.equal(prepared.value, "129 EUR")
  assert.equal(prepared.local, false)
  const saved = await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  assert.equal(saved.ok, true)
  assert.equal(watches()[0].mode, "bg")
  assert.ok(alarms.has("cf-watch"), "the alarm is set")
  await tick()
  assert.ok(native.some((m) => m.command === "watch_sync"), "the app gets the list")
  // The analytics registry's step: "use", f "watch" (no address, no text, no value).
  assert.deepEqual(events.filter((e) => e.a === "create").map((e) => [e.kind, e.f, e.via, e.what, e.site, e.mode]), [["use", "watch", "bubble", "price", "shop", "bg"]])
  assert.ok(!JSON.stringify(events).includes("shop.example") && !JSON.stringify(events).includes("129"))

  // Same price: nothing but the time of the check.
  await round()
  assert.equal(watches()[0].value, "129 EUR")
  assert.equal(watches()[0].checks, 1)

  // Down, but not below 100: no notification, the new price is remembered.
  pages[URL_A] = shop("119")
  await round()
  assert.equal(watches()[0].value, "119 EUR")
  assert.ok(!native.some((m) => m.command === "watch_notify"))

  // Below 100: the notification, and the checks stop.
  pages[URL_A] = shop("89")
  await round()
  const notice = native.find((m) => m.command === "watch_notify")!
  assert.equal(notice.title, "Changed: Mug price")
  // A price from the markup reads as the person's currency format, not "89 EUR".
  assert.equal(notice.body, "Now: €89.00")
  assert.equal(notice.url, URL_A)
  assert.ok(watches()[0].metAt)
  assert.equal(aiCalls.filter((c) => c.action === "judge").length, 0, "a threshold needs no AI")
  assert.ok(events.some((e) => e.f === "watch" && e.a === "alert" && e.mode === "bg"))
  const count = native.length
  pages[URL_A] = shop("79")
  await round()
  assert.equal(native.filter((m) => m.command === "watch_notify").length, 1, "met once")
  assert.ok(native.length >= count)
})

test("a site the background can't read: said so, counted, and checked on the open page", async () => {
  pages[URL_A] = "403 Access Denied"
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  assert.equal(prepared.readable, false)
  await tick()
  assert.ok(events.some((e) => e.a === "error" && e.reason === "blocked" && e.via === "bubble" && e.site === "shop"))
  await send({ type: "watchSave", draft: draft(), prepared, how: "later", live: true })
  assert.equal(watches()[0].mode, "live")
  // The background leaves it alone…
  await round()
  assert.equal(watches()[0].checks, 0)
  // …the open page reads it.
  const specs = await send({ type: "watchForUrl", url: `${URL_A}#reviews` })
  assert.equal(specs.length, 1)
  await send({ type: "watchLive", url: URL_A, values: { [specs[0].id]: "95 €" } })
  assert.ok(native.some((m) => m.command === "watch_notify" && m.body === "Now: 95 €"))
  assert.ok(events.some((e) => e.a === "alert" && e.mode === "live"))
})

test("the person's own words: the AI reads them only after a change", async () => {
  plan = { what: "stock", source: "ld-stock", rule: { kind: "ask" }, label: "Size 42", site: "shop" }
  pages[URL_A] = shop("129", "OutOfStock")
  const d = draft({ selection: "Sold out", what: "stock", condition: "when size 42 is back", value: "Sold out" })
  const prepared = await send({ type: "watchPrepare", draft: d, how: "later" })
  await send({ type: "watchSave", draft: d, prepared, how: "later", live: false })
  await round()
  assert.equal(aiCalls.filter((c) => c.action === "judge").length, 0, "nothing changed, nothing asked")
  judge = { met: true, line: "Size 42 is back in stock" }
  pages[URL_A] = shop("129", "InStock")
  await round()
  const asked = aiCalls.filter((c) => c.action === "judge")
  assert.equal(asked.length, 1)
  assert.equal(asked[0].before, "OutOfStock")
  assert.equal(asked[0].now, "InStock")
  assert.equal(native.find((m) => m.command === "watch_notify")!.body, "Size 42 is back in stock")
})

test("no AI reachable: the device's own rules plan it; an unanswered judge asks again next time", async () => {
  plan = null
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  assert.equal(prepared.local, true)
  assert.deepEqual(prepared.rule, { kind: "below", n: 100 })
  plan = { what: "status", source: "text", rule: { kind: "ask" }, label: "Visa", site: "gov" }
  const d = draft({ url: "https://gov.example/case", selection: "Pending", what: "status", condition: "when it's approved", before: "Status: ", after: " Updated", value: "Pending" })
  pages["https://gov.example/case"] = "<body>Case Status: Pending Updated today</body>"
  const p2 = await send({ type: "watchPrepare", draft: d, how: "later" })
  assert.equal(p2.readable, true)
  await send({ type: "watchSave", draft: d, prepared: p2, how: "bubble", live: false })
  pages["https://gov.example/case"] = "<body>Case Status: Approved Updated today</body>"
  await round()
  const w = watches().find((x) => x.what === "status")
  assert.equal(w.value, "Pending", "no answer: the old value stays")
  judge = { met: true, line: "Your case was approved" }
  await round()
  assert.equal(watches().find((x) => x.what === "status").value, "Approved")
  assert.ok(native.some((m) => m.command === "watch_notify" && m.body === "Your case was approved"))
})

test("stopped in the app: gone here on the next exchange; Safari's start sets the alarm again", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  const saved = await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  alarms.clear()
  nativeReply = { watch_sync: { cancelled: [saved.id] } }
  startup!()
  for (let i = 0; i < 20; i++) await tick()
  assert.ok(!watches().some((w) => w.id === saved.id), "stopped in the app")
  assert.ok(events.some((e) => e.a === "stop" && e.via === "app"))
  // With a watch left, the alarm is back.
  nativeReply = {}
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  alarms.clear()
  startup!()
  for (let i = 0; i < 20; i++) await tick()
  assert.ok(alarms.has("cf-watch"))
})

test("the owner's limit: 5 watches at once on Free, 20 on Pro, 50 on Ultra", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  const save = () => send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  for (let i = 0; i < 5; i++) assert.equal((await save()).ok, true)
  assert.deepEqual(await save(), { ok: false, full: true, limit: 5, paid: false, plan: "free" })
  tier = "pro"
  for (let i = 0; i < 15; i++) assert.equal((await save()).ok, true)
  assert.deepEqual(await save(), { ok: false, full: true, limit: 20, paid: true, plan: "pro" })
  tier = "ultra"
  for (let i = 0; i < 30; i++) assert.equal((await save()).ok, true)
  assert.deepEqual(await save(), { ok: false, full: true, limit: 50, paid: true, plan: "ultra" })
  tier = "free"
})

test("once a day: how many checks and how many watches were checking, by mode", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  await round()
  await round()
  const tally = store["cf:watchTally"] as { day: string; bg: number }
  assert.equal(tally.bg, 2)
  // The next day's first round sends yesterday's count.
  store["cf:watchTally"] = { ...tally, day: "2026-01-01" }
  await round()
  const daily = events.filter((e) => e.a === "daily")
  assert.deepEqual(daily.map((e) => [e.mode, e.checks, e.active]), [["bg", 2, 1]])
})

test("a page that's gone is told apart from one that turns the background away", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  delete pages[URL_A]
  for (let i = 0; i < 3; i++) await round()
  assert.equal(watches()[0].mode, "live")
  assert.ok(events.some((e) => e.a === "error" && e.reason === "gone" && e.mode === "bg"))
})

// 2.6 (97), the owner: «мне некуда приписать себе заметку, что именно я хочу проверить». A watch keeps the person's own
// note: the AI never gets it, the notification says it first, the app's list gets it, and it changes alone (no AI).
test("a watch's own note: kept, said first when it changes, in the app's list, changed alone without the AI", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false, note: "  ask   for the blue one \n " })
  assert.equal(watches()[0].note, "ask for the blue one")
  assert.ok(!JSON.stringify(aiCalls).includes("blue one"), "the AI never reads it")
  await tick()
  const sync = native.filter((m) => m.command === "watch_sync").at(-1)!
  assert.equal(sync.watches[0].note, "ask for the blue one")

  // The note alone: no AI, the rule as it was.
  const calls = aiCalls.length
  const rule = watches()[0].rule
  const edited = await send({ type: "watchEdit", id: watches()[0].id, condition: watches()[0].condition, note: "only if it ships this week" })
  assert.equal(edited.ok, true)
  assert.equal(watches()[0].note, "only if it ships this week")
  assert.deepEqual(watches()[0].rule, rule)
  assert.equal(aiCalls.length, calls, "a new note goes nowhere")

  pages[URL_A] = shop("89")
  await round()
  const notice = native.find((m) => m.command === "watch_notify")!
  assert.equal(notice.body, "only if it ships this week\nNow: €89.00")

  // Cleared: the notification says what changed alone again; no note in the list.
  await send({ type: "watchEdit", id: watches()[0].id, condition: watches()[0].condition, note: "" })
  assert.equal(watches()[0].note, undefined)
})

test("a watch without a note says what changed, as before; new words keep the note unless it's changed too", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft(), how: "bubble" })
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  assert.equal("note" in watches()[0], false)
  await send({ type: "watchEdit", id: watches()[0].id, condition: "when it drops below 90" })
  assert.equal(aiCalls.filter((c) => c.action === "plan").length, 2, "new words are planned again")
  assert.equal("note" in watches()[0], false)
  await send({ type: "watchEdit", id: watches()[0].id, condition: "when it drops below 80", note: "for the office" })
  assert.equal(watches()[0].condition, "when it drops below 80")
  assert.equal(watches()[0].note, "for the office")
})
