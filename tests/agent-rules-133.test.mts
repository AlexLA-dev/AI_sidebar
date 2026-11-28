// The director's round after 0a3d9e23: which of the device's rules refused or held an agent's steps, on its end event
// (codes and counts only, never what was refused).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { agentEvents } from "../src/shared/agent/events.ts"
import { answer, drive, newState, slotCode, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PlanBooking, TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"
import { AGENT_RULES, FEATURES, rulesField, rulesValue, useFields } from "../src/shared/usage.ts"
import { clock, clockForm, clockFrom } from "../src/content/agent/clockform.ts"

test("the field: rule codes from the list, each once, counts 1–99; nothing else passes", () => {
  assert.equal(rulesField("contact_kind:1,slot_time:2"), true)
  assert.equal(rulesField("book_again:99"), true)
  for (const bad of ["", "contact_kind:0", "contact_kind:100", "contact_kind:1,contact_kind:2", "made_up_rule:1", "contact_kind", "Old Town:1", "contact_kind:1;slot_time:1", 3, null]) assert.equal(rulesField(bad), false, String(bad))
  assert.equal(rulesValue({ slot_time: 2, contact_kind: 1, nope: 4 } as never), "contact_kind:1,slot_time:2")
  assert.equal(rulesValue(undefined), "")
  assert.equal(FEATURES.agent.fields!.rules, "rules")
  // The server keeps it on agent.end; a bad value is left out, the event kept.
  assert.equal(useFields({ f: "agent", a: "end", result: "done", rules: "book_again:1" })!.rules, "book_again:1")
  const bad = useFields({ f: "agent", a: "end", result: "done", rules: "Your stay is booked:1" })!
  assert.equal(bad.rules, undefined)
  assert.equal(bad.result, "done")
})

test("every code is counted somewhere in the runner, and the slot rules by their messages", () => {
  const src = readFileSync(new URL("../src/shared/agent/runner.ts", import.meta.url), "utf8")
  const slot = new Set(["slot_time", "slot_window", "slot_nearer", "slot_busy"])
  for (const code of AGENT_RULES) assert.ok(slot.has(code) || src.includes(`rule(state, "${code}")`), code)
  assert.match(src, /rule\(state, slotCode\(busy\)\)/)
  assert.equal(slotCode("a time slot: say its date (YYYY-MM-DD) and time (HH:MM) in date and time when you press it"), "slot_time")
  assert.equal(slotCode("21:00 is outside the time the request and the rules allow (18:00–20:00): choose"), "slot_window")
  assert.equal(slotCode("19:00 is free on the page and nearer to the asked 19:10 than 19:30: choose 19:00"), "slot_nearer")
  assert.equal(slotCode("2026-11-27 19:30 is busy in the person's calendar (their event)"), "slot_busy")
  // Every refusal or hold the runner logs has its count beside it.
  const logged = src.split("\n").filter((l) => /state\.log\.push\(.*result: (box \? )?`(refused|held)/.test(l) || /result: access === "denied" \? `refused/.test(l)).length
  // (book_unseen isn't a refusal: a booking press the device didn't record, counted at the end; nor cookie_device, a
  // cookie layer the device refused itself, decision 13a; nor round 145's dayNotes experiment, a day rule said as a note.)
  assert.equal(src.split("\n").filter((l) => /^\s*rule\(state, /.test(l) && !/"book_unseen"|"cookie_device"|rule\(state, key\)/.test(l)).length, logged)
})

const step = (call: ToolCall, cls: "free" | "confirm", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const STAY = "https://stays.example/stay?id=3&in=2026-12-04&out=2026-12-06"
const items = [
  { id: "1", role: "textbox", label: "Destination", form: 0 },
  { id: "3", role: "button", label: "Reserve" },
  { id: "6", role: "button", label: "Complete booking", form: 0 }
] as PageMap["items"]
const page = (text: string): PageMap => ({ url: STAY, title: "Old Town Guesthouse", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text, items }) as PageMap

test("the end event names the rules that refused steps in the task, with counts", async () => {
  let current = page("Old Town Guesthouse 2026-12-04 – 2026-12-06 Guest details")
  const replies: ActReply[] = [
    step({ tool: "fill", id: "1", key: "name.full", why: "name" }, "confirm", "fill"),
    step({ tool: "click", id: "6", why: "Completing" }, "confirm", "submit"),
    step({ tool: "click", id: "3", why: "Reserve" }, "confirm", "submit"),
    step({ tool: "click", id: "3", why: "Reserve" }, "confirm", "submit"),
    step({ tool: "done", summary: "Booked." }, "free", "read")
  ]
  const io: RunnerIO = {
    map: async () => current,
    act: async (c) => {
      if (c.tool === "click" && c.id === "6") current = page("Old Town Guesthouse 2026-12-04 – 2026-12-06 Guest details Your stay is booked")
      return { ok: true, note: "done" }
    },
    waitPage: async () => {},
    ask: async () => replies.shift() ?? step({ tool: "done", summary: "x" }, "free", "read"),
    save: async () => {},
    entries: async () => [{ id: "e1", key: "name.full", label: "", value: "Alex Test", updatedAt: 1 }] as never,
    policy: { amazon: true },
    maxSteps: 30
  }
  const s: AgentState = newState("r133", "Book a stay", "en", STAY)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0 } as PlanBooking } as unknown as TaskPlan
  let st = await drive(s, io)
  st = await answer(st, io, "yes")
  assert.equal(st.status, "done")
  const end = agentEvents(st).find((e) => e.a === "end")!
  assert.equal(end.rules, "book_again:2,contact_kind:1")
  assert.ok(rulesField(end.rules))
  // Nothing in it but the codes and counts.
  assert.doesNotMatch(String(end.rules), /Destination|Reserve|Old Town|Alex/)
})

test("a task no rule touched has no rules field", () => {
  const s = newState("r133b", "x", "en", STAY)
  s.status = "done"
  const end = agentEvents(s).find((e) => e.a === "end")!
  assert.equal("rules" in end, false)
})

test("times in the form the person wrote one in: «19:30» stays 24-hour on a 12-hour device, «7:30 pm» stays 12-hour", () => {
  assert.equal(clockForm("Book a table for 2 tomorrow at 19:30"), "h23")
  assert.equal(clockForm("Забронируй столик на 19:30"), "h23")
  assert.equal(clockForm("Book a table at 7:30 pm"), "h12")
  assert.equal(clockForm("book for 7pm"), "h12")
  assert.equal(clockForm("Book a stay for 2 nights from next Friday"), undefined)
  clockFrom("Book a table for 2 tomorrow at 19:30")
  assert.match(clock("19:30"), /^19:30$/)
  clockFrom("Book a table at 7:30 pm")
  assert.match(clock("19:30"), /7:30\s?PM/i)
  // No time written: the device's own clock (on an en-US 12-hour device, as the iPad's).
  clockFrom("Book a stay")
  assert.equal(clock("19:30"), new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(2000, 0, 1, 19, 30)))
  // Every place the panel and the bubble draw a task's times takes its request's form first.
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  const bubble = readFileSync(new URL("../src/content/agent/Bubble.tsx", import.meta.url), "utf8")
  assert.match(panel, /export function AgentPanel\(\{[^\n]+\n  clockFrom\(state\.request\)/)
  assert.match(panel, /export function AgentStrip\(\{[^\n]+\n  clockFrom\(state\.request\)/)
  assert.match(panel, /hour: "2-digit", minute: "2-digit", \.\.\.hours\(\)/)
  assert.match(bubble, /clockFrom\(s\.request\)/)
  assert.match(bubble, /export function AgentBubble\(\{[^\n]+\n  clockFrom\(data\.request\)/)
})

test("the «Do it on this page?» chip isn't offered again for a request a task already started from", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /const startedFrom = \(text: string\) => \[agentTask, \.\.\.agentPast\]\.some\(\(p\) => !!p && p\.request\.trim\(\) === text\.trim\(\)\)/)
  assert.match(app, /asksForAction\(messages\[lastUserIndex\]\.content\) && !startedFrom\(messages\[lastUserIndex\]\.content\) \? lastUserIndex : -1/)
})

test("step lines carry no technical reasons (prompt)", () => {
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /Nor a technical reason for a step — how the browser, a tab, a link or the page's code behaves/)
})
