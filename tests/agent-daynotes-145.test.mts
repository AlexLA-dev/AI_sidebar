// Round 145, the director's B: (1) days_unset never refuses a press that enters the booking flow (a specialist's or
// service's link, an entry word) on a page with no date control; (2) the dayNotes experiment, off by default: the day
// refusals become one-time notes and the action goes on — a greyed day and the booking's last press stay refusals.
import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { drive, newState, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

const page = (items: Array<Partial<MapItem>>, over: Partial<PageMap> = {}): PageMap =>
  ({ url: "https://salon.example/masters", title: "Masters", lang: "en", more: 0, part: 1, parts: 1, forms: [{ n: 0, fillable: true }], text: "Our masters", items: items.map((i, n) => ({ id: String(n + 1), role: "button", label: "", ...i })), ...over }) as PageMap

function io(map: () => PageMap, calls: Array<Record<string, unknown>>, notes = false): RunnerIO & { acts: ToolCall[] } {
  const acts: ToolCall[] = []
  const replies = calls.map((c) => ({ ok: true, call: { why: "", ...c } as unknown as ToolCall, verdict: (c.verdict as object) ?? (c.tool === "click" ? { cls: "free", reason: "click" } : { cls: "free", reason: "read" }) }))
  return {
    acts,
    map: async () => map(), act: async (c: ToolCall) => { acts.push(c); return { ok: true, note: "the page went on" } }, waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 8, planning: false, dayNotes: notes,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO & { acts: ToolCall[] }
}
const planned = (date = "2026-12-04"): AgentState => {
  const st = newState("dn", "Book a manicure on 4 December.", "en", "https://salon.example/masters")
  st.plan = { steps: [], questions: [], perms: ["submit"], self: [], prices: [], approved: true, booking: { kind: "appointment", date, personal: false, from: "09:00", until: "21:00", minutes: 45 } } as never
  return st
}
const SUBMIT = { cls: "confirm", reason: "submit" }
const refusedUnset = (st: AgentState) => st.log.some((l) => /^refused: the page doesn't show the booking's day/.test(l.result ?? ""))

test("days_unset: an entry press (a specialist's link, «Book») on a page with no date control isn't refused (four scripts)", async () => {
  for (const [link, button, search] of [["Anna, manicure master 5 (129) Book", "Book", "Master's name"], ["Шанина Кристина Мастер маникюра 5 (129) Записаться", "Записаться", "Имя или фамилия специалиста"], ["山田 ネイリスト 予約", "予約", "スタッフ名"], ["ليلى خبيرة أظافر احجز", "احجز", "اسم المختص"]]) {
    const m = () => page([{ role: "textbox", label: search, lock: "personal" }, { role: "link", label: link, href: "/master/1" }, { label: button }])
    for (const id of ["2", "3"]) {
      const x = io(m, [{ tool: "click", id, verdict: SUBMIT }])
      const st = await drive(planned(), x)
      assert.ok(!refusedUnset(st), `${button} ${id}: ${st.log.map((l) => l.result).join(" | ")}`)
    }
  }
})

test("days_unset: the same press with a date control on the page and the asked day not set is still refused", async () => {
  const m = () => page([{ label: "Sat 28 Nov", state: ["selected"] }, { label: "Book" }])
  const st = await drive(planned(), io(m, [{ tool: "click", id: "2", verdict: SUBMIT }]))
  assert.ok(refusedUnset(st), st.log.map((l) => l.result).join(" | "))
})

test("dayNotes off (the extension): another day than the asked one is refused", async () => {
  const m = () => page([{ label: "Sun 6 Dec" }, { label: "Mon 7 Dec" }], { forms: [] })
  const st = await drive(planned(), io(m, [{ tool: "click", id: "1" }]))
  assert.ok(st.log.some((l) => /^refused: «Sun 6 Dec» isn't the asked day/.test(l.result ?? "")))
})

test("dayNotes on: the day press goes, with the rule said once as a note the model reads next", async () => {
  const m = () => page([{ label: "Sun 6 Dec" }, { label: "Mon 7 Dec" }], { forms: [] })
  const x = io(m, [{ tool: "click", id: "1" }, { tool: "click", id: "2" }, { tool: "read_page" }], true)
  const st = await drive(planned(), x)
  assert.ok(!st.log.some((l) => /^refused:/.test(l.result ?? "")), st.log.map((l) => l.result).join(" | "))
  assert.deepEqual(x.acts.filter((a) => a.tool === "click").map((a) => a.id), ["1", "2"])
  assert.equal(st.log.filter((l) => /device note: «Sun 6 Dec» isn't the asked day/.test(l.result ?? "")).length, 1)
  assert.ok(!st.log.some((l) => /device note: «Mon 7 Dec»/.test(l.result ?? "")), "once a task per rule")
})

test("dayNotes on: a greyed day stays refused", async () => {
  const m = () => page([{ label: "Sun 6 Dec", state: ["disabled"] }, { label: "Mon 7 Dec" }], { forms: [] })
  const st = await drive(planned(), io(m, [{ tool: "click", id: "1" }], true))
  assert.ok(st.log.some((l) => /^refused: «Sun 6 Dec» is shown as not available/.test(l.result ?? "")))
})

test("dayNotes on: days unset — a note before the details, a refusal on the booking's last press", async () => {
  const early = () => page([{ label: "Sat 28 Nov", state: ["selected"] }, { label: "Continue" }], { forms: [] })
  const a = await drive(planned(), io(early, [{ tool: "click", id: "2", verdict: SUBMIT }], true))
  assert.ok(!refusedUnset(a), a.log.map((l) => l.result).join(" | "))
  const last = () => page([{ label: "Sat 28 Nov", state: ["selected"] }, { role: "textbox", label: "Name", lock: "personal", value: "Alex Test" }, { label: "Book" }])
  const b = await drive(planned(), io(last, [{ tool: "click", id: "3", verdict: SUBMIT }], true))
  assert.ok(refusedUnset(b), b.log.map((l) => l.result).join(" | "))
})

test("dayNotes on: a question before the page showed the day reaches the person", async () => {
  const m = () => page([{ label: "Choose a service" }], { forms: [] })
  const st = await drive(planned(), io(m, [{ tool: "ask_user", question: "Which day would you like?" }], true))
  assert.equal(st.status, "asked", st.log.map((l) => l.result).join(" | "))
})
