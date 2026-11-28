// Round 142, the director's decision 14: a window's days are all asked days (bookings that aren't by days), and S1: a
// field whose label asks for the whole name takes the full name, in the 15 languages.
import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { dateStep, drive, newState, offeredDays, recapOf, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { fieldKind } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const page = (labels: string[], over: Partial<PageMap> = {}): PageMap => ({ url: "https://salon.example/book", title: "Book", lang: "en", more: 0, part: 1, parts: 1, forms: [], text: "Choose a day",
  items: labels.map((label, i) => ({ id: String(i + 1), role: "button", label })), ...over }) as PageMap
const withPlan = (booking: Record<string, unknown>): AgentState => {
  const st = newState("w14", "Book a men's haircut this week", "en", "https://salon.example/book")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment", personal: false, from: "09:00", until: "21:00", minutes: 45, ...booking } } as never
  return st
}
const press = (st: AgentState, map: PageMap, label: string) => dateStep(st, map, map.items.find((i) => i.label === label)!, { tool: "click", id: "x", why: "" } as ToolCall)

const STRIPS: Record<string, [string, string]> = {
  en: ["Sun 29 Nov", "Mon 30 Nov"],
  ru: ["29 ВС НОЯБ.", "30 ПН НОЯБ."],
  ja: ["11月29日(日)", "11月30日(月)"],
  ar: ["الأحد 29 نوفمبر", "الاثنين 30 نوفمبر"]
}

test("14a: a strip offering only later days of the window — the earliest is pressed with no refusal (en, ru, ja, ar)", () => {
  for (const [lang, [d29, d30]] of Object.entries(STRIPS)) {
    const st = withPlan({ date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
    assert.equal(press(st, page([d29, d30]), d29), null, lang)
    assert.equal(st.picked?.date, "2026-11-29", lang)
    assert.equal(st.sawDate, true, lang)
  }
})

test("14a: a later window day while an earlier one is offered and untried — sent back once, naming it", () => {
  const st = withPlan({ date: "2026-11-27", dayLast: "2026-12-03", window: "next_days", windowDays: 7 })
  const map = page(["Sat 28 Nov", "Sun 29 Nov", "Mon 30 Nov"])
  assert.match(press(st, map, "Sun 29 Nov") ?? "", /offers an earlier day in it, «Sat 28 Nov»/)
  assert.equal(press(st, map, "Sun 29 Nov"), null, "once: the second press goes")
})

test("14a: distinct window days in ascending order walk the window; a repeat still counts", () => {
  const st = withPlan({ date: "2026-11-27", dayLast: "2026-12-03", window: "next_days", windowDays: 7 })
  const map = page(["Sat 28 Nov", "Sun 29 Nov", "Mon 30 Nov", "Tue 1 Dec"])
  for (const d of ["Sat 28 Nov", "Sun 29 Nov", "Mon 30 Nov", "Tue 1 Dec"]) assert.equal(press(st, map, d), null, d)
  assert.match(press(st, map, "Tue 1 Dec") ?? "", /was pressed already/)
  assert.equal(press(st, map, "Sat 28 Nov"), null, "back to an earlier day: counted (1)")
  assert.equal(press(st, map, "Sun 29 Nov"), null, "counted (2)")
  assert.match(press(st, map, "Sat 28 Nov") ?? "", /two date steps went nowhere/)
})

test("14a: one asked day (no window) and a stay — every refusal as before", () => {
  const one = withPlan({ date: "2026-11-27" })
  assert.match(press(one, page(["Sun 29 Nov", "Mon 30 Nov"]), "Sun 29 Nov") ?? "", /isn't the asked day/)
  const stay = withPlan({ kind: "stay", date: "2026-11-27", dateEnd: "2026-11-29", dayLast: "2026-12-03", window: "next_days" })
  assert.match(press(stay, page(["Sat 28 Nov", "Sun 29 Nov"]), "Sat 28 Nov") ?? "", /isn't a day of this stay/)
})

test("14a: the booking's recap names the day actually chosen when it isn't the plan's first day", () => {
  const st = withPlan({ date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
  const map = page(["Sun 29 Nov", "Mon 30 Nov"])
  press(st, map, "Sun 29 Nov")
  const r = recapOf(st, map, true)
  assert.equal(r?.date, "2026-11-29")
  assert.equal(r?.askedDate, "2026-11-27")
})

// 14b, 14c through the runner.
const run = async (map: PageMap, calls: Array<Record<string, unknown>>, booking: Record<string, unknown>) => {
  const sent: any[] = []
  const replies = calls.map((call) => ({ ok: true, call: { why: "", ...call } as unknown as ToolCall, verdict: { cls: "free", reason: "read" } }))
  const io = {
    map: async () => map, act: async () => ({ ok: true }), waitPage: async () => {},
    ask: async (body: unknown) => { sent.push(JSON.parse(JSON.stringify(body))); return replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 8, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  const st = withPlan(booking)
  return { st: await drive(st, io), sent }
}

test("14b: a strip without the window's first day is the page's answer — sawDate, and a device line with the window's offered days", async () => {
  const { st, sent } = await run(page(["29 ВС НОЯБ.", "30 ПН НОЯБ."], { lang: "ru" }), [], { date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
  assert.equal(st.sawDate, true)
  assert.match(sent[0].refused ?? "", /doesn't offer Fri(day)?,? 27 Nov.*the days it offers in the request's window: «29 ВС НОЯБ\.»/)
})

test("14b: a calendar parked two months ahead isn't an answer — as before", async () => {
  const { st, sent } = await run(page(["Tue 26 Jan", "Wed 27 Jan"]), [], { date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
  assert.notEqual(st.sawDate, true)
  assert.doesNotMatch(sent[0].refused ?? "", /doesn't offer/)
})

test("14c: no window day on the page — the question naming the page's nearest day passes at once (en, ru, ja, ar)", async () => {
  const cases: Array<[string, string[], string]> = [
    ["en", ["Mon 30 Nov", "Tue 1 Dec"], "There's no free time this week. Book Mon 30 Nov instead?"],
    ["ru", ["30 ПН НОЯБ.", "1 ВТ ДЕК."], "На этой неделе свободного времени нет. Записать на 30 ноября?"],
    ["ja", ["11月30日(月)", "12月1日(火)"], "今週は空きがありません。11月30日に予約しますか？"],
    ["ar", ["الاثنين 30 نوفمبر", "الثلاثاء 1 ديسمبر"], "لا يوجد وقت متاح هذا الأسبوع. هل أحجز يوم 30 نوفمبر؟"]
  ]
  for (const [lang, labels, question] of cases) {
    const { st, sent } = await run(page(labels, { lang }), [{ tool: "ask_user", question }], { date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
    assert.equal(st.status, "asked", lang)
    assert.match(sent[0].refused ?? "", /none in the request's window; the page's nearest day is/, lang)
    assert.ok(!st.log.some((l) => /^refused/.test(l.result ?? "")), `${lang}: no refusal`)
  }
})

test("offeredDays leaves out greyed days and sorts", () => {
  const map = page(["Mon 30 Nov", "Sun 29 Nov"])
  map.items[1].state = ["disabled"]
  assert.deepEqual(offeredDays(map, "2026-11-27").map((o) => o.date), ["2026-11-30"])
})

test("S1: a field asking for the whole name takes the full name, in the 15 languages; a first-name field as before", () => {
  const full = ["Full name", "Полное имя", "ФИО", "Повне ім'я", "Vollständiger Name", "Nom complet", "Nombre completo", "Nome completo", "Nome completo", "Ad Soyad", "氏名", "성명", "姓名", "全名", "Họ và tên", "الاسم الكامل"]
  for (const label of full) assert.equal(fieldKind({ label } as never, null), "name.full", label)
  for (const label of ["First name", "Имя", "Vorname", "Prénom", "Nombre", "Nome", "Ad", "名", "이름"]) assert.equal(fieldKind({ label } as never, null), "name.given", label)
  assert.equal(fieldKind({ label: "Apellidos" } as never, null), "name.family")
  assert.equal(fieldKind({ label: "Nombre y apellidos" } as never, null), "name.full")
})

test("14c: the true question passes even where the page names its next free day (the nudge for one asked day stays)", async () => {
  const map = page(["Mon 30 Nov", "Tue 1 Dec"], { text: "Next available: Mon 30 Nov" })
  const q = { tool: "ask_user", question: "There's no free time this week. Book Mon 30 Nov instead?" }
  const win = await run(map, [q], { date: "2026-11-27", dayLast: "2026-11-29", window: "this_week" })
  assert.equal(win.st.status, "asked")
  assert.ok(!win.st.log.some((l) => /^refused: the page names its next free day/.test(l.result ?? "")), "no nudge in a window with no day")
  // Only once a task: a second such question meets the rules as before.
  assert.equal(win.st.windowAsked, true)
})
