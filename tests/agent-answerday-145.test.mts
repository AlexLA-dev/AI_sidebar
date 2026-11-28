// Round 145, the director's decision 18: the person's answered day is the booking's day — the window around the
// request's days goes, the day is never refused as outside it, and the device sets it on the page at once (set_dates,
// as for the plan's own day) before the model's next step.
import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { answer, dateStep, newState, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

const DAYS = ["Mon 30 Nov", "Tue 1 Dec", "Fri 4 Dec", "Fri 11 Dec", "Sat 12 Dec", "Sun 13 Dec", "Mon 14 Dec"]
const page = (): PageMap => ({ url: "https://salon.example/book", title: "Book", lang: "en", more: 0, part: 1, parts: 1, forms: [], text: "Choose a day",
  items: DAYS.map((label, i) => ({ id: String(i + 1), role: "button", label })) as MapItem[] }) as PageMap

function io(): RunnerIO & { acts: ToolCall[] } {
  const acts: ToolCall[] = []
  return {
    acts, map: async () => page(), act: async (c: ToolCall) => { acts.push(c); return { ok: true, note: "the page went on" } }, waitPage: async () => {},
    ask: async () => ({ ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } }),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 3, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO & { acts: ToolCall[] }
}
const asked = (booking: Record<string, unknown>): AgentState => {
  const st = newState("ad", "Book it.", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment", personal: false, from: "09:00", until: "21:00", minutes: 45, ...booking } } as never
  st.status = "asked"
  st.question = "Nothing is free this week. The next free day is Friday 11 December — book that?"
  return st
}

test("18: an appointment moved a week on — the plan's day, no window, set on the page by the device (four scripts)", async () => {
  for (const reply of ["Yes, Friday 11 December 2026", "Да, пятница, 11 декабря 2026", "はい、2026年12月11日(金)で", "نعم، الجمعة 11 ديسمبر 2026"]) {
    const x = io()
    const st = await answer(asked({ date: "2026-11-30", dayLast: "2026-12-04", window: "next_days", windowDays: 5 }), x, "reply", [reply])
    const b = st.plan!.booking!
    assert.equal(b.date, "2026-12-11", reply)
    assert.equal(b.dayLast, undefined, reply)
    assert.equal(b.window, undefined, reply)
    assert.ok(st.log.some((l) => l.call?.tool === "set_dates" && /^the device went to the day itself/.test(l.result ?? "")), `${reply}: ${st.log.map((l) => l.result).join(" | ")}`)
    assert.ok(x.acts.some((a) => a.tool === "click" && a.id === "4"), `${reply}: the device pressed «Fri 11 Dec»`)
  }
})

test("18: the answered day is never refused as outside the request's window", async () => {
  // (A page past the window: the request's days aren't shown, only December's second week.)
  const later = (): PageMap => ({ ...page(), items: page().items.slice(3) })
  const before = asked({ date: "2026-11-30", dayLast: "2026-12-04", window: "next_days", windowDays: 5 })
  assert.match(dateStep(before, later(), later().items[0], { tool: "click", id: "4", why: "" } as ToolCall) ?? "", /isn't the asked day/, "without the answer: refused")
  const st = await answer(asked({ date: "2026-11-30", dayLast: "2026-12-04", window: "next_days", windowDays: 5 }), io(), "reply", ["Yes, 11 December 2026"])
  st.log = []
  st.dateSteps = 0
  st.lastDate = undefined
  assert.equal(dateStep(st, later(), later().items[0], { tool: "click", id: "4", why: "" } as ToolCall), null)
})

test("18: a stay re-dated by an answer keeps its nights, and the device sets both days", async () => {
  const x = io()
  const st = await answer(asked({ kind: "stay", date: "2026-11-30", dateEnd: "2026-12-01" }), x, "reply", ["Then 12 December 2026, please"])
  assert.equal(st.plan!.booking!.date, "2026-12-12")
  assert.equal(st.plan!.booking!.dateEnd, "2026-12-13")
  assert.ok(st.log.some((l) => l.call?.tool === "set_dates" && l.call.date === "2026-12-12"), st.log.map((l) => `${l.call?.tool} ${l.result}`).join(" | "))
})

test("18: an answer with no day leaves the plan's day and sets nothing", async () => {
  const x = io()
  const st = await answer(asked({ date: "2026-11-30", dayLast: "2026-12-04", window: "next_days", windowDays: 5 }), x, "reply", ["Any time is fine"])
  assert.equal(st.plan!.booking!.date, "2026-11-30")
  assert.equal(st.plan!.booking!.dayLast, "2026-12-04")
  assert.ok(!st.log.some((l) => l.call?.tool === "set_dates"))
})
