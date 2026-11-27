// Round 142, the director's item 4: the plan names the window's kind, the device works out its days (windowOf).
import assert from "node:assert/strict"
import { test } from "node:test"

import { windowOf } from "../src/shared/agent/taskplan.ts"

const FRI = "2026-11-27"
const w = (kind: string, window: string, extra: Record<string, unknown> = {}, nights = 0, rule = 2, zone = "Europe/Nicosia", today = FRI) =>
  windowOf({ kind, date: today, window, ...extra } as never, today, rule, nights, zone)

test("«this week» ends on the coming Sunday; a stay in it still ends inside it", () => {
  assert.deepEqual(w("table", "this_week"), { date: FRI, dayLast: "2026-11-29" })
  assert.deepEqual(w("appointment", "this_week", {}, 0, 2, "Asia/Seoul"), { date: FRI, dayLast: "2026-11-29" })
  assert.deepEqual(w("stay", "this_week", {}, 2), { date: FRI }, "Fri + 2 nights ends on Sunday: one possible check-in")
  assert.deepEqual(w("table", "this_week", {}, 0, 2, "", "2026-11-29"), { date: "2026-11-29" }, "on a Sunday: today only")
  assert.deepEqual(w("table", "this_week", {}, 0, 2, "", "2026-11-23"), { date: "2026-11-23", dayLast: "2026-11-29" }, "on a Monday: to Sunday")
})

test("next week, the weekend (Friday–Saturday where that's the weekend), the next N days", () => {
  assert.deepEqual(w("table", "next_week"), { date: "2026-11-30", dayLast: "2026-12-06" })
  assert.deepEqual(w("table", "this_weekend"), { date: "2026-11-28", dayLast: "2026-11-29" })
  assert.deepEqual(w("table", "this_weekend", {}, 0, 2, "Asia/Riyadh"), { date: FRI, dayLast: "2026-11-28" })
  assert.deepEqual(w("table", "next_days", { windowDays: 14 }), { date: FRI, dayLast: "2026-12-10" })
  assert.deepEqual(w("stay", "next_days", { windowDays: 14 }, 2), { date: FRI, dayLast: "2026-12-08" })
})

test("«this month» with n nights ends where the stay still ends inside the month", () => {
  assert.deepEqual(w("table", "this_month"), { date: FRI, dayLast: "2026-11-30" })
  assert.deepEqual(w("stay", "this_month", {}, 2), { date: FRI, dayLast: "2026-11-28" })
  assert.deepEqual(w("stay", "this_month", {}, 3), { date: FRI }, "27 Nov + 3 nights is out on 30 Nov: one check-in")
})

test("«the first free day» with no window takes the standing rule's «up to N days later»; one named day stays one day", () => {
  assert.deepEqual(w("table", "first_free", {}, 0, 2), { date: FRI, dayLast: "2026-11-29" })
  assert.deepEqual(w("table", "first_free", {}, 0, 0), { date: FRI })
  assert.deepEqual(windowOf({ kind: "table", date: "2026-12-05", window: "none" } as never, FRI, 2, 0), { date: "2026-12-05" })
  assert.deepEqual(windowOf({ kind: "table", date: "2026-12-05" } as never, FRI, 2, 0), { date: "2026-12-05" })
})
