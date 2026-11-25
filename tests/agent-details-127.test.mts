// The director's pass on 127 (iPad, the stand's one booking form): whose details go in, where a value may come from,
// the nearest free time, a name answered mid-task, one «My details» line, and one format for times and dates.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import type { FormEntry } from "../src/shared/agent/formdata.ts"
import { answer, drive, newState, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { nearerTimes } from "../src/shared/agent/rules.ts"
import { addContactFill, buildPlan, checkPlan, saidInWords, type TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const FORM: PageMap = {
  url: "https://tables.example/booking", title: "Book a table", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "",
  items: [
    { id: "1", role: "textbox", label: "Name", lock: "personal", form: 0, state: ["empty"] },
    { id: "2", role: "textbox", label: "Phone", lock: "personal", type: "tel", auto: "tel", form: 0, state: ["empty"] },
    { id: "3", role: "textbox", label: "E-mail", lock: "personal", type: "email", auto: "email", form: 0, state: ["empty"] },
    { id: "5", role: "combobox", label: "Time", options: ["18:00", "18:30", "19:00", "19:30", "20:00"], form: 0 },
    { id: "9", role: "button", label: "Book", form: 0 }
  ]
} as PageMap

const SAVED: FormEntry[] = [
  { id: "e1", key: "name.full", label: "", value: "Alex Test", updatedAt: 1 },
  { id: "e2", key: "email", label: "", value: "alex.test@example.com", updatedAt: 1 }
] as FormEntry[]

function io(replies: ActReply[], entries: FormEntry[] = SAVED, map: PageMap = FORM) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted } = {
    asked, acted,
    map: async () => map,
    act: async (c) => {
      acted.push(c)
      return { ok: true, note: "done" }
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => entries,
    policy: { amazon: true },
    maxSteps: 30
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

function running(request: string, plan: Partial<TaskPlan>): AgentState {
  const s = newState("t127", request, "en", FORM.url)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "table", date: "2026-11-26", at: "", from: "", until: "", minutes: 90 }, ...plan } as TaskPlan
  return s
}

test("1: a detail the request gives is never filled from My details (Maria Kim, not the saved Alex Test)", async () => {
  const s = running("Book a table for Maria Kim, maria@example.com, tomorrow at 18:30 for 2 people", {
    perms: [{ id: "p0", kind: "personal", reason: "personal", label: "Name, E-mail", fields: ["Name", "E-mail"], host: "tables.example", on: true }]
  })
  const x = io([
    step({ tool: "fill", id: "1", key: "name.full", why: "Filling in your name, Maria Kim" }, "confirm", "fill"),
    step({ tool: "fill", id: "3", key: "email", why: "Filling in the e-mail" }, "confirm", "fill"),
    step({ tool: "done", summary: "stopped" }, "free", "read")
  ])
  const after = await drive(s, x)
  assert.notEqual(after.status, "fill", "no «Fill in from My details?» card with someone else's details")
  assert.deepEqual(x.acted, [])
  assert.match(x.asked[1].log.at(-1).result, /refused: the request gives the name itself/)
  assert.match(x.asked[2].log.at(-1).result, /refused: the request gives the email itself/)
})

test("1: the plan's contact line leaves out what the request gives", () => {
  const plan = { steps: [], questions: [], self: [], prices: [], booking: { kind: "table" }, perms: [{ id: "p0", kind: "personal", reason: "personal", label: "Name", fields: ["Name"], host: "h", on: true }] } as unknown as TaskPlan
  addContactFill(plan, ["name.full", "email", "phone"], "h", "for Maria Kim, maria@example.com")
  assert.deepEqual(plan.perms.find((p) => p.reason === "contact")?.keys, ["phone"])
})

test("2: a name inside an e-mail isn't the person's words; a contact field takes only said, answered or saved values", async () => {
  assert.equal(saidInWords("Book a table tomorrow\nalex.test@example.com", "Alex"), false)
  assert.equal(saidInWords("Book a table tomorrow\nalex.test@example.com", "Alex Test"), false)
  assert.equal(saidInWords("Book a table tomorrow\nalex.test@example.com", "alex.test@example.com"), true)
  assert.equal(saidInWords("A table for Alex Test", "Alex"), true)
  // The plan from 127 (its Name allowed «from the request»), the e-mail answered on the card, nothing saved.
  const s = running("Book a table tomorrow at 20:00 for 3 people", {
    perms: [{ id: "p0", kind: "personal", reason: "personal", label: "Name", fields: ["Name"], host: "tables.example", on: true }],
    answers: [{ q: "email", a: "alex.test@example.com", contact: true }]
  })
  const x = io([step({ tool: "type", id: "1", text: "Alex", why: "Entering your name" }, "confirm", "personal"), step({ tool: "done", summary: "stopped" }, "free", "read")], [])
  await drive(s, x)
  assert.deepEqual(x.acted, [], "«Alex» isn't typed")
  assert.match(x.asked[1].log.at(-1).result, /refused: «Alex» isn't in the person's words.*ask_user for their name/)
  assert.equal(x.asked[1].log.at(-1).call.text, "", "the made-up value isn't sent back either")
})

test("2: the plan doesn't allow typing a contact field from a request that hasn't got it", () => {
  const raw = checkPlan({ label: "booking", steps: ["Booking"], questions: [], prices: [], risky: [{ tool: "type", id: "1", text: "", key: "" }, { tool: "type", id: "3", text: "maria@example.com", key: "" }] } as never)
  const ctx = { map: FORM, startHost: "tables.example", confirmedHere: false, policy: { amazon: true } }
  assert.equal(buildPlan(raw, { ...ctx, request: "Book a table tomorrow at 20:00 for 3 people" }).perms.find((p) => p.kind === "personal"), undefined, "no name, no e-mail in the request: nothing typed «from the request»")
  assert.deepEqual(buildPlan(raw, { ...ctx, request: "Book a table for 3, maria@example.com" }).perms.find((p) => p.kind === "personal")?.fields, ["E-mail"])
})

test("3: the nearest free time is the device's sum; a tie is either", async () => {
  assert.deepEqual(nearerTimes("19:10", "19:30", ["18:00", "18:30", "19:00", "19:30", "20:00"]), ["19:00"])
  assert.deepEqual(nearerTimes("20:10", "19:30", ["18:00", "19:30", "20:00"]), ["20:00"])
  assert.deepEqual(nearerTimes("19:15", "19:30", ["19:00", "19:30"]), [], "19:00 and 19:30 are as near")
  assert.deepEqual(nearerTimes("19:10", "19:30", ["19:00"], "19:20", "20:10"), [], "outside the window isn't offered")
  const s = running("Book a table tomorrow at 20:10 for 4 people", { booking: { kind: "table", date: "2026-11-26", at: "20:10", from: "19:10", until: "21:10", minutes: 90 } as never })
  const x = io([
    step({ tool: "select", id: "5", option: "19:30", date: "2026-11-26", time: "19:30" }, "free", "select"),
    step({ tool: "select", id: "5", option: "20:00", date: "2026-11-26", time: "20:00" }, "free", "select"),
    step({ tool: "done", summary: "ok" }, "free", "read")
  ])
  await drive(s, x)
  assert.match(x.asked[1].log.at(-1).result, /refused: 20:00 is free on the page and nearer to the asked 20:10 than 19:30/)
  assert.deepEqual(x.acted.map((c) => c.option), ["20:00"])
})

test("3: a nearer time the page shows as taken isn't offered", async () => {
  const map = { ...FORM, items: FORM.items.map((i) => (i.id === "5" ? { ...i, options: ["19:00", "19:30", "20:00 [unavailable]"] } : i)) } as PageMap
  const s = running("Book a table tomorrow at 20:10 for 4 people", { booking: { kind: "table", date: "2026-11-26", at: "20:10", from: "19:10", until: "21:10", minutes: 90 } as never })
  const x = io([step({ tool: "select", id: "5", option: "19:30", date: "2026-11-26", time: "19:30" }, "free", "select"), step({ tool: "done", summary: "ok" }, "free", "read")], SAVED, map)
  await drive(s, x)
  assert.deepEqual(x.acted.map((c) => c.option), ["19:30"])
})

test("4: a name the person just answered goes in by the plan's contact fill, no second card", async () => {
  const s = running("Book a table tomorrow at 19:10 for 2 people", {
    perms: [{ id: "pcontact", kind: "fill", reason: "contact", label: "", keys: ["email"], host: "tables.example", on: true }]
  })
  const x = io([step({ tool: "ask_user", question: "What name should I put in the Name field?" }, "free", "ask")], [SAVED[1]])
  let after = await drive(s, x)
  assert.equal(after.status, "asked")
  assert.equal(after.askKey, "name.full")
  x.ask = async (body) => {
    x.asked.push(JSON.parse(JSON.stringify(body)))
    return x.asked.length === 2 ? step({ tool: "fill", id: "1", key: "name.full" }, "confirm", "fill") : step({ tool: "done", summary: "ok" }, "free", "read")
  }
  after = await answer(after, x, "reply", ["Alex Test"])
  assert.notEqual(after.status, "fill", "no «Fill in from My details?» card for the name just given")
  assert.deepEqual(x.acted.map((c) => [c.tool, c.text]), [["fill", "Alex Test"], ["fill", "alex.test@example.com"]], "with the form's saved e-mail the plan named")
})

test("5: one «Fill in from My details» line, only what is saved", () => {
  const plan = {
    steps: [], questions: [], self: [], prices: [], booking: { kind: "table" },
    perms: [{ id: "p1", kind: "fill", reason: "fill", label: "Phone, E-mail", keys: ["phone", "email"], ids: ["2", "3"], host: "h", on: true }]
  } as unknown as TaskPlan
  addContactFill(plan, ["name.full", "email"], "h", "Book a table tomorrow at 19:10 for 2 people")
  assert.deepEqual(plan.perms.map((p) => [p.reason, p.keys]), [["contact", ["name.full", "email"]]], "no phone claimed, one line")
  const shop = { steps: [], questions: [], self: [], prices: [], perms: [{ id: "p1", kind: "fill", reason: "fill", label: "Address", keys: ["address.line1", "phone"], ids: ["4"], host: "h", on: true }] } as unknown as TaskPlan
  addContactFill(shop, ["address.line1"], "h", "")
  assert.deepEqual(shop.perms.map((p) => p.keys), [["address.line1"]], "not a booking: the model's fill keeps what is saved")
})

test("5, 6: a fill step's line names its field; times and dates in the device's format everywhere the model's words show", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  const bubble = readFileSync(new URL("../src/content/agent/Bubble.tsx", import.meta.url), "utf8")
  assert.match(panel, /l\.text \? localWhen\(l\.text\) : l\.tool === "fill" && l\.target \? t\("agentLineFilled", nameOf\(l\.target\)\)/)
  for (const spot of [/<p dir="auto">\{localWhen\(state\.summary \?\? ""\)\}<\/p>/, /<Markdown text=\{localWhen\(state\.summary\)\} \/>/, /if \(!own\) return localWhen\(line\)/, /\{localWhen\(c\)\}<\/button>/]) assert.match(panel, spot)
  assert.match(bubble, /<p dir="auto">\{localWhen\(data\.text\)\}<\/p>/)
  assert.match(bubble, /label: localWhen\(o\), on: \(\) => act\.reply\(o\)/)
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.equal((act.match(/as YYYY-MM-DD and a time as HH:MM \(24 h\)/g) ?? []).length, 2, "the step and the plan prompts ask for one form the device can show")
})

test("«Remember» starts unticked when the plan types a name the request carries, without the word «name» (127)", async () => {
  const { DEFAULT_RULES } = await import("../src/shared/agent/rules.ts")
  const run = async (request: string, risky: unknown[]) => {
    const RAW = { label: "table", steps: ["Booking"], questions: [], prices: [], fromChat: "", risky,
      booking: { kind: "table", date: "2026-11-26", dateEnd: "", at: "18:30", personal: false, from: "17:30", until: "19:30", minutes: 90, tz: "", venue: "", match: [], area: [], contacts: ["email"], specialists: [], services: [], specialistNamed: "", serviceNamed: "" } }
    const x: RunnerIO = {
      map: async () => FORM, act: async () => ({ ok: true }), waitPage: async () => {},
      ask: async () => ({ ok: true, plan: RAW, token: "t" }) as never,
      save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
      device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
    }
    return (await drive(newState("r", request, "en", FORM.url), x)).plan?.questions.find((q) => q.kind === "contact")
  }
  assert.equal((await run("Book a table for Maria Kim tomorrow at 18:30 for 2", [{ tool: "type", id: "1", text: "Maria Kim", key: "" }]))?.once, true, "someone else's e-mail: not kept by default")
  assert.equal((await run("Book a table tomorrow at 18:30 for 2", [{ tool: "type", id: "1", text: "", key: "" }]))?.once, undefined, "the person's own: kept")
})
