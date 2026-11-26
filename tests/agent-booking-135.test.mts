// The director's pass of the integration build on a real booking site: a place the person picked in the agent's own
// question was «not what you asked» (A); «I pressed Reserve… check your booking» when no booking press had gone (B).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { answer, confirmedOnPage, drive, lastDone, newState, nothingBooked, placeInReply, untouchedNear, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { requestWithAnswers, type PlanBooking, type TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const URL0 = "https://stays.example/hotel/pefkos.html?checkin=2026-12-04&checkout=2026-12-06"
const page = (items: PageMap["items"], text = "Pefkos City Hotel 2026-12-04 – 2026-12-06"): PageMap => ({ url: URL0, title: "Pefkos City Hotel", lang: "en", forms: [], more: 0, part: 1, parts: 1, text, items }) as PageMap
const HOTEL = page([
  { id: "1", role: "link", label: "Suite with Sea View", href: "/hotel/pefkos.html#room_1" },
  { id: "2", role: "link", label: "Condo Hotel The Palm Suites - Adults Only 8.8 Excellent 1 km from center Starting from € 210", href: "/hotel/palm-suites.html" },
  { id: "3", role: "link", label: "Limassol Seaview Residence 8.6 Fabulous 400 m from center", href: "/hotel/seaview.html" },
  { id: "4", role: "button", label: "I'll reserve" }
] as PageMap["items"])
const BOOKING: PlanBooking = { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0, personal: true, venue: "Pefkos City Hotel" }

function asked(): AgentState {
  const s = newState("a135", "Book a stay here for 2 nights from next Friday for 2 adults", "en", URL0)
  s.plan = { steps: [], questions: [{ q: "Which place?", options: ["Pefkos City Hotel", "Harbour View Suites"], fact: "venue", place: true }], perms: [], self: [], prices: [], approved: true, answers: [{ q: "Which place?", a: "Pefkos City Hotel" }], booking: { ...BOOKING } } as unknown as TaskPlan
  s.cardPlace = "Pefkos City Hotel"
  s.status = "asked"
  s.summary = "Pefkos City Hotel shows no free rooms for Dec 4–6. Which should I do?"
  return s
}
const io = (map: PageMap, replies: ActReply[] = []): RunnerIO & { bodies: any[] } => {
  const bodies: any[] = []
  return { bodies, map: async () => map, act: async () => ({ ok: true, note: "done" }), waitPage: async () => {}, ask: async (b) => { bodies.push(JSON.parse(JSON.stringify(b))); return replies.shift() ?? step({ tool: "ask_user", question: "?" }, "free", "read") }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30 }
}

test("A: a place the person picks in their answer to the agent's question is the booking's place from then on", async () => {
  const x = io(HOTEL)
  const st = await answer(asked(), x, "reply", ["Book The Palm Suites instead"])
  assert.equal(st.plan!.booking!.venue, "Condo Hotel The Palm Suites - Adults Only")
  assert.equal(st.cardPlace, "Condo Hotel The Palm Suites - Adults Only")
  assert.equal(st.plan!.answers![0].a, "Condo Hotel The Palm Suites - Adults Only", "the card's answer the check reads")
  // What the server (and its check) hears as the request now.
  assert.match(x.bodies[0].task.request, /Which place\? — Condo Hotel The Palm Suites - Adults Only/)
  assert.doesNotMatch(x.bodies[0].task.request, /Pefkos City Hotel/)
  assert.equal(requestWithAnswers(st.request, st.plan).includes("The Palm Suites"), true)
})

test("A: an answer naming a room, no place, or two places alike changes nothing", () => {
  const s = asked()
  assert.equal(placeInReply("Suite with Sea View, please", s, HOTEL), "", "a room row isn't a place")
  assert.equal(placeInReply("Try another date", s, HOTEL), "")
  assert.equal(placeInReply("The Limassol Seaview Residence", s, HOTEL), "Limassol Seaview Residence")
  const twins = page([{ id: "1", role: "link", label: "Palm Suites Limassol 8.1 Good", href: "/a" }, { id: "2", role: "link", label: "Palm Suites Paphos 8.4 Very good", href: "/b" }] as PageMap["items"])
  assert.equal(placeInReply("Book Palm Suites", s, twins), "", "a tie picks none")
})

test("B: a booking task that ends with no booking press says nothing was booked — no booked day, no event", async () => {
  const s = newState("b135", "Book a stay here for 2 nights from next Friday for 2 adults", "en", URL0)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { ...BOOKING } } as unknown as TaskPlan
  const x = io(HOTEL, [
    step({ tool: "click", id: "4", why: "Choosing a room at The Palm Suites" }, "free", "entry"),
    // (No day in done: the prompt has it only when the site confirmed a booking.)
    step({ tool: "done", summary: "I pressed Reserve for 2 nights, but the last pages didn't show a confirmation. Please check your booking.", date: "" } as ToolCall, "free", "read")
  ])
  const st = await drive(s, x)
  assert.equal(st.status, "done")
  assert.equal(st.error, "unbooked")
  assert.equal(st.booked, undefined)
  assert.equal(nothingBooked(st), true)
  assert.equal(lastDone(st), "Choosing a room at The Palm Suites")
  // With the booking's press gone, it's the model's summary as before.
  const t = { ...st, bookPress: { target: "button \"Complete booking\"", at: 1, yes: true } }
  assert.equal(nothingBooked(t), false)
})

test("B: the person's own press of the booking's last button (a payment) is the booking's press", async () => {
  const s = newState("b135b", "Book it", "en", URL0)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { ...BOOKING } } as unknown as TaskPlan
  s.status = "self"
  s.pending = { call: { tool: "click", id: "9", why: "Paying" }, verdict: { cls: "self", reason: "pay" }, target: "button \"Pay now\"" }
  const st = await answer(s, io(HOTEL), "did")
  assert.equal(st.bookPress?.yes, true)
})

test("B: the end card, the bubble and the away notification use the device's words when nothing was booked", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  const bubble = readFileSync(new URL("../src/content/agent/Bubble.tsx", import.meta.url), "utf8")
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(panel, /\{nothingBooked\(state\) \? \(\s*<>\s*<p>\{t\("agentNothingBooked"\)\}<\/p>/)
  assert.match(bubble, /const why = nothingBooked\(s\) \? t\("agentNothingBooked"\)/)
  assert.match(bg, /const done = nothingBooked\(state\) && away\.words\.notBooked \? away\.words\.notBooked : away\.words\.done/)
  assert.match(app, /notBooked: t\("agentNotifNotBooked", "\{0\}"\)/)
  for (const lang of ["en", "ru", "uk", "de", "fr", "es", "it", "pt_BR", "tr", "vi", "ar", "ja", "ko", "zh_CN", "zh_TW"]) {
    const d = JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8"))
    for (const k of ["agentNothingBooked", "agentLastDone", "agentNotifNotBooked"]) assert.ok(d[k], `${lang} ${k}`)
    assert.match(d.agentLastDone, /\{0\}/)
    assert.match(d.agentNotifNotBooked, /\{0\}/)
  }
})

test("smaller: a not-done line repeated for the same control shows once; prompt wording", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /!\(i > 0 && !l\.ok && !all\[i - 1\]\.ok && l\.tool === all\[i - 1\]\.tool && \(l\.target \?\? ""\) === \(all\[i - 1\]\.target \?\? ""\)\)/)
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /never what didn't work before it/)
  assert.match(act, /A press that only opens the booking's form, its rooms or its next page isn't the booking/)
  assert.match(act, /The summary never says a booking was made, sent or pressed unless the page showed it booked/)
})

// The director on ffb2b665: «Nothing was booked.» only with no sign of a booking at all.
async function endOf(doneCall: ToolCall, last: PageMap = HOTEL, press?: ActReply) {
  const s = newState("b136", "Book a table for 2 tomorrow at 19:30", "en", URL0)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "table", date: "2026-11-27", at: "19:30", from: "19:30", until: "19:30", minutes: 90 } } as unknown as TaskPlan
  const x = io(last, [...(press ? [press] : []), step(doneCall, "free", "read")])
  return drive(s, x)
}

test("B both ways: a booking press the classifier missed (a final «Continue» classed free) with the site's confirmed day in done — unsure, the model's summary stands", async () => {
  const st = await endOf({ tool: "done", summary: "Your table is booked for 19:30.", date: "2026-11-27", time: "19:30" } as ToolCall, HOTEL, step({ tool: "click", id: "4", why: "Continuing" }, "free", "nav"))
  assert.equal(st.status, "done")
  assert.equal(st.bookUnseen, true)
  assert.equal(nothingBooked(st), false, "never «Nothing was booked» then")
  assert.equal(st.error, undefined, "nor «Not finished»")
  assert.equal(st.summary, "Your table is booked for 19:30.")
  assert.equal(st.booked, undefined, "and no booked day or event asserted either")
  assert.equal(st.ruleCounts?.book_unseen, 1)
})

test("B both ways: no day in done, but the last page shows a confirmation — unsure too", async () => {
  const conf = page(HOTEL.items, "Thank you! Your reservation is confirmed. Reservation number 4821-993")
  const st = await endOf({ tool: "done", summary: "Booked.", date: "" } as ToolCall, conf)
  assert.equal(nothingBooked(st), false)
  assert.equal(st.bookUnseen, true)
})

test("B both ways: no press, no day, no confirmation — «Nothing was booked»; with the press recorded — booked as before", async () => {
  const none = await endOf({ tool: "done", summary: "I couldn't find a free table.", date: "" } as ToolCall)
  assert.equal(nothingBooked(none), true)
  assert.equal(none.error, "unbooked")
  assert.equal(none.ruleCounts?.book_unseen, undefined)
})

test("the confirmation words are narrow: a list's «booked 5 times» isn't one", () => {
  const p = (text: string) => page([], text)
  for (const yes of ["Your booking is confirmed", "Booking confirmed!", "Confirmation number: AB12", "Your table has been booked", "Номер бронирования: 123", "Бронирование подтверждено", "Ihre Buchung ist bestätigt", "Votre réservation est confirmée", "Reserva confirmada", "予約番号：123", "예약이 확정되었습니다", "预订成功"]) assert.equal(confirmedOnPage(p(yes)), true, yes)
  for (const no of ["Booked 5 times in the last 24 hours", "Забронировано 5 раз за последние 24 часа", "Greyed times are booked", "We have 1 left", "I'll reserve", "Confirm your booking"]) assert.equal(confirmedOnPage(p(no)), false, no)
})

test("C: a press that changed nothing names the choices beside it still at their first option or 0", async () => {
  const items = [
    { id: "r1", role: "combobox", label: "Select rooms", options: ["0", "1 (€ 210)", "2 (€ 420)"], value: "0", form: 3 },
    { id: "r2", role: "combobox", label: "Select rooms", options: ["0", "1 (€ 223)"], value: "1 (€ 223)", form: 3 },
    { id: "r9", role: "button", label: "I'll reserve", form: 3 },
    { id: "x1", role: "combobox", label: "Currency", options: ["EUR", "USD"], value: "EUR", form: 1 }
  ] as PageMap["items"]
  const m = page(items)
  assert.deepEqual(untouchedNear(m, "r9"), ["«Select rooms» (0)"], "the same form's untouched choice only")
  // Through a run: the press's log line says so.
  const s = newState("c136", "Book a stay", "en", URL0)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { ...BOOKING } } as unknown as TaskPlan
  const x: RunnerIO = { ...io(m, [step({ tool: "click", id: "r9", why: "Choosing a room" }, "free", "entry"), step({ tool: "done", summary: "x", date: "" } as ToolCall, "free", "read")]), act: async () => ({ ok: true, note: "nothing changed on the page" }) }
  const st = await drive(s, x)
  const entry = st.log.find((e) => e.call.id === "r9")!
  assert.match(entry.result, /^nothing changed on the page; beside it, still at their first option: «Select rooms» \(0\) — set the one the request needs/)
})

test("smaller (10eed066): a 12-hour time the model wrote shows in the request's form; the person's details are «your»", async () => {
  const { clockFrom, twelveToClock } = await import("../src/content/agent/clockform.ts")
  clockFrom("Book a table at Hawksmoor Air Street for 2 tomorrow at 19:00")
  assert.equal(twelveToClock("You can pick Fri, Nov 27 for 2 people at 7:00 PM on the page"), "You can pick Fri, Nov 27 for 2 people at 19:00 on the page")
  assert.equal(twelveToClock("at 7 pm, or 12:30 a.m."), "at 19:00, or 00:30")
  assert.equal(twelveToClock("Room 7 Pmax and 10 apples"), "Room 7 Pmax and 10 apples")
  clockFrom("Book a table at 7:30 pm")
  assert.match(twelveToClock("at 7:00 PM"), /7:00\s?PM/i)
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /return twelveToClock\(daysAsIso\(text, todayIso\(\)\)\)/)
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /«Filling in your e-mail», never «my e-mail» or «my saved e-mail»/)
  assert.match(act, /the person's details are theirs \("Filling in your e-mail", never "my e-mail"\)/)
})
