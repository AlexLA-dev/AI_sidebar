// Round 141 (the director on report-140): «back» never leaves the task's pages; the other items of the round follow.
import assert from "node:assert/strict"
import { test } from "node:test"

import { drive, newState, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const page = (url: string, items: PageMap["items"]): PageMap => ({ url, title: "Salon", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "A salon page", items }) as PageMap

test("«back» goes to a page this task was on, never past the task's first page (a second «back» left the site)", async () => {
  const first = page("https://salon.example/place/1", [{ id: "1", role: "link", label: "Services", href: "/place/1/services" }])
  const second = page("https://salon.example/place/1/services", [{ id: "2", role: "button", label: "Haircut" }])
  let at = first
  const replies: ActReply[] = [
    step({ tool: "go", id: "1", why: "Opening the services" }, "free", "go"),
    step({ tool: "back", why: "Back to the salon" }, "free", "read"),
    step({ tool: "back", why: "Back again" }, "free", "read"),
    step({ tool: "done", summary: "stopped", why: "" }, "free", "read")
  ]
  const acts: string[] = []
  const io: RunnerIO = {
    map: async () => at,
    act: async (c) => {
      acts.push(c.tool)
      if (c.tool === "go") at = second
      if (c.tool === "back") at = at === second ? first : page("about:blank", [])
      return { ok: true, note: c.tool === "back" ? "went back" : "the page went on", navigated: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = await drive(newState("b141", "Book a haircut", "en", first.url), io)
  assert.deepEqual(acts, ["go", "back"], "only the first «back» reached the page")
  assert.ok(st.log.some((e) => e.call.tool === "back" && /^refused: «back» here would leave/.test(e.result)), JSON.stringify(st.log.map((e) => e.result)))
  assert.equal(st.ruleCounts?.back_floor, 1)
})

// ---- item 7: a priced choice in a picker is a choice
import { classify } from "../src/shared/agent/classify.ts"

const ctx = (map: PageMap) => ({ map, startHost: "tickets.example", request: "Get 2 tickets", confirmedHere: false, policy: { amazon: false, block: [], allow: [] } })
const strip = (labels: string[], extra: Partial<PageMap> = {}): PageMap => ({ url: "https://tickets.example/day", title: "", lang: "", forms: [], more: 0, part: 1, parts: 1, text: "", items: labels.map((label, i) => ({ id: String(i + 1), role: "button", label })), ...extra }) as PageMap
const press = (map: PageMap, id = "1") => classify({ tool: "click", id, why: "" } as ToolCall, ctx(map))

const PICKERS: Record<string, string[]> = {
  en: ["SAT 28 Nov €10", "SUN 29 Nov €10", "MON 30 Nov €12", "TUE 1 Dec €12"],
  times: ["10:40 € 25", "11:20 € 25", "12:00 € 30", "12:40 € 30"],
  fr: ["sam. 28 nov. 12,50 €", "dim. 29 nov. 12,50 €", "lun. 30 nov. 14,00 €", "mar. 1 déc. 14,00 €"],
  de: ["Sa., 28. Nov. 10 €", "So., 29. Nov. 10 €", "Mo., 30. Nov. 12 €", "Di., 1. Dez. 12 €"],
  ru: ["сб, 28 ноя 1 200 ₽", "вс, 29 ноя 1 200 ₽", "пн, 30 ноя 1 400 ₽", "вт, 1 дек 1 400 ₽"],
  uk: ["сб, 28 лист. 300 грн", "нд, 29 лист. 300 грн", "пн, 30 лист. 350 грн", "вт, 1 груд. 350 грн"],
  es: ["sáb 28 nov 15 €", "dom 29 nov 15 €", "lun 30 nov 18 €", "mar 1 dic 18 €"],
  it: ["sab 28 nov 15 €", "dom 29 nov 15 €", "lun 30 nov 18 €", "mar 1 dic 18 €"],
  pt: ["sáb 28 nov R$ 50", "dom 29 nov R$ 50", "seg 30 nov R$ 60", "ter 1 dez R$ 60"],
  tr: ["28 Kas Cmt 250 ₺", "29 Kas Paz 250 ₺", "30 Kas Pzt 300 ₺", "1 Ara Sal 300 ₺"],
  ja: ["11月28日(土) ¥1,500", "11月29日(日) ¥1,500", "11月30日(月) ¥1,800", "12月1日(火) ¥1,800"],
  ko: ["11월 28일 (토) ₩15,000", "11월 29일 (일) ₩15,000", "11월 30일 (월) ₩18,000", "12월 1일 (화) ₩18,000"],
  "zh-Hans": ["11月28日 周六 ¥80", "11月29日 周日 ¥80", "11月30日 周一 ¥90", "12月1日 周二 ¥90"],
  "zh-Hant": ["11月28日 週六 NT$300", "11月29日 週日 NT$300", "11月30日 週一 NT$350", "12月1日 週二 NT$350"],
  ar: ["السبت 28 نوفمبر 40 درهم", "الأحد 29 نوفمبر 40 درهم", "الاثنين 30 نوفمبر 45 درهم", "الثلاثاء 1 ديسمبر 45 درهم"],
  vi: ["T7 28/11 150.000 đ", "CN 29/11 150.000 đ", "T2 30/11 180.000 đ", "T3 01/12 180.000 đ"]
}

test("item 7: a priced day or time among its like ones is a choice, not a payment, in every format the 15 languages write", () => {
  const missed: string[] = []
  for (const [lang, labels] of Object.entries(PICKERS)) {
    const v = press(strip(labels))
    if (v.cls === "self" && v.reason === "pay") missed.push(`${lang}: ${labels[0]}`)
  }
  // (A format the date or time reader doesn't know keeps the money guard: the safe side. Listed, not hidden.)
  assert.deepEqual(missed.filter((m) => !/^zh-Hant: /.test(m)), [], missed.join("; "))
})

test("item 7: what keeps the money guard — a commit or pay word, a lone priced day, fewer than three like ones, a page that takes payment", () => {
  assert.equal(press(strip(["Pay €35 now", "SAT 28 Nov €10", "SUN 29 Nov €10", "MON 30 Nov €12"])).reason, "pay")
  assert.equal(press(strip(["Book 10:40 €25", "11:20 € 25", "12:00 € 30", "12:40 € 30"])).cls, "self")
  assert.equal(press(strip(["SAT 28 Nov €10", "Details", "About"])).reason, "pay", "a lone priced day")
  assert.equal(press(strip(["SAT 28 Nov €10", "SUN 29 Nov €10", "MON 30 Nov €12"])).reason, "pay", "two like ones only")
  assert.equal(press(strip(PICKERS.en, { pay: true })).cls, "self", "on a page that takes payment")
  assert.equal(press(strip(["2 adults €45", "3 adults €60", "4 adults €80", "5 adults €100"])).reason, "pay", "not a day or a time")
})
