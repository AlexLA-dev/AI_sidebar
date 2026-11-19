import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"

type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let events: Array<{ kind: string; data: Record<string, unknown> }> = []
let claude: { calls: number; status?: number; errorType?: string; text: string; lastBody?: Record<string, any> } = { calls: 0, text: "" }
let nano: { calls: number; status?: number; text: string; lastBody?: Record<string, any> } = { calls: 0, text: "" }

const rpc: Record<string, (args: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) >= i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + 1))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: ({ p_items }) => {
    for (const i of p_items as Item[]) counters.set(i.subject, Math.max(0, (counters.get(i.subject) ?? 0) - 1))
    return null
  },
  cf_peek: ({ p_items }) => (p_items as Item[]).map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })),
  cf_touch_install: () => null,
  cf_limited_before: () => false,
  cf_log: ({ p_kind, p_data }) => {
    events.push({ kind: p_kind, data: p_data })
    return null
  },
  cf_entitlement_upsert: ({ p }) => p
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) return json(rpc[url.split("/rpc/")[1].split("?")[0]](body))
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    claude.calls++
    claude.lastBody = body
    if (claude.status) return json({ type: "error", error: { type: claude.errorType ?? "api_error", message: "failed" } }, claude.status)
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: claude.text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 60 } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    nano.calls++
    nano.lastBody = body
    if (nano.status) return new Response("busy", { status: nano.status })
    return json({ model: "gpt-5-nano", choices: [{ message: { content: nano.text } }], usage: { prompt_tokens: 800, completion_tokens: 200 } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let lib: typeof import("../netlify/shared/collect.mts")
let handler: (req: Request, ctx: any) => Promise<Response>
let config: typeof import("../netlify/shared/config.mts").config

before(async () => {
  ;(await import("../netlify/shared/apple.mts")).setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  config = (await import("../netlify/shared/config.mts")).config
  lib = await import("../netlify/shared/collect.mts")
  handler = (await import("../netlify/functions/v2-collect.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  claude = { calls: 0, text: "" }
  nano = { calls: 0, text: "" }
  config.anthropicKey = "sk-ant-test"
  Object.assign(config.collect, { enabled: true, placeDaily: 200, layoutDaily: 30, compareDaily: 40, summaryDaily: 40, globalDaily: 20_000 })
})

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const PRO = signJws(transaction())
const request = (body: Record<string, unknown>, raw?: string) => new Request("https://aisidebar.netlify.app/api/v2/collect", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: raw ?? JSON.stringify({ installId: INSTALL, client: { version: "2.7", platform: "ios", locale: "ru-RU" }, entitlement: PRO, ...body })
})

async function call(body: Record<string, unknown>, raw?: string) {
  const pending: Promise<unknown>[] = []
  const res = await handler(request(body, raw), { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  return { res, body: await res.json() }
}

const PLACE = {
  op: "place",
  card: { gist: "Ryokan in Hakone with an onsen, about ¥30,000 a night", text: "Hakone ryokans: Gora Kadan, Hakone Ginyu…", title: "Best ryokans", site: "japan-guide.com" },
  collections: [
    { id: "cf-col-1", name: "Trip to Japan", sections: [{ id: "s-hotels", name: "Hotels", cards: ["Hotel Gracery in Shinjuku"] }, { id: "s-flights", name: "Flights", cards: ["JAL from Helsinki"] }] },
    { id: "cf-col-2", name: "New laptop", sections: [{ id: "s-mac", name: "MacBooks", cards: [] }] }
  ]
}
const LAYOUT = {
  op: "layout",
  lang: "RU",
  cards: [{ id: "k1", gist: "Отель в Синдзюку" }, { id: "k2", gist: "Рёкан в Хаконэ" }, { id: "k3", gist: "Рейс JAL из Хельсинки" }, { id: "k4", gist: "Виза не нужна" }],
  sections: [{ id: "own1", name: "Жильё", own: true }, { id: "ai1", name: "Разное", own: false }, { id: "own2", name: "Мои заметки", own: true }]
}
const COMPARE = {
  op: "compare",
  lang: "en",
  cards: [
    { id: "a", gist: "MacBook Air 13 M5", text: "$1,099, 1.2 kg, 18 hours", site: "apple.com" },
    { id: "b", gist: "Dell XPS 13", text: "$999, 1.2 kg" },
    { id: "c", gist: "ThinkPad X1 Carbon", text: "$1,299" }
  ]
}
const SUMMARY = {
  op: "summary",
  lang: "en",
  sections: [{ name: "Hotels", cards: ["Ryokan in Hakone, ¥30,000", "Hotel Gracery in Shinjuku"] }, { name: "Flights", cards: ["JAL from Helsinki in late March"] }]
}

const placeAnswer = (a: Record<string, unknown>) => JSON.stringify({ collection: null, section: null, newSection: "", newCollection: "", ...a })

// ------------------------------------------------------------ the handler

test("malformed requests and unknown ops: BAD_REQUEST before anything is charged or sent", async () => {
  const bad: Array<Record<string, unknown>> = [
    { op: "nope" }, {}, { op: "place", collections: [] }, { op: "place", card: { gist: "  " }, collections: [] },
    { op: "layout", cards: [] }, { op: "compare", cards: [{ id: "a", gist: "x" }] }, { op: "summary", sections: [] },
    { ...PLACE, installId: "not-a-uuid" }
  ]
  for (const body of bad) assert.equal((await call(body)).res.status, 400, JSON.stringify(body).slice(0, 60))
  const notJson = await call({}, "{oops")
  assert.equal(notJson.res.status, 400)
  assert.equal(notJson.body.code, "BAD_REQUEST")
  assert.equal(claude.calls + nano.calls, 0)
  assert.equal(counters.size, 0)
})

test("only Pro: free and Own key get PRO_ONLY (feature collect) before anything is charged or sent", async () => {
  for (const entitlement of [null, signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "b2" }))]) {
    const { res, body } = await call({ ...PLACE, entitlement })
    assert.equal(res.status, 403)
    assert.equal(body.code, "PRO_ONLY")
    assert.equal(body.feature, "collect")
  }
  assert.equal(claude.calls + nano.calls, 0)
  assert.equal(counters.size, 0)
  assert.deepEqual(events.map((e) => [e.kind, e.data.feature, e.data.op]), [["pro_only", "collect", "place"], ["pro_only", "collect", "place"]])
})

test("place: Claude Haiku without thinking, numbers in the prompt, ids in the answer; counted per op; no text in the logs", async () => {
  claude.text = placeAnswer({ collection: 1, section: 2 })
  const { res, body } = await call(PLACE)
  assert.equal(res.status, 200)
  assert.deepEqual(body, { collection: "cf-col-1", section: "s-flights" })
  assert.equal(claude.lastBody?.model, "claude-haiku-5-5")
  assert.deepEqual(claude.lastBody?.thinking, { type: "disabled" })
  assert.equal(claude.lastBody?.output_config.format.type, "json_schema")
  assert.deepEqual(claude.lastBody?.output_config.format.schema.required, ["collection", "section", "newSection", "newCollection"])
  const prompt = claude.lastBody?.messages[0].content as string
  assert.match(prompt, /Collection 1: Trip to Japan\n  Section 1: Hotels\n    - Hotel Gracery in Shinjuku\n  Section 2: Flights/)
  assert.match(prompt, /Page: Best ryokans — japan-guide.com/)
  assert.ok(!prompt.includes("cf-col-1") && !prompt.includes("s-flights"), "ids never reach the model")
  assert.equal(counters.get("collect:place:tx:2000000123"), 1)
  assert.equal(counters.get("global:collect"), 1)
  const logged = events.find((e) => e.kind === "collect_api")!.data
  assert.equal(logged.op, "place")
  assert.equal(logged.picked, "section")
  assert.equal(logged.collections, 2)
  assert.equal(logged.sections, 3)
  assert.equal(logged.provider, "anthropic")
  assert.equal(logged.prompt_tokens, 900)
  assert.ok(typeof logged.cost_usd === "number" && logged.cost_usd > 0)
  assert.equal(logged.platform, "ios")
  assert.ok(!/Hakone|Japan|Hotels|japan-guide/.test(JSON.stringify(events)))
})

test("layout, compare and summary come back parsed for a Pro request, each counted under its own op", async () => {
  claude.text = '{"sections":[{"ref":1,"name":"Отели","cards":[1,2]},{"ref":null,"name":"Перелёт","cards":[3]},{"ref":2,"name":"Документы","cards":[4]}]}'
  let r = await call(LAYOUT)
  assert.equal(r.res.status, 200)
  assert.deepEqual(r.body, {
    sections: [{ id: "own1", name: "Жильё" }, { id: null, name: "Перелёт" }, { id: "ai1", name: "Документы" }, { id: "own2", name: "Мои заметки" }],
    cards: [{ id: "k1", section: 0 }, { id: "k2", section: 0 }, { id: "k3", section: 1 }, { id: "k4", section: 2 }]
  })
  assert.match(claude.lastBody?.messages[0].content, /1 \(own\): Жильё\n2 \(earlier\): Разное/)
  assert.match(claude.lastBody?.messages[0].content, /Write in Russian\./)
  assert.equal(counters.get("collect:layout:tx:2000000123"), 1)

  claude.text = '{"h":["Laptop","Price"],"rows":[{"card":3,"cells":["ThinkPad X1","$1,299"]},{"card":1,"cells":["MacBook Air","$1,099"]},{"card":2,"cells":["Dell XPS 13","$999"]}],"note":""}'
  r = await call(COMPARE)
  assert.deepEqual(r.body, { h: ["Laptop", "Price"], r: [["MacBook Air", "$1,099"], ["Dell XPS 13", "$999"], ["ThinkPad X1", "$1,299"]] })
  assert.match(claude.lastBody?.messages[0].content, /Card 1 \(apple.com\)\nGist: MacBook Air 13 M5\nText: \$1,099/)
  assert.equal(counters.get("collect:compare:tx:2000000123"), 1)

  claude.text = '{"text":"Book the Hakone ryokan first, then the JAL flight for late March."}'
  r = await call(SUMMARY)
  assert.deepEqual(r.body, { text: "Book the Hakone ryokan first, then the JAL flight for late March." })
  assert.match(claude.lastBody?.messages[0].content, /<collection>\nHotels:\n- Ryokan in Hakone, ¥30,000/)
  assert.equal(counters.get("collect:summary:tx:2000000123"), 1)
  assert.equal(counters.get("global:collect"), 3)

  const logged = events.filter((e) => e.kind === "collect_api").map((e) => e.data)
  assert.deepEqual(logged.map((d) => d.op), ["layout", "compare", "summary"])
  assert.deepEqual([logged[0].n, logged[0].own, logged[0].made, logged[0].added], [4, 2, 4, 1])
  assert.deepEqual([logged[1].n, logged[1].cols, logged[1].note], [3, 2, false])
  assert.deepEqual([logged[2].n, logged[2].sections], [3, 2])
  assert.ok(!/Хаконэ|Отели|MacBook|ryokan/i.test(JSON.stringify(events)))
})

test("daily limit per op, the switch, gpt-5-nano when Claude can't, and UPSTREAM (refunded) when no answer holds up", async () => {
  config.collect.placeDaily = 1
  claude.text = placeAnswer({ collection: 1, section: 1 })
  assert.equal((await call(PLACE)).res.status, 200)
  const limited = await call(PLACE)
  assert.equal(limited.res.status, 429)
  assert.equal(limited.body.code, "LIMIT_REACHED")
  // Another op has its own counter.
  claude.text = '{"text":"Book it."}'
  assert.equal((await call(SUMMARY)).res.status, 200)
  config.collect.placeDaily = 200

  config.collect.enabled = false
  const off = await call(PLACE)
  assert.equal(off.res.status, 503)
  assert.equal(off.body.code, "OFF")
  config.collect.enabled = true

  claude.status = 529
  claude.errorType = "overloaded_error"
  nano.text = placeAnswer({ newCollection: "Weekend in Hakone", newSection: "Ryokans" })
  const fallback = await call(PLACE)
  assert.deepEqual(fallback.body, { collection: null, section: null, newCollection: "Weekend in Hakone", newSection: "Ryokans" })
  assert.equal(nano.lastBody?.response_format.json_schema.name, "place")
  assert.equal(events.filter((e) => e.kind === "collect_api").at(-1)!.data.fallback, "overloaded")
  claude.status = undefined

  // A collection that wasn't sent, from both: no answer, and the request isn't charged.
  const before = counters.get("collect:place:tx:2000000123")
  claude.text = placeAnswer({ collection: 7, section: 1 })
  nano.text = placeAnswer({ collection: 1, section: 9 })
  const failed = await call(PLACE)
  assert.equal(failed.res.status, 502)
  assert.equal(failed.body.code, "UPSTREAM")
  assert.equal(counters.get("collect:place:tx:2000000123"), before)
  const err = events.find((e) => e.kind === "upstream_error")!.data
  assert.equal(err.mode, "collect_place")
  assert.equal(err.message, "unknown section")
})

// ------------------------------------------------------------ place

test("place input: clipped to its sizes, cut to 20 × 20 sections, fewer gists with many sections, junk dropped", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `c${i}`, name: `Collection ${i}`,
    sections: Array.from({ length: 25 }, (_, j) => ({ id: `s${j}`, name: `S${j}`, cards: ["one", "two", "three"] }))
  }))
  const check = lib.sanitizePlace({ card: { gist: ` a\n\n b ${"x".repeat(400)}`, text: "t".repeat(3_000), title: "T".repeat(300), site: "s".repeat(200) }, collections: many })!
  assert.equal(check.card.gist.length, 300)
  assert.ok(check.card.gist.startsWith("a b x"))
  assert.equal(check.card.text.length, 2_000)
  assert.equal(check.card.title.length, 200)
  assert.equal(check.card.site.length, 100)
  assert.equal(check.collections.length, 20)
  assert.ok(check.collections.every((c) => c.sections.length === 20))
  // 400 sections share 400 gists: one each.
  assert.ok(check.collections.every((c) => c.sections.every((s) => s.cards.length === 1)))

  const junk = lib.sanitizePlace({
    card: { gist: "g", text: 5 },
    collections: [
      null, "x", { id: "", name: "A" }, { id: "c0", name: "  " }, { id: "x".repeat(81), name: "A" },
      { id: "c1", name: "One", sections: [{ id: "s1", name: "S", cards: [...Array(10).fill("g".repeat(200))] }, { id: "s1", name: "dup" }, { name: "no id" }, "s"] },
      { id: "c1", name: "dup" }
    ]
  })!
  assert.equal(junk.card.text, "")
  assert.equal(junk.collections.length, 1)
  assert.equal(junk.collections[0].sections.length, 1)
  assert.equal(junk.collections[0].sections[0].cards.length, 8)
  assert.ok(junk.collections[0].sections[0].cards.every((g) => g.length === 160))

  assert.equal(lib.sanitizePlace({ card: { gist: "g" }, collections: [] })?.collections.length, 0)
  for (const bad of [{ collections: [] }, { card: "g", collections: [] }, { card: { gist: " " }, collections: [] }, { card: { gist: "g" } }, { card: { gist: "g" }, collections: {} }]) {
    assert.equal(lib.sanitizePlace(bad), null, JSON.stringify(bad))
  }
})

test("place answer: an existing section, a new section, a new collection; numbers that weren't sent throw", () => {
  const check = lib.sanitizePlace(PLACE)!
  assert.deepEqual(lib.readPlace(placeAnswer({ collection: 2, section: 1, newSection: "x", newCollection: "y" }), check), { collection: "cf-col-2", section: "s-mac" })
  assert.deepEqual(lib.readPlace(placeAnswer({ collection: 1, newSection: " Ryokans " }), check), { collection: "cf-col-1", section: null, newSection: "Ryokans" })
  // A "new" section the collection has is that section.
  assert.deepEqual(lib.readPlace(placeAnswer({ collection: 1, newSection: "hotels." }), check), { collection: "cf-col-1", section: "s-hotels" })
  assert.deepEqual(lib.readPlace(placeAnswer({ section: 3, newSection: "Ideas", newCollection: "«Weekend in Hakone»" }), check), { collection: null, section: null, newCollection: "Weekend in Hakone", newSection: "Ideas" })
  assert.deepEqual(lib.readPlace(placeAnswer({ newCollection: "N".repeat(90) }), check), { collection: null, section: null, newCollection: "N".repeat(60) })
  const bad: Array<[string, RegExp]> = [
    [placeAnswer({ collection: 3, section: 1 }), /unknown collection/],
    [placeAnswer({ collection: 0, section: 1 }), /unknown collection/],
    [placeAnswer({ collection: 1.5, section: 1 }), /unknown collection/],
    [placeAnswer({ collection: 1, section: 3 }), /unknown section/],
    [placeAnswer({ collection: 1 }), /no section/],
    [placeAnswer({}), /no collection/],
    ["not json", /not JSON/]
  ]
  for (const [text, error] of bad) assert.throws(() => lib.readPlace(text, check), error, text)
})

// ------------------------------------------------------------ layout

test("layout input: 1 to 120 cards with ids and gists, up to 20 sections; anything else is refused, not cut", () => {
  const check = lib.sanitizeLayout({ ...LAYOUT, cards: [{ id: "k1", gist: "g".repeat(400) }] })!
  assert.equal(check.cards[0].gist.length, 300)
  assert.equal(check.lang, "ru")
  assert.deepEqual(check.sections.map((s) => s.own), [true, false, true])
  assert.equal(lib.sanitizeLayout({ cards: [{ id: "k", gist: "g" }], lang: "russian" })?.lang, null)
  assert.deepEqual(lib.sanitizeLayout({ cards: [{ id: "k", gist: "g" }] })?.sections, [])
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, gist: "g" }))
  assert.equal(lib.sanitizeLayout({ cards: cards(120) })?.cards.length, 120)
  const bad = [
    { cards: [] }, { cards: cards(121) }, { cards: "x" },
    { cards: [{ id: "k", gist: "g" }, { id: "k", gist: "h" }] }, { cards: [{ id: "k", gist: " " }] }, { cards: [{ id: "x".repeat(81), gist: "g" }] }, { cards: [null] },
    { cards: cards(1), sections: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, name: "S" })) },
    { cards: cards(1), sections: [{ id: "s", name: "" }] }, { cards: cards(1), sections: [{ id: "s", name: "A" }, { id: "s", name: "B" }] }, { cards: cards(1), sections: {} }
  ]
  for (const body of bad) assert.equal(lib.sanitizeLayout(body), null, JSON.stringify(body).slice(0, 80))
})

test("layout answer: own sections keep their ids and names and always come back; same names join; every card exactly once", () => {
  const check = lib.sanitizeLayout(LAYOUT)!
  const answer = (sections: unknown[]) => JSON.stringify({ sections })
  // A new section named like an own one joins it; an earlier AI section left empty goes; the missing own one comes back.
  assert.deepEqual(lib.readLayout(answer([
    { ref: null, name: "жильё", cards: [1] }, { ref: 1, name: "", cards: [2] }, { ref: null, name: "Перелёт", cards: [3, 4] }, { ref: 2, name: "x", cards: [] }
  ]), check), {
    sections: [{ id: "own1", name: "Жильё" }, { id: null, name: "Перелёт" }, { id: "own2", name: "Мои заметки" }],
    cards: [{ id: "k1", section: 0 }, { id: "k2", section: 0 }, { id: "k3", section: 1 }, { id: "k4", section: 1 }]
  })
  // An earlier AI section may be renamed and keeps its id.
  assert.deepEqual(lib.readLayout(answer([{ ref: 2, name: "Документы", cards: [1, 2, 3, 4] }, { ref: 1, name: "", cards: [] }, { ref: 3, name: "", cards: [] }]), check).sections,
    [{ id: "ai1", name: "Документы" }, { id: "own1", name: "Жильё" }, { id: "own2", name: "Мои заметки" }])

  const all = { ref: null, name: "A", cards: [1, 2, 3] }
  const bad: Array<[unknown[], RegExp]> = [
    [[{ ...all, cards: [1, 2, 3, 5] }], /unknown card/],
    [[{ ...all, cards: [1, 2, 3, 4, 4] }], /card twice/],
    [[all], /card left out/],
    [[{ ...all, cards: [1, 2, 3, 4], ref: 4 }], /unknown section/],
    [[{ ...all, ref: 1 }, { ref: 1, name: "", cards: [4] }], /section twice/],
    [[{ ...all, cards: [1, 2, 3, 4], name: " " }], /no name/],
    [[{ ...all, cards: "1" }], /no cards/],
    [[], /no sections/]
  ]
  for (const [sections, error] of bad) assert.throws(() => lib.readLayout(answer(sections), check), error, JSON.stringify(sections))
  // More than 7 sections with cards (the person has 2 of their own here).
  const ten = lib.sanitizeLayout({ cards: Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, gist: "g" })) })!
  const eight = Array.from({ length: 8 }, (_, i) => ({ ref: null, name: `S${i}`, cards: i === 7 ? [8, 9, 10] : [i + 1] }))
  assert.throws(() => lib.readLayout(answer(eight), ten), /too many sections/)
  assert.equal(lib.readLayout(answer(eight.slice(0, 6).concat({ ref: null, name: "Rest", cards: [7, 8, 9, 10] })), ten).sections.length, 7)
})

// ------------------------------------------------------------ compare

test("compare input: 2 to 8 cards with ids and gists, texts clipped", () => {
  const check = lib.sanitizeCompare({ cards: [{ id: "a", gist: "A", text: "t".repeat(3_000), site: "s".repeat(150) }, { id: "b", gist: "B" }], lang: "EN" })!
  assert.equal(check.cards[0].text.length, 2_000)
  assert.equal(check.cards[0].site.length, 100)
  assert.equal(check.cards[1].text, "")
  assert.equal(check.lang, "en")
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, gist: "g" }))
  assert.equal(lib.sanitizeCompare({ cards: cards(8) })?.cards.length, 8)
  for (const body of [{ cards: cards(1) }, { cards: cards(9) }, { cards: [{ id: "a", gist: "g" }, { id: "a", gist: "h" }] }, { cards: [{ id: "a", gist: "g" }, { id: "b" }] }, { cards: [{ id: "a", gist: "g" }, 3] }]) {
    assert.equal(lib.sanitizeCompare(body), null, JSON.stringify(body))
  }
})

test("compare answer: rows in the cards' order, cells tidied and clipped; wrong rows or columns throw", () => {
  const check = lib.sanitizeCompare(COMPARE)!
  const table = (t: Record<string, unknown>) => JSON.stringify({ h: ["Laptop", "Price", "Weight"], note: "", ...t })
  const rows = [{ card: 2, cells: ["Dell XPS 13", "$999", "1.2 kg"] }, { card: 1, cells: ["MacBook Air", "$1,099", "**1.2  kg**"] }, { card: 3, cells: ["ThinkPad X1", "x".repeat(80), ""] }]
  const read = lib.readCompare(table({ rows, note: "Price decides:\nthe XPS is cheapest." }), check)
  assert.deepEqual(read.h, ["Laptop", "Price", "Weight"])
  assert.deepEqual(read.r, [["MacBook Air", "$1,099", "1.2 kg"], ["Dell XPS 13", "$999", "1.2 kg"], ["ThinkPad X1", `${"x".repeat(59)}…`, "—"]])
  assert.equal(read.note, "Price decides: the XPS is cheapest.")
  assert.equal("note" in lib.readCompare(table({ rows }), check), false)
  assert.equal(lib.readCompare(table({ rows, note: "n".repeat(200) }), check).note!.length, 160)
  const bad: Array<[string, RegExp]> = [
    [table({ rows: [rows[0], rows[1], { card: 3, cells: ["ThinkPad", "$1,299"] }] }), /row length/],
    [table({ rows: rows.slice(0, 2) }), /rows/],
    [table({ rows: [rows[0], rows[1], { ...rows[2], card: 4 }] }), /unknown card/],
    [table({ rows: [rows[0], rows[1], rows[1]] }), /card twice/],
    [table({ h: ["Laptop"], rows: rows.map((r) => ({ ...r, cells: r.cells.slice(0, 1) })) }), /columns/],
    [table({ h: ["A", "B", "C", "D", "E", "F"], rows }), /columns/],
    [table({ h: ["Laptop", " ", "Weight"], rows }), /empty column/]
  ]
  for (const [text, error] of bad) assert.throws(() => lib.readCompare(text, check), error, text.slice(0, 80))
})

// ------------------------------------------------------------ summary

test("summary input: up to 20 sections and the first 40 cards; sections without cards go", () => {
  const sections = Array.from({ length: 25 }, (_, i) => ({ name: `S${i}`, cards: ["a", "b", "c"] }))
  const check = lib.sanitizeSummary({ sections })!
  assert.equal(check.sections.reduce((n, s) => n + s.cards.length, 0), 40)
  assert.equal(check.sections.length, 14)
  assert.equal(check.sections[13].cards.length, 1)
  const junk = lib.sanitizeSummary({ sections: [null, { name: "Empty", cards: [] }, { name: "N".repeat(60), cards: ["g".repeat(400), 3, " "] }, { cards: ["x"] }] })!
  assert.deepEqual(junk.sections.map((s) => [s.name.length, s.cards.map((c) => c.length)]), [[40, [300]], [0, [1]]])
  for (const body of [{ sections: [] }, { sections: [{ name: "A", cards: [] }] }, { sections: "x" }, {}]) assert.equal(lib.sanitizeSummary(body), null, JSON.stringify(body))
})

test("summary answer: one plain paragraph of at most 400 characters; nothing is no answer", () => {
  assert.deepEqual(lib.readSummary('{"text":"## Plan\\n- **Book** the ryokan in Hakone *first*.\\n- Then `flights`."}'), { text: "Plan Book the ryokan in Hakone first. Then flights." })
  assert.equal(lib.readSummary('{"text":"\\"Book it.\\""}').text, "Book it.")
  assert.equal(lib.readSummary('{"text":"Stay at \\"Gora\\""}').text, 'Stay at "Gora"')
  const sentence = "Book the ryokan in Hakone before the cherry blossom crowds arrive in late March this year. "
  const long = lib.readSummary(JSON.stringify({ text: sentence.repeat(6) })).text
  assert.ok(long.length <= 400 && long.endsWith("year."), long)
  const words = lib.readSummary(JSON.stringify({ text: "word ".repeat(120) })).text
  assert.ok(words.length <= 400 && words.endsWith("word…"), words)
  for (const text of ['{"text":""}', '{"text":"   "}', "{}", "[]", "nope"]) assert.throws(() => lib.readSummary(text), text)
})
