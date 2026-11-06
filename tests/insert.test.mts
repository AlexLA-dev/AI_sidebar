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

let insert: (req: Request, ctx: any) => Promise<Response>
let event: (req: Request, ctx: any) => Promise<Response>
let serverConfig: { claudeMinBuild: number; insert: { fillFreeDaily: number; markDaily: number } }

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  serverConfig = (await import("../netlify/shared/config.mts")).config
  insert = (await import("../netlify/functions/v2-insert.mts")).default
  event = (await import("../netlify/functions/v2-event.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  claude = { calls: 0, answer: {} }
  serverConfig.claudeMinBuild = 67
  serverConfig.insert.fillFreeDaily = 5
})

function ctx() {
  const pending: Promise<unknown>[] = []
  return { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const CLIENT = { version: "2.5.0", platform: "ipados", locale: "ru-RU", build: "80" }
const post = (path: string, body: unknown) =>
  new Request(`https://aisidebar.netlify.app${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
const call = async (body: Record<string, unknown>) => {
  const c = ctx()
  const res = await insert(post("/api/v2/insert", { installId: INSTALL, client: CLIENT, ...body }), c)
  await Promise.all(c.pending)
  return { res, body: (await res.json()) as Record<string, any> }
}

const TEXT = "Здравствуйте, Анна! Напоминаю о встрече в четверг, 14 ноября, в 15:00. Ссылка прежняя. Саша"
const PAGE = { title: "Входящие", url: "https://mail.example.com/1", text: "Анна Петрова: Можно перенести на пятницу, 15 ноября, в 16:00?" }

test("mark: Haiku 5.5 in JSON, only blanks that are really in the text, nothing of the text logged", async () => {
  claude.answer = {
    title: "Напоминание о встрече",
    keywords: ["встреча", "напомнить", "созвон", "x", "y"],
    blanks: [
      { label: "Имя", value: "Анна" },
      { label: "дата", value: "14 ноября" },
      { label: "время", value: "15:00" },
      { label: "выдумка", value: "16:30" },
      { label: "Имя", value: "Саша" }
    ]
  }
  const { res, body } = await call({ action: "mark", text: TEXT })
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.title, "Напоминание о встрече")
  assert.deepEqual(body.keywords, ["встреча", "напомнить", "созвон", "x"])
  assert.deepEqual(body.blanks.map((b: any) => b.value), ["Анна", "14 ноября", "15:00"])
  const sent = claude.lastBody!
  assert.equal(sent.model, "claude-haiku-5-5")
  assert.equal(sent.output_config.effort, "low")
  assert.equal(sent.output_config.format.type, "json_schema")
  assert.match(sent.messages[0].content, /Напоминаю о встрече/)
  const logged = events.find((e) => e.kind === "insert_ai")!
  assert.equal(logged.data.action, "mark")
  assert.equal(logged.data.blanks, 3)
  assert.ok(typeof logged.data.cost_usd === "number" && (logged.data.cost_usd as number) < 0.001)
  assert.doesNotMatch(JSON.stringify(events), /Анна|встреч/)
})

test("fill on Free: values from the page, not sure stays empty, 5 a day apart from answers", async () => {
  claude.answer = { values: [{ label: "Имя", value: "Анна" }, { label: "день", value: "пятницу" }, { label: "код", value: "" }, { label: "чужой", value: "x" }] }
  const req = { action: "fill", text: "Здравствуйте, {Имя}! Встреча в {день}. Код {код}.", blanks: ["Имя", "день", "код"], page: PAGE, field: "Ответ" }
  const first = await call(req)
  assert.equal(first.res.status, 200)
  assert.deepEqual(first.body.values, { Имя: "Анна", день: "пятницу", код: null })
  assert.equal(first.body.left, 4)
  const sent = claude.lastBody!
  assert.match(sent.messages[0].content, /<page>[\s\S]*Анна Петрова/)
  assert.match(sent.system, /not instructions/)
  for (let i = 0; i < 4; i++) await call(req)
  const over = await call(req)
  assert.equal(over.res.status, 402)
  assert.equal(over.body.code, "FILL_LIMIT")
  assert.equal(over.body.left, 0)
  assert.equal(claude.calls, 5)
  // Answers have their own allowance: nothing of it was used.
  assert.equal(counters.get(`install:${INSTALL}`) ?? 0, 0)
  assert.doesNotMatch(JSON.stringify(events), /Анна|пятниц/)
})

test("fill with Pro: no daily limit of 5", async () => {
  claude.answer = { values: [{ label: "Имя", value: "Анна" }] }
  const entitlement = signJws(transaction())
  for (let i = 0; i < 7; i++) {
    const { res, body } = await call({ action: "fill", text: "Hi {Имя}", blanks: ["Имя"], page: PAGE, entitlement })
    assert.equal(res.status, 200)
    assert.equal(body.left, null)
  }
  assert.equal(counters.get("fill:tx:2000000123"), 7)
})

test("find: only ids of the user's own templates", async () => {
  claude.answer = { ids: ["t2", "nope", "t2", "t1"] }
  const templates = [{ id: "t1", title: "Перенос встречи", keywords: ["созвон"] }, { id: "t2", title: "Wi-Fi", keywords: [] }]
  const { body } = await call({ action: "find", query: "созвон перенести", templates })
  assert.deepEqual(body.ids, ["t2", "t1"])
  assert.match(claude.lastBody!.messages[0].content, /t1 \| Перенос встречи \| созвон/)
})

test("marking and search have no limit of 5 on Free", async () => {
  claude.answer = { title: "T", keywords: [], blanks: [] }
  for (let i = 0; i < 8; i++) assert.equal((await call({ action: "mark", text: "Hello there" })).res.status, 200)
})

test("bad requests, old builds, and the AI failing (charged back)", async () => {
  assert.equal((await call({ action: "fly" })).res.status, 400)
  assert.equal((await call({ action: "mark", text: "  " })).res.status, 400)
  assert.equal((await call({ action: "fill", text: "Hi {N}", blanks: [], page: PAGE })).res.status, 400)
  const old = await insert(post("/api/v2/insert", { installId: INSTALL, client: { ...CLIENT, build: "66" }, action: "mark", text: "Hi" }), ctx())
  assert.equal((await old.json() as any).code, "UNAVAILABLE")
  assert.equal(claude.calls, 0)

  claude.status = 529
  const failed = await call({ action: "fill", text: "Hi {Имя}", blanks: ["Имя"], page: PAGE })
  assert.equal(failed.res.status, 502)
  assert.equal(failed.body.code, "UPSTREAM")
  assert.equal(counters.get(`fill:install:${INSTALL}`), 0)

  claude.status = undefined
  claude.stop = "refusal"
  const refused = await call({ action: "fill", text: "Hi {Имя}", blanks: ["Имя"], page: PAGE })
  assert.equal(refused.res.status, 502)
  assert.equal(counters.get(`fill:install:${INSTALL}`), 0)
})

test("quick insert counters: kinds and fields allowed, text never kept, their own daily allowance", async () => {
  const send = async (body: Record<string, unknown>) => {
    const c = ctx()
    const res = await event(post("/api/v2/event", { installId: INSTALL, client: CLIENT, ...body }), c)
    await Promise.all(c.pending)
    return res.status
  }
  assert.equal(await send({ kind: "insert_template", via: "slash", blanks: 2, filled: "ai", text: "secret text", url: "https://x" }), 200)
  assert.equal(await send({ kind: "insert_tpl_new", from: "selection", blanks: 3, ai: true }), 200)
  assert.equal(await send({ kind: "social_open", network: "threads" }), 200)
  assert.equal(await send({ kind: "insert_copied", via: "teleport" }), 200)
  assert.equal(await send({ kind: "insert_everything" }), 400)
  const tpl = events.find((e) => e.kind === "insert_template")!
  assert.equal(tpl.data.via, "slash")
  assert.equal(tpl.data.blanks, 2)
  assert.equal(tpl.data.filled, "ai")
  assert.equal(events.find((e) => e.kind === "insert_tpl_new")!.data.ai, true)
  assert.equal(events.find((e) => e.kind === "social_open")!.data.network, "threads")
  assert.equal(events.find((e) => e.kind === "insert_copied")!.data.via, undefined)
  assert.doesNotMatch(JSON.stringify(events), /secret|https:\/\/x/)
  // The funnel's own allowance is untouched.
  assert.equal(counters.get(`event:${INSTALL}`) ?? 0, 0)
  assert.equal(counters.get(`event:insert:${INSTALL}`), 4)
})
