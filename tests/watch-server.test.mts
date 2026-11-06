import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "sk-ant-test"

// ---- in-memory stand-in for the cf_* RPCs --------------------------------
type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let events: { kind: string; install?: string | null; data: Record<string, unknown> }[] = []
const rpc: Record<string, (a: any) => unknown> = {
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
  cf_log: ({ p_kind, p_install_id, p_data }) => {
    events.push({ kind: p_kind, install: p_install_id, data: p_data })
    return null
  },
  cf_touch_install: () => null,
  cf_entitlement_upsert: ({ p }) => ({ ...p, revoked_at: null }),
  cf_entitlement_get: () => null
}

// ---- the Claude API: a JSON answer (structured output), an error, or a refusal --------
let claude: { calls: number; answer: unknown; status?: number; stop?: string; lastBody?: Record<string, any> } = { calls: 0, answer: {} }

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (!rpc[fn]) return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    claude.calls++
    claude.lastBody = body
    if (claude.status) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: claude.status, headers: { "Content-Type": "application/json" } })
    const message = {
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(claude.answer) }],
      stop_reason: claude.stop ?? "end_turn", stop_sequence: null,
      ...(claude.stop === "refusal" ? { stop_details: { type: "refusal", category: "general_harms", explanation: "declined" } } : {}),
      usage: { input_tokens: 3000, output_tokens: 80 }
    }
    return new Response(JSON.stringify(message), { headers: { "Content-Type": "application/json" } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let watch: (req: Request, ctx: any) => Promise<Response>
let serverConfig: { claudeMinBuild: number; watch: { judgeDaily: number } }

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  serverConfig = (await import("../netlify/shared/config.mts")).config
  watch = (await import("../netlify/functions/v2-watch.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  claude = { calls: 0, answer: {} }
  serverConfig.claudeMinBuild = 67
  serverConfig.watch.judgeDaily = 30
})

function ctx() {
  const pending: Promise<unknown>[] = []
  return { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const CLIENT = { version: "2.5.0", platform: "ios", locale: "ru-RU", build: "80" }
const post = (body: unknown) =>
  new Request("https://aisidebar.netlify.app/api/v2/watch", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
const call = async (body: Record<string, unknown>) => {
  const c = ctx()
  const res = await watch(post({ installId: INSTALL, client: CLIENT, ...body }), c)
  await Promise.all(c.pending)
  return { res, body: (await res.json()) as Record<string, any> }
}

const PLAN = {
  action: "plan", condition: "когда появится 42-й размер", selection: "Размер 42: нет в наличии",
  around: "Размер 41: в наличии Размер 42: нет в наличии Размер 43: в наличии", title: "Кроссовки", host: "shop.example",
  candidates: { "ld-price": "120 EUR", "ld-stock": "InStock", "bogus": "x" }
}

test("plan: Haiku 5.5 in JSON, a source the page offered, a rule the device can apply; no page text logged", async () => {
  claude.answer = { what: "stock", source: "text", rule: { kind: "contains", words: ["в наличии"] }, label: "42-й размер", site: "shop" }
  const { res, body } = await call(PLAN)
  assert.equal(res.status, 200)
  assert.deepEqual(body, { ok: true, what: "stock", source: "text", rule: { kind: "contains", words: ["в наличии"] }, label: "42-й размер", site: "shop" })
  const sent = claude.lastBody!
  assert.equal(sent.model, "claude-haiku-5-5")
  assert.equal(sent.output_config.format.type, "json_schema")
  const prompt = JSON.stringify(sent.messages)
  assert.ok(prompt.includes("42-й размер") && prompt.includes("ld-price: 120 EUR") && !prompt.includes("bogus"))
  const log = events.find((e) => e.kind === "watch_ai")!
  assert.equal(log.data.action, "plan")
  assert.equal(log.data.site, "shop")
  assert.ok(!JSON.stringify(log.data).includes("размер"), "no text of the page or the condition in the logs")
})

test("plan: a source the page didn't offer becomes the text; a threshold without a number becomes ask", async () => {
  claude.answer = { what: "price", source: "meta-price", rule: { kind: "below" }, label: "Цена", site: "shop" }
  const { body } = await call(PLAN)
  assert.equal(body.source, "text")
  assert.equal(body.rule.kind, "ask")
  claude.answer = { what: "page", source: "ld-price", rule: { kind: "change" }, label: "Страница", site: "news" }
  const page = await call({ ...PLAN, selection: "" })
  assert.equal(page.body.source, "page")
})

test("judge: met and a line for the notification", async () => {
  claude.answer = { met: true, line: "42-й размер снова в наличии" }
  const { res, body } = await call({ action: "judge", condition: "когда появится 42-й размер", label: "42-й размер", what: "stock", before: "нет в наличии", now: "в наличии", title: "Кроссовки", host: "shop.example" })
  assert.equal(res.status, 200)
  assert.deepEqual(body, { ok: true, met: true, line: "42-й размер снова в наличии" })
  assert.deepEqual(events.find((e) => e.kind === "watch_ai")!.data.met, true)
})

test("judge: the daily safety cap answers BUSY, not an error the user sees as a failure", async () => {
  serverConfig.watch.judgeDaily = 1
  claude.answer = { met: false, line: "" }
  const judge = { action: "judge", condition: "", label: "Цена", what: "price", before: "129 €", now: "119 €", title: "", host: "shop.example" }
  assert.equal((await call(judge)).res.status, 200)
  const second = await call(judge)
  assert.equal(second.res.status, 503)
  assert.equal(second.body.code, "BUSY")
  assert.equal(claude.calls, 1)
})

test("bad requests and old builds are turned away before anything is charged", async () => {
  assert.equal((await call({ action: "nope" })).res.status, 400)
  assert.equal((await call({ action: "plan", selection: "", condition: "" })).res.status, 400)
  assert.equal((await call({ action: "judge", now: "" })).res.status, 400)
  const old = await watch(post({ installId: INSTALL, client: { ...CLIENT, build: "60" }, ...PLAN }), ctx())
  assert.equal(old.status, 400)
  assert.equal(claude.calls, 0)
})

test("an upstream failure gives the day's count back", async () => {
  claude.status = 529
  const { res } = await call(PLAN)
  assert.equal(res.status, 502)
  assert.equal(counters.get(`watch:plan:${INSTALL}`) ?? 0, 0)
})
