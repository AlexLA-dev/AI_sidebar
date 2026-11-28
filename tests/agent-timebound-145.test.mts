// Round 145, the director's decision 20: a clock time the request states as a bound («after 18:00», «before 20:00») is
// hard. The plan reports it (notBefore / notAfter) and the device clamps the plan's window to it; the earliest-free rule
// never names a time across it; the booking's press isn't offered for a time across it that no answer of the person's
// approved. A request with no stated time is as before. (The gate on 75b9f13e: «after 18:00» planned 17:00–22:00, 17:30
// named by the earliest-free rule and booked.)
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { answer, drive, newState, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { checkPlan, clampWindow, type TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const PAGE: PageMap = {
  url: "https://tables.example/booking", title: "Book a table", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "3 December 2026",
  items: [
    { id: "5", role: "combobox", label: "Time", options: ["17:30", "18:30", "19:30"], form: 0 },
    { id: "9", role: "button", label: "Book", type: "submit", form: 0 }
  ]
} as PageMap

function io(replies: ActReply[]) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted } = {
    asked, acted,
    map: async () => PAGE,
    act: async (c) => { acted.push(c); return { ok: true, note: "done" } },
    waitPage: async () => {},
    ask: async (body) => { asked.push(JSON.parse(JSON.stringify(body))); return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 12
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

/** The plan as the model wrote it (an hour wide of the bound), through the device's own check. */
function planned(request: string, raw: Record<string, unknown>): AgentState {
  const p = checkPlan({ label: "table", steps: ["Booking"], questions: [], prices: [], risky: [], fromChat: "", chatPlace: "",
    booking: { kind: "table", date: "2026-12-03", dateEnd: "", window: "none", windowDays: 0, windowEnd: "", at: "", notBefore: "", notAfter: "", personal: false, from: "17:00", until: "22:00", minutes: 90, tz: "", venue: "", match: [], area: [], contacts: [], specialists: [], services: [], specialistNamed: "", serviceNamed: "", ...raw } })
  const s = newState("t20", request, "en", PAGE.url)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: p.booking } as unknown as TaskPlan
  return s
}

// The same bounds in four scripts: the device never reads the words — the plan reports the direction.
const AFTER = ["Book a table for 2 at the first free time after 18:00", "Забронируй столик на двоих не раньше 18:00", "18時以降の一番早い空き時間に2名で予約して", "احجز طاولة لشخصين في أول وقت متاح بعد الساعة 18:00", "Book a table for 2 from 18:00"]
const BEFORE = ["Book a table for 2 before 20:00", "Забронируй столик на двоих до 20:00", "20時までに2名で予約して", "احجز طاولة لشخصين قبل الساعة 20:00", "Book a table for 2 until 20:00"]

test("20: a plan an hour wide of the bound is clamped to it («after», «from», «not before» / «before», «until»; four scripts)", () => {
  for (const r of AFTER) {
    const b = planned(r, { notBefore: "18:00" }).plan!.booking!
    assert.deepEqual([b.from, b.until, b.notBefore], ["18:00", "22:00", "18:00"], r)
  }
  for (const r of BEFORE) {
    const b = planned(r, { from: "18:00", until: "21:00", notAfter: "20:00" }).plan!.booking!
    assert.deepEqual([b.from, b.until, b.notAfter], ["18:00", "20:00", "20:00"], r)
  }
  assert.deepEqual(clampWindow("15:00", "17:00", "18:00"), { from: "18:00", until: "20:00" }, "a window wholly before the bound keeps its length after it")
  assert.deepEqual(clampWindow("21:00", "23:00", "", "20:00"), { from: "18:00", until: "20:00" })
})

test("20: the earliest-free rule names 18:30, never 17:30, for «after 18:00»; 17:30 pressed is refused as outside (four scripts)", async () => {
  for (const r of AFTER.slice(0, 4)) {
    const x = io([
      step({ tool: "select", id: "5", option: "19:30", date: "2026-12-03", time: "19:30" }, "free", "select"),
      step({ tool: "select", id: "5", option: "17:30", date: "2026-12-03", time: "17:30" }, "free", "select"),
      step({ tool: "done", summary: "ok" }, "free", "read")
    ])
    await drive(planned(r, { notBefore: "18:00" }), x)
    const lines = x.asked.flatMap((a) => (a.log ?? []).map((l: { result: string }) => l.result))
    assert.ok(lines.some((l) => /refused: 18:30 is free on the page and earlier in the asked time \(18:00–22:00\) than 19:30/.test(l)), `${r}: ${lines.join(" | ")}`)
    assert.ok(!lines.some((l) => /17:30 is free/.test(l)), r)
    assert.ok(lines.some((l) => /refused: 17:30 is outside the time the request states \(not before 18:00\)/.test(l)), r)
    assert.ok(!x.acted.some((c) => c.option === "17:30"), `${r}: 17:30 isn't chosen`)
  }
})

test("20: no booking's press for a time across the bound the person hasn't approved — the question; their own answer approves it", async () => {
  const s = planned(AFTER[0], { notBefore: "18:00" })
  s.picked = { date: "2026-12-03", time: "17:30" }
  const x = io([step({ tool: "click", id: "9", date: "2026-12-03", time: "17:30" }, "confirm", "submit"), step({ tool: "ask_user", question: "Nothing is free after 18:00 on 3 December. 17:30 instead?" }, "free", "read")])
  let st = await drive(s, x)
  assert.ok(st.log.some((l) => /^refused: the time chosen, 17:30, is outside the time the request states \(not before 18:00\)/.test(l.result ?? "")), st.log.map((l) => l.result).join(" | "))
  assert.ok(!x.acted.some((c) => c.id === "9"), "no booking's press")
  assert.equal(st.status, "asked")
  assert.equal(st.ruleCounts?.time_bound, 1)
  const y = io([step({ tool: "click", id: "9", date: "2026-12-03", time: "17:30" }, "confirm", "submit")])
  st = await answer(st, y, "reply", ["17:30"])
  assert.equal(st.plan?.booking?.notBefore, undefined, "the person's own time approves it")
  assert.ok(!st.log.some((l, i) => i > 2 && /outside the time the request states/.test(l.result ?? "")), st.log.map((l) => l.result).join(" | "))
})

test("20: a request with no stated time is as before (the window, the earliest free in it)", async () => {
  const s = planned("Book a table for 2 on 3 December in the evening", { from: "17:00", until: "21:00" })
  assert.deepEqual([s.plan!.booking!.from, s.plan!.booking!.until, s.plan!.booking!.notBefore], ["17:00", "21:00", undefined])
  const x = io([step({ tool: "select", id: "5", option: "18:30", date: "2026-12-03", time: "18:30" }, "free", "select"), step({ tool: "done", summary: "ok" }, "free", "read")])
  await drive(s, x)
  assert.match(x.asked[1].log.at(-1).result, /refused: 17:30 is free on the page and earlier in the asked time \(17:00–21:00\) than 18:30/)
})

test("20: the plan's prompt names the bounds, and the schema requires them", () => {
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /notBefore and notAfter: a clock time the request states as a bound/)
  const tp = readFileSync(new URL("../src/shared/agent/taskplan.ts", import.meta.url), "utf8")
  assert.match(tp, /"at", "notBefore", "notAfter", "personal"/)
})
