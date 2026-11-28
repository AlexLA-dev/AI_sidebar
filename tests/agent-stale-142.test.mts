// Round 142, the director's answer on phone-late-GB: (d) a page's message about a field is from before the field was
// changed — the device says so once and sends a contact question about that field back once; a booking press the page
// bounced (a field marked invalid) books nothing and the next press is asked again, with why.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { withDial } from "./helpers/dialfake.mts"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { answer, drive, fieldMessages, newState, recapOf, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

const OPTS = ["Guernsey (+44)", "United Kingdom (+44)"]
const page = (value: string, invalid: boolean, msg = invalid ? "Please enter a valid phone number" : "", booked = false): PageMap => ({
  url: "https://salon.example/book", title: "Your booking", lang: "en", more: 0, part: 1, parts: 1, forms: [{ n: 1, fillable: true }],
  text: `Your booking\nMen's haircut · Fri, 4 Dec 2026, 18:30\n${msg}${booked ? "\nBooked" : ""}`,
  items: [
    { id: "1", role: "select", label: "Country code", options: OPTS, value, form: 1 },
    { id: "2", role: "textbox", label: "Telephone number", type: "tel", form: 1, ...(invalid ? { state: ["invalid"] } : {}) },
    { id: "3", role: "button", label: "Book", type: "submit", form: 1 }
  ] as MapItem[]
}) as PageMap

/** A page that checks the phone only on «Book»: Guernsey refuses the number; the message stays until the next press. */
function late() {
  const s = { country: "Guernsey (+44)", typed: "", presses: 0, booked: false, msg: "" }
  const map = () => page(s.country, !!s.msg, s.msg, s.booked)
  const acts: ToolCall[] = []
  const act = async (c: ToolCall) => {
    acts.push(c)
    if (c.tool === "select") s.country = c.option ?? s.country
    if (c.tool === "type") s.typed = c.text ?? ""
    if (c.tool === "click" && c.id === "3") {
      s.presses++
      if (s.country.startsWith("Guernsey")) s.msg = "Please enter a valid phone number"
      else { s.msg = ""; s.booked = true }
    }
    return { ok: true, note: "typed" }
  }
  return { s, map, act, acts }
}
const io = (p: ReturnType<typeof late>, calls: Array<Record<string, unknown>>): RunnerIO => {
  const replies = calls.map((c) => ({ ok: true, call: { why: "", ...c } as unknown as ToolCall, verdict: c.tool === "click" ? { cls: "confirm", reason: "submit" } : { cls: "free", reason: "type" } }))
  return {
    map: async () => p.map(), act: p.act, waitPage: async () => {},
    ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 10, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
}
const withBooking = (st: AgentState) => {
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment", date: "2026-12-04", personal: false, from: "09:00", until: "21:00", minutes: 45 } } as never
  return st
}

test("a bounced booking press books nothing; the next press goes to the person's card, its recap says why it's asked again", async () => {
  const p = late()
  const x = io(p, [{ tool: "type", id: "2", text: "+44 7700 900123" }, { tool: "click", id: "3" }, { tool: "click", id: "3" }])
  let st = await drive(withBooking(newState("b1", "Book. Phone +44 7700 900123.", "en", p.map().url)), withDial(x))
  assert.equal(st.status, "confirm", "the first press: its card")
  st = await answer(st, withDial(x), "yes")
  assert.equal(st.bookPress, undefined, "the bounced press isn't the booking")
  assert.match(st.log.find((l) => /the page refused it/.test(l.result ?? ""))?.result ?? "", /«Telephone number» is marked invalid — nothing was booked/)
  assert.equal(p.s.country, "United Kingdom (+44)", "15b: the other option, once")
  assert.equal(st.status, "confirm", "the second press: a card again, not «booking press again»")
  assert.ok(!st.log.some((l) => /the booking's press already went/.test(l.result ?? "")))
  assert.deepEqual(st.pending?.recap?.again, { field: "Telephone number", to: "United Kingdom (+44)" })
  st = await answer(st, withDial(x), "yes")
  assert.equal(p.s.booked, true)
  assert.ok(st.bookPress, "the press after the fix is the booking")
})

test("a press after a real «booked» page is still refused", async () => {
  const p = late()
  p.s.country = "United Kingdom (+44)"
  const x = io(p, [{ tool: "type", id: "2", text: "+44 7700 900123" }, { tool: "click", id: "3" }, { tool: "click", id: "3" }])
  let st = await drive(withBooking(newState("b2", "Book. Phone +44 7700 900123.", "en", p.map().url)), withDial(x))
  st = await answer(st, withDial(x), "yes")
  assert.ok(st.bookPress)
  assert.ok(st.log.some((l) => /^refused: the booking's press already went/.test(l.result ?? "")), JSON.stringify(st.log.map((l) => l.result)))
})

test("15d: the old message is said once; a question about the field right then is sent back once, the next reaches the person", async () => {
  const p = late()
  const q = { tool: "ask_user", question: "The page says the phone number isn't valid. Which number should I use?" }
  const x = io(p, [{ tool: "type", id: "2", text: "+44 7700 900123" }, { tool: "click", id: "3" }, q, q])
  let st = await drive(withBooking(newState("b3", "Book. Phone +44 7700 900123.", "en", p.map().url)), withDial(x))
  st = await answer(st, withDial(x), "yes")
  const sent = st.log.filter((l) => /^refused: the page's message about «Telephone number» is from before it was changed to «United Kingdom \(\+44\)»/.test(l.result ?? ""))
  assert.equal(sent.length, 1)
  assert.equal(st.status, "asked", "the second question reaches the person")
})

test("fieldMessages reads the page's refusal in its words, in four scripts", () => {
  const m = (text: string) => fieldMessages({ text } as PageMap)
  assert.equal(m("Your booking\nPlease enter a valid phone number"), "Please enter a valid phone number")
  assert.equal(m("Бронь\nВведите корректный номер телефона"), "Введите корректный номер телефона")
  assert.equal(m("ご予約\n正しい電話番号を入力してください"), "正しい電話番号を入力してください")
  assert.equal(m("حجزك\nيرجى إدخال رقم هاتف صالح"), "يرجى إدخال رقم هاتف صالح")
  assert.equal(m("Your booking\nTable for 2"), "")
})

test("the «asked again» recap line exists in the 15 languages (four scripts checked by their words)", () => {
  for (const [loc, word] of [["en", "Asked again"], ["ru", "Спрашиваю снова"], ["ja", "もう一度確認します"], ["ar", "سؤال مجدد"], ["de", "Erneut"], ["zh_CN", "再次确认"], ["ko", "다시"], ["vi", "Hỏi lại"], ["tr", "Yeniden"], ["uk", "Питаю знову"], ["fr", "Nouvelle"], ["es", "Se pregunta"], ["it", "Chiedo"], ["pt_BR", "Pergunto"], ["zh_TW", "再次確認"]]) {
    const l = JSON.parse(readFileSync(new URL(`../src/locales/${loc}.json`, import.meta.url), "utf8"))
    assert.ok(l.agentRecapAgain?.includes("{0}") && l.agentRecapAgain.includes(word), `${loc} agentRecapAgain`)
    assert.ok(l.agentRecapAgainTo?.includes("{0}") && l.agentRecapAgainTo.includes("{1}"), `${loc} agentRecapAgainTo`)
  }
})

test("recapOf carries the again line only while the press is a bounced one's retry", () => {
  const st = withBooking(newState("b4", "Book.", "en", "https://salon.example/book"))
  assert.equal(recapOf(st, page("United Kingdom (+44)", false), true)?.again, undefined)
  st.bounced = { target: "button \"Book\"", field: "Telephone number" }
  st.staleFix = { fieldId: "2", label: "Telephone number", kind: "phone", msg: "x", to: "United Kingdom (+44)" }
  assert.deepEqual(recapOf(st, page("United Kingdom (+44)", false), true)?.again, { field: "Telephone number", to: "United Kingdom (+44)" })
})
