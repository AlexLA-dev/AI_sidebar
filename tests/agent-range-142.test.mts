// Round 142, the director's decision 12: a stated range of days («between 1 and 7 December») is the kind "range", its
// last day copied by the model into windowEnd and checked by the device; a window that contradicts its first day takes
// the standing rule's days from that day, never one day by accident.
import assert from "node:assert/strict"
import { test } from "node:test"

import { checkPlan, windowOf } from "../src/shared/agent/taskplan.ts"

const FRI = "2026-11-27"
const at = (kind: string, date: string, window: string, extra: Record<string, unknown> = {}, nights = 0, rule = 2, zone = "Europe/Nicosia") =>
  windowOf({ kind, date, window, ...extra } as never, FRI, rule, nights, zone)

test("a range runs to its windowEnd, also across a month's end and a year's end", () => {
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2026-12-07" }), { date: "2026-12-01", dayLast: "2026-12-07" })
  assert.deepEqual(at("appointment", "2026-11-28", "range", { windowEnd: "2026-12-05" }), { date: "2026-11-28", dayLast: "2026-12-05" })
  assert.deepEqual(at("table", "2026-12-28", "range", { windowEnd: "2027-01-03" }), { date: "2026-12-28", dayLast: "2027-01-03" })
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2026-12-01" }), { date: "2026-12-01" }, "both ends one day")
})

test("a stay given its nights apart: the last check-in is windowEnd less the nights", () => {
  assert.deepEqual(at("stay", "2026-12-01", "range", { windowEnd: "2026-12-10" }, 3), { date: "2026-12-01", dayLast: "2026-12-07" })
  assert.deepEqual(at("rental", "2026-12-28", "range", { windowEnd: "2027-01-04" }, 2), { date: "2026-12-28", dayLast: "2027-01-02" })
})

test("a bad windowEnd (before the first day, over 45 days, not a date) takes the standing rule's days from the first day", () => {
  const fixed = { date: "2026-12-01", dayLast: "2026-12-03", windowFixed: true }
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2026-11-30" }), fixed, "before the first day")
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2027-01-16" }), fixed, "46 days after")
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2027-01-15" }), { date: "2026-12-01", dayLast: "2027-01-15" }, "45 days is fine")
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "" }), fixed, "none given")
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2026-13-01" }), fixed, "not a date")
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "2026-12-01" }, 0, 0), { date: "2026-12-01" })
  assert.deepEqual(at("table", "2026-12-01", "range", { windowEnd: "bad" }, 0, 0), { date: "2026-12-01", windowFixed: true }, "no standing rule: the day alone, counted")
})

test("rule 4 for every kind whose end falls before the first day; none stays the one day", () => {
  const fixed = { date: "2026-12-01", dayLast: "2026-12-03", windowFixed: true }
  assert.deepEqual(at("table", "2026-12-01", "this_week"), fixed, "the stand's Arabic miss: this week ends 29 Nov")
  assert.deepEqual(at("table", "2026-12-01", "this_weekend"), fixed)
  assert.deepEqual(at("table", "2026-12-15", "next_week"), { date: "2026-12-15", dayLast: "2026-12-17", windowFixed: true })
  assert.deepEqual(at("stay", "2026-12-01", "this_week", {}, 2), fixed, "a stay too: the rule's days, not the nights")
  assert.deepEqual(at("table", "2026-12-01", "none"), { date: "2026-12-01" })
  assert.deepEqual(at("table", "2026-12-01", "first_free"), { date: "2026-12-01", dayLast: "2026-12-03" })
  // Kinds that never contradict: their end is counted from the first day.
  assert.deepEqual(at("table", "2026-12-01", "next_days", { windowDays: 7 }), { date: "2026-12-01", dayLast: "2026-12-07" })
  assert.deepEqual(at("table", "2026-12-01", "this_month"), { date: "2026-12-01", dayLast: "2026-12-31" })
  // Unchanged where the window holds: this week from today, a Sunday's one day.
  assert.deepEqual(at("table", FRI, "this_week"), { date: FRI, dayLast: "2026-11-29" })
  assert.deepEqual(at("table", "2026-11-29", "this_week"), { date: "2026-11-29" }, "the week's last day named: that day")
})

test("the plan keeps windowEnd for a range only", () => {
  const raw = (window: string, windowEnd: string) => ({ label: "", steps: ["Booking"], questions: [], risky: [], prices: [], booking: { kind: "table", date: "2026-12-01", dateEnd: "", window, windowDays: 0, windowEnd, at: "", personal: false, from: "18:00", until: "21:00", minutes: 90, tz: "", venue: "", match: [], area: [], contacts: [], specialists: [], services: [], specialistNamed: "", serviceNamed: "" } })
  assert.equal(checkPlan(raw("range", "2026-12-07")).booking?.windowEnd, "2026-12-07")
  assert.equal(checkPlan(raw("range", "2026-12-07")).booking?.window, "range")
  assert.equal(checkPlan(raw("this_week", "2026-12-07")).booking?.windowEnd, undefined)
})
