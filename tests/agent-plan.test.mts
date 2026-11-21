// The task's plan (2.7.1, the owner: «крайне не хотелось бы, чтобы агент на каждом шаге спрашивал решение»): one card
// before the first step, then the task goes alone; what wasn't foreseen still stops; paying never goes in a plan.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { answer, approvePlan, drive, newState, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import { amounts, buildPlan, checkPlan, covered, personWords, planNeedsPerson, priceChanged } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const BOOK: PageMap = {
  url: "https://table.example.com/book", title: "Book", lang: "en", more: 0, part: 1, parts: 1,
  text: "Dinner menu from 45,00 € per person",
  forms: [{ n: 0, fillable: true }],
  items: [
    { id: "1", role: "textbox", label: "Name", lock: "personal", form: 0, state: ["empty"] },
    { id: "2", role: "textbox", label: "Phone", lock: "personal", form: 0, state: ["empty"] },
    { id: "3", role: "textbox", label: "Date", type: "date", form: 0 },
    { id: "4", role: "checkbox", label: "I agree to the terms of service", form: 0 },
    { id: "5", role: "button", label: "Book a table", type: "submit", form: 0 },
    { id: "6", role: "button", label: "Pay now", form: 0 },
    { id: "7", role: "link", label: "Partner site", href: "other.example.org/x" }
  ]
}
const ctx = { map: BOOK, startHost: "table.example.com", request: "Book for Anna Petrova, +44 20 7946 0000", confirmedHere: false, policy: { amazon: true } }
const RAW = {
  steps: ["Filling in your name and phone", "Booking the table"],
  questions: [{ q: "What time?", options: ["19:00", "19:30", "20:00"] }],
  risky: [
    { tool: "type", id: "1", text: "Anna Petrova", key: "" },
    { tool: "type", id: "2", text: "+44 20 7946 0000", key: "" },
    { tool: "click", id: "4", text: "", key: "" },
    { tool: "click", id: "5", text: "", key: "" },
    { tool: "click", id: "6", text: "", key: "" },
    { tool: "click", id: "", text: "Confirm booking", key: "" },
    { tool: "event_add", id: "", text: "Dinner", key: "" }
  ],
  prices: ["45,00 €"]
}

test("the plan's permissions are code's: a «Сделать?» step is one, paying is the person's, foreseen buttons by their words", () => {
  const plan = buildPlan(checkPlan(RAW), ctx)
  const kinds = plan.perms.map((p) => `${p.kind}:${p.label}`)
  assert.ok(kinds.includes("press:Book a table"))
  assert.ok(kinds.includes("press:Confirm booking"), "a button on the next page, by its words")
  assert.ok(kinds.includes("consent:I agree to the terms of service"))
  assert.ok(kinds.includes("apple:Dinner"))
  assert.ok(kinds.includes("personal:Name, Phone"), "the personal fields in one permission")
  assert.deepEqual(plan.self.map((x) => x.reason), ["pay"], "paying is never a permission")
  assert.ok(plan.perms.every((p) => p.on))
  assert.equal(planNeedsPerson(plan), true)
  assert.equal(planNeedsPerson(buildPlan(checkPlan({ steps: ["Reading"], questions: [], risky: [], prices: [] }), ctx)), false)
})

test("the model's plan is cut to size", () => {
  const p = checkPlan({ steps: ["a", "b", "c", "d", "e", "f"], questions: [{ q: "x", options: ["1", "1", "2", "3", "4", "5"] }, { q: "", options: [] }], risky: "nope", prices: ["free", "12 €"] })
  assert.equal(p.steps.length, 5)
  assert.deepEqual(p.questions, [{ q: "x", options: ["1", "2", "3", "4"] }])
  assert.deepEqual(p.risky, [])
  assert.deepEqual(p.prices, ["12 €"])
})

test("coverage: the person's own words, the same button, the price, never off the request or on another site", () => {
  const plan = buildPlan(checkPlan(RAW), ctx)
  plan.approved = true
  plan.answers = [{ q: "What time?", a: "19:30" }]
  const w = personWords(ctx.request, plan)
  assert.match(w, /What time\? — 19:30/)
  const c = (call: ToolCall, cls: "confirm" | "self", reason: string, off?: string, map = BOOK) => covered(plan, call, { cls, reason }, map, w, off)
  assert.ok(c({ tool: "type", id: "1", text: "Anna Petrova" }, "confirm", "personal"))
  assert.equal(c({ tool: "type", id: "1", text: "Boris" }, "confirm", "personal"), null, "a name the person didn't give")
  assert.ok(c({ tool: "click", id: "5" }, "confirm", "submit"))
  assert.ok(c({ tool: "click", id: "4" }, "self", "consent"))
  assert.equal(c({ tool: "click", id: "6" }, "self", "pay"), null)
  assert.equal(c({ tool: "click", id: "5" }, "confirm", "submit", "not what you asked"), null)
  assert.equal(c({ tool: "click", id: "7" }, "confirm", "other_site"), null)
  const dearer = { ...BOOK, text: "Dinner menu from 59,00 € per person" }
  assert.equal(c({ tool: "click", id: "5" }, "confirm", "submit", undefined, dearer), null, "the price isn't the plan's")
  const elsewhere = { ...BOOK, url: "https://pay.other.com/book" }
  assert.equal(c({ tool: "click", id: "5" }, "confirm", "submit", undefined, elsewhere), null)
  plan.perms = plan.perms.map((p) => (p.kind === "press" ? { ...p, on: false } : p))
  assert.equal(c({ tool: "click", id: "5" }, "confirm", "submit"), null, "unticked: asks")
})

test("prices: amounts as pages write them; a cart total of the same price is the same price", () => {
  assert.deepEqual(amounts("Price: 1 299,90 € · old €1,499.00 · 129 руб. · $5"), [1299.9, 299.9, 1499, 129, 5])
  const plan = { steps: [], questions: [], perms: [], self: [], prices: ["129,90 €"], approved: true }
  const page = (text: string): PageMap => ({ ...BOOK, text })
  assert.equal(priceChanged(plan, page("Total 259,80 €")), null, "two of them")
  assert.equal(priceChanged(plan, page("Nothing about money")), null)
  assert.equal(priceChanged(plan, page("Now 139,90 €")), "129,90 €")
})

function io(replies: ActReply[]) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted } = {
    asked, acted,
    map: async () => BOOK,
    act: async (c) => {
      acted.push(c)
      return { ok: true }
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30,
    planning: true
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

test("one card, then alone: allowed steps go without a question; paying still stops", async () => {
  const x = io([
    { ok: true, plan: RAW, token: "t", left: 9 },
    step({ tool: "type", id: "1", text: "Anna Petrova" }, "confirm", "personal"),
    step({ tool: "type", id: "2", text: "+44 20 7946 0000" }, "confirm", "personal"),
    step({ tool: "click", id: "4" }, "self", "consent"),
    step({ tool: "click", id: "5" }, "confirm", "submit"),
    step({ tool: "click", id: "6" }, "self", "pay"),
    step({ tool: "done", summary: "Booked" }, "free", "read")
  ])
  let s = await drive(newState("t1", ctx.request, "en", BOOK.url), x)
  assert.equal(s.status, "plan")
  assert.equal(x.asked[0].task.phase, "plan")
  assert.equal(s.token, "t")
  assert.deepEqual(x.acted, [], "nothing done before «Начать»")
  s = await approvePlan(s, x, { answers: ["19:30"], off: [] })
  assert.equal(s.status, "self", "paying stops")
  assert.equal(s.pending?.verdict.reason, "pay")
  assert.deepEqual((x.acted as ToolCall[]).map((c) => c.id), ["1", "2", "4", "5"])
  assert.ok(s.lines.every((l) => l.byPlan))
  assert.match(x.asked[1].task.request, /19:30/, "the answers go with the request")
  assert.match(x.asked[1].task.plan, /allowed without asking/)
  assert.equal(x.asked[1].task.step, 1)
  s = await answer(s, x, "notnow")
  assert.equal(s.status, "done")
})

test("unticked in the plan: that step asks; a plan that needs nothing starts at once", async () => {
  const x = io([
    { ok: true, plan: RAW, token: "t" },
    step({ tool: "click", id: "5" }, "confirm", "submit")
  ])
  let s = await drive(newState("t2", ctx.request, "en", BOOK.url), x)
  const press = s.plan!.perms.find((p) => p.label === "Book a table")!
  s = await approvePlan(s, x, { answers: [""], off: [press.id] })
  assert.equal(s.status, "confirm")
  assert.deepEqual(x.acted, [])

  const y = io([{ ok: true, plan: { steps: ["Reading the specs"], questions: [], risky: [], prices: [] }, token: "t" }, step({ tool: "extract" }, "free", "read")])
  const s2 = await drive(newState("t3", "How much do they weigh?", "en", BOOK.url), y)
  assert.equal(s2.status, "done")
  assert.equal(s2.plan?.approved, true)
})

test("an old server (no plan in its answer): every «Сделать?» asks, as before", async () => {
  const x = io([{ ok: true, token: "t", call: { tool: "read_page" }, verdict: { cls: "free", reason: "read" } }, step({ tool: "click", id: "5" }, "confirm", "submit")])
  const s = await drive(newState("t4", ctx.request, "en", BOOK.url), x)
  assert.equal(s.status, "confirm")
  assert.equal(s.plan, undefined)
})

test("an answer refused twice gets a third try with the stronger model before the task stops", async () => {
  const { nextStep } = await import("../netlify/shared/act.mts")
  const models: string[] = []
  const answers: unknown[] = [{ tool: "fill", id: "1", key: "name.phone" }, { tool: "fill", id: "1", key: "name.phone" }, { tool: "type", id: "3", text: "2026-12-05" }]
  const usage = { model: "m", input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }
  const opts = { model: "claude-haiku-5-5", startHost: "table.example.com", confirmedHere: false, check: false, ask: async (_c: string, m: string) => (models.push(m), { data: answers.shift(), usage }) }
  const input = { request: "x", lang: "en", map: BOOK, log: [] }
  const out = await nextStep(input, { ...opts, fallback: "claude-sonnet-5-5" })
  assert.deepEqual(models, ["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"])
  assert.equal(out.call.tool, "type")
  assert.equal(out.retries, 2)
  const bad = await nextStep(input, { ...opts, ask: async () => ({ data: { tool: "nope" }, usage }) })
  assert.equal(bad.verdict.reason, "bad_call", "without a fallback: two tries, as before")
})

test("nothing to type into an empty field is refused (the model answers again), emptying a filled one isn't", async () => {
  const { checkCall } = await import("../src/shared/agent/call.ts")
  assert.equal(checkCall({ tool: "type", id: "2", text: "" }, BOOK).ok, false)
  const filled: PageMap = { ...BOOK, items: [{ id: "9", role: "textbox", label: "Note", value: "old" }] }
  assert.equal(checkCall({ tool: "type", id: "9", text: "" }, filled).ok, true)
})

test("a price is changed only when the page shows none the device saw at plan time (the model's pick may be another item's)", () => {
  const shop: PageMap = { ...BOOK, text: "Air 2 129.00 € · also: Air 2 Lite 73.00 €" }
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [], prices: ["73.00 €"] }), { ...ctx, map: shop })
  plan.approved = true
  assert.ok(plan.seen?.includes(129))
  assert.equal(priceChanged(plan, { ...BOOK, text: "Air 2 129.00 € · Cart 258.00 €" }), null)
  assert.equal(priceChanged(plan, { ...BOOK, text: "Air 2 139.00 €" }), "73.00 €")
})

test("a saved detail the request itself gives goes as the plan's typing; a field typed from the request isn't listed twice", async () => {
  const raw = { ...RAW, risky: [...RAW.risky, { tool: "fill", id: "2", text: "", key: "phone" }] }
  const plan = buildPlan(checkPlan(raw), ctx)
  assert.equal(plan.perms.filter((p) => p.kind === "fill").length, 0, "the phone is typed from the request, not a saved detail too")
  const x = io([
    { ok: true, plan: RAW, token: "t" },
    step({ tool: "fill", id: "2", key: "phone" }, "confirm", "fill"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ])
  x.entries = async () => [{ id: "e1", key: "phone", label: "", value: "+44 20 7946 0000", updatedAt: 1 }] as never
  let s = await drive(newState("t5", ctx.request, "en", BOOK.url), x)
  s = await approvePlan(s, x, { answers: ["19:30"], off: [] })
  assert.equal(s.status, "done", "no «Заполнить?»: the value is the request's own")
  assert.equal((x.acted as ToolCall[])[0]?.text, "+44 20 7946 0000")
  const y = io([{ ok: true, plan: RAW, token: "t" }, step({ tool: "fill", id: "2", key: "phone" }, "confirm", "fill")])
  y.entries = async () => [{ id: "e1", key: "phone", label: "", value: "+44 20 0000 1111", updatedAt: 1 }] as never
  let s2 = await drive(newState("t6", ctx.request, "en", BOOK.url), y)
  s2 = await approvePlan(s2, y, { answers: ["19:30"], off: [] })
  assert.equal(s2.status, "fill", "another number than the request's: asks")
})

test("with the whole page's amounts: changed only when one is new; they never go to the server", async () => {
  const plan = buildPlan(checkPlan({ steps: [], questions: [], risky: [], prices: ["73.00 €"] }), { ...ctx, map: { ...BOOK, text: "list 73.00 €", money: [129, 73, 58] } })
  plan.approved = true
  assert.equal(priceChanged(plan, { ...BOOK, text: "Air 2 129.00 €", money: [129, 73, 58, 258] }), null, "the screen moved; a cart of two")
  assert.equal(priceChanged(plan, { ...BOOK, text: "Air 2 139.00 €", money: [139, 73, 58] }), "73.00 €")
  const x = io([{ ok: true, plan: { steps: ["x"], questions: [], risky: [], prices: [] }, token: "t" }, step({ tool: "done", summary: "ok" }, "free", "read")])
  x.map = async () => ({ ...BOOK, money: [1, 2] })
  await drive(newState("t7", "x", "en", BOOK.url), x)
  assert.ok(x.asked.every((b) => b.map.money === undefined))
})

test("notifications name the task by the plan's few words and the site, never the request", async () => {
  const { safeLabel, noticeLabel } = await import("../src/shared/agent/taskplan.ts")
  assert.equal(safeLabel("бронирование столика"), "бронирование столика")
  for (const bad of ["столик для Анны +7 900 123-45-67", "anna@example.com", "бронь на 5 декабря", "«Анна»", "a b c d e f g"]) assert.equal(safeLabel(bad), "", bad)
  const plan = buildPlan(checkPlan({ label: "booking a table", steps: [], questions: [], risky: [], prices: [] }), ctx)
  assert.equal(noticeLabel(plan, "www.table.example.com"), "booking a table · table.example.com")
  assert.equal(noticeLabel(buildPlan(checkPlan({ label: "call +44 20 7946 0000", steps: [] }), ctx), "table.example.com"), "table.example.com")
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(bg, /replace\("\{0\}", (request|state\.request|state\.summary)/)
  assert.doesNotMatch(bg, /body: d\.request/)
  assert.match(app, /notifBody: t\("agentNotifBody", noticeLabel\(from\.plan, host\)\)/)
})
