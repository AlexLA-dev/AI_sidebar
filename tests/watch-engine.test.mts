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
  mod.startWatch({ installId: async () => "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01", clientInfo: async () => ({ version: "2.5.0", platform: "ios", build: "80" }), consented: async () => true })
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

test("a watch: planned once, read by the background, checked by the alarm, met once", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft() })
  assert.equal(prepared.readable, true)
  assert.equal(prepared.value, "129 EUR")
  assert.equal(prepared.local, false)
  const saved = await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  assert.equal(saved.ok, true)
  assert.equal(watches()[0].mode, "bg")
  assert.ok(alarms.has("cf-watch"), "the alarm is set")
  await tick()
  assert.ok(native.some((m) => m.command === "watch_sync"), "the app gets the list")
  assert.deepEqual(events.filter((e) => e.action === "set").map((e) => [e.kind, e.what, e.how, e.site, e.via]), [["ux_watch", "price", "bubble", "shop", "bg"]])

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
  assert.equal(notice.body, "Now: 89 EUR")
  assert.equal(notice.url, URL_A)
  assert.ok(watches()[0].metAt)
  assert.equal(aiCalls.filter((c) => c.action === "judge").length, 0, "a threshold needs no AI")
  assert.ok(events.some((e) => e.action === "met" && e.via === "bg"))
  const count = native.length
  pages[URL_A] = shop("79")
  await round()
  assert.equal(native.filter((m) => m.command === "watch_notify").length, 1, "met once")
  assert.ok(native.length >= count)
})

test("a site the background can't read: said so, counted, and checked on the open page", async () => {
  pages[URL_A] = "403 Access Denied"
  const prepared = await send({ type: "watchPrepare", draft: draft() })
  assert.equal(prepared.readable, false)
  await tick()
  assert.ok(events.some((e) => e.action === "unreadable" && e.site === "shop"))
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
  assert.ok(events.some((e) => e.action === "met" && e.via === "live"))
})

test("the person's own words: the AI reads them only after a change", async () => {
  plan = { what: "stock", source: "ld-stock", rule: { kind: "ask" }, label: "Size 42", site: "shop" }
  pages[URL_A] = shop("129", "OutOfStock")
  const d = draft({ selection: "Sold out", what: "stock", condition: "when size 42 is back", value: "Sold out" })
  const prepared = await send({ type: "watchPrepare", draft: d })
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
  const prepared = await send({ type: "watchPrepare", draft: draft() })
  assert.equal(prepared.local, true)
  assert.deepEqual(prepared.rule, { kind: "below", n: 100 })
  plan = { what: "status", source: "text", rule: { kind: "ask" }, label: "Visa", site: "gov" }
  const d = draft({ url: "https://gov.example/case", selection: "Pending", what: "status", condition: "when it's approved", before: "Status: ", after: " Updated", value: "Pending" })
  pages["https://gov.example/case"] = "<body>Case Status: Pending Updated today</body>"
  const p2 = await send({ type: "watchPrepare", draft: d })
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
  const prepared = await send({ type: "watchPrepare", draft: draft() })
  const saved = await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  alarms.clear()
  nativeReply = { watch_sync: { cancelled: [saved.id] } }
  startup!()
  for (let i = 0; i < 20; i++) await tick()
  assert.ok(!watches().some((w) => w.id === saved.id), "stopped in the app")
  assert.ok(events.some((e) => e.action === "cancelled"))
  // With a watch left, the alarm is back.
  nativeReply = {}
  await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })
  alarms.clear()
  startup!()
  for (let i = 0; i < 20; i++) await tick()
  assert.ok(alarms.has("cf-watch"))
})

test("at most 20 watches checking at once", async () => {
  const prepared = await send({ type: "watchPrepare", draft: draft() })
  for (let i = 0; i < 20; i++) assert.equal((await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false })).ok, true)
  assert.deepEqual(await send({ type: "watchSave", draft: draft(), prepared, how: "bubble", live: false }), { ok: false, full: true })
})
