// The director's pass of the integration build on a real booking site: a place the person picked in the agent's own
// question was «not what you asked» (A); «I pressed Reserve… check your booking» when no booking press had gone (B).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { answer, drive, lastDone, newState, nothingBooked, placeInReply, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
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
    step({ tool: "done", summary: "I pressed Reserve for 2 nights, but the last pages didn't show a confirmation. Please check your booking.", date: "2026-12-04" } as ToolCall, "free", "read")
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
