// The director's pass on d05b60bb: after «Your stay is booked» the agent asked «Do it? Press "Reserve"» again (Q1); after
// the card's place answer it asked «Which stay should I book…» again (Q2).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { answer, approvePlan, asksSame, drive, newState, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PlanBooking, TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const step = (call: ToolCall, cls: "free" | "confirm", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const done = (summary = "Booked."): ActReply => step({ tool: "done", summary }, "free", "read")

/** A stand: the page the hands show changes as presses go (`after[id]` is the page after pressing that control). */
function stand(first: PageMap, after: Record<string, PageMap>, replies: ActReply[]) {
  let page = first
  const acted: ToolCall[] = []
  const io: RunnerIO & { acted: ToolCall[] } = {
    acted,
    map: async () => page,
    act: async (c) => {
      acted.push(c)
      if (c.tool === "click" && c.id && after[c.id]) page = after[c.id]
      return { ok: true, note: "done" }
    },
    waitPage: async () => {},
    ask: async () => replies.shift() ?? done(),
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30
  }
  return io
}

function running(url: string, booking: PlanBooking, perms: TaskPlan["perms"] = []): AgentState {
  const s = newState("t132", "Book it", "en", url)
  s.plan = { steps: [], questions: [], perms, self: [], prices: [], approved: true, booking } as unknown as TaskPlan
  return s
}
const page = (url: string, title: string, text: string, items: PageMap["items"]): PageMap => ({ url, title, lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text, items }) as PageMap
const presses = (io: { acted: ToolCall[] }, id: string) => io.acted.filter((c) => c.tool === "click" && c.id === id).length

// A stay: Reserve → guest details on the same page → Complete booking; success on the same page (the stand's /stay).
const STAY = "https://stays.example/stay?id=3&in=2026-12-04&out=2026-12-06"
const stayItems = [
  { id: "3", role: "button", label: "Reserve" },
  { id: "7", role: "combobox", label: "Guests", options: ["1", "2"], form: 0 },
  { id: "6", role: "button", label: "Complete booking", form: 0 }
] as PageMap["items"]
const STAY_FORM = page(STAY, "Old Town Guesthouse", "Old Town Guesthouse 2026-12-04 – 2026-12-06 Guest details", stayItems)
const STAY_BOOKED = page(STAY, "Old Town Guesthouse", "Old Town Guesthouse 2026-12-04 – 2026-12-06 Guest details Your stay is booked", stayItems)
const STAY_BOOKING: PlanBooking = { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0 }

test("Q1 stay, same page: after the person's yes to the booking's press, «Reserve» isn't pressed or asked again; done ends it", async () => {
  // The plan carries a press the page doesn't have («Book now»: run 1's raw plan) — no nudge to press something after.
  const s = running(STAY, STAY_BOOKING, [{ id: "p1", kind: "press", reason: "submit", label: "Book now", host: "stays.example", on: true }] as TaskPlan["perms"])
  const io = stand(STAY_FORM, { "6": STAY_BOOKED }, [
    step({ tool: "click", id: "6", why: "Completing the booking" }, "confirm", "submit"),
    step({ tool: "click", id: "3", why: "Pressing Book now as the plan allows" }, "confirm", "submit"),
    done("Your stay at Old Town Guesthouse is booked.")
  ])
  let st = await drive(s, io)
  assert.equal(st.status, "confirm")
  assert.ok(st.pending?.recap, "the booking's «Do it?» says what it books")
  st = await answer(st, io, "yes")
  assert.equal(st.status, "done", "no second «Do it?»")
  assert.equal(presses(io, "6"), 1)
  assert.equal(presses(io, "3"), 0, "«Reserve» never pressed after the booking")
  const refused = st.log.find((e) => e.call.tool === "click" && e.call.id === "3")
  assert.match(refused!.result, /^refused: the booking's press already went: .* with the person's yes, and this page now shows: ".*Your stay is booked/)
  assert.ok(!st.log.some((e) => /the plan's press "Book now" hasn't happened/.test(e.result)), "no «press Book now» nudge after the booking")
})

test("Q1 stay, two presses: Reserve (yes) → details → Complete booking (yes) still books", async () => {
  const s = running(STAY, STAY_BOOKING)
  const io = stand(STAY_FORM, { "6": STAY_BOOKED }, [
    step({ tool: "click", id: "3", why: "Reserving" }, "confirm", "submit"),
    step({ tool: "select", id: "7", value: "2", why: "Two guests" } as ToolCall, "free", "read"),
    step({ tool: "click", id: "6", why: "Completing the booking" }, "confirm", "submit"),
    done()
  ])
  let st = await drive(s, io)
  assert.equal(st.status, "confirm")
  st = await answer(st, io, "yes")
  assert.equal(st.status, "confirm", "the form asked for more after the first press: its own press is asked")
  assert.equal(st.pending?.call.id, "6")
  st = await answer(st, io, "yes")
  assert.equal(st.status, "done")
  assert.equal(presses(io, "6"), 1)
})

test("Q1 table, by the plan's permission: the press the plan allowed is the booking's; a second one is refused", async () => {
  const TABLE = "https://tables.example/booking"
  const items = [{ id: "5", role: "combobox", label: "Time", options: ["19:00"], form: 0 }, { id: "9", role: "button", label: "Book", form: 0 }] as PageMap["items"]
  const form = page(TABLE, "Book a table", "Trattoria Sole 2026-11-27 19:00 2 people", items)
  const booked = page(TABLE, "Book a table", "Trattoria Sole 2026-11-27 19:00 2 people Your table is booked", items)
  const s = running(TABLE, { kind: "table", date: "2026-11-27", at: "19:00", from: "19:00", until: "19:00", minutes: 90 }, [{ id: "p1", kind: "press", reason: "submit", label: "Book", ids: ["9"], host: "tables.example", on: true }] as TaskPlan["perms"])
  const io = stand(form, { "9": booked }, [
    step({ tool: "click", id: "9", why: "Booking the table" }, "confirm", "submit"),
    step({ tool: "click", id: "9", why: "Booking the table" }, "confirm", "submit"),
    done()
  ])
  const st = await drive(s, io)
  assert.equal(st.status, "done", "no card: the plan allowed it, and no recap was needed")
  assert.equal(st.bookPress?.yes, false, "the plan's permission stood for the recap")
  assert.equal(presses(io, "9"), 1, "booked once")
  assert.ok(st.log.some((e) => /^refused: the booking's press already went/.test(e.result)))
})

test("Q1 doctor's slot, a confirmation page: «Book another appointment» there isn't pressed or asked", async () => {
  const SLOT = "https://clinic.example/doctor/7?date=2026-11-30"
  const slot = page(SLOT, "Dr. Lee", "Dr. Lee 2026-11-30 10:30 General check-up", [{ id: "4", role: "button", label: "Book appointment", form: 0 }] as PageMap["items"])
  const confirmed = page("https://clinic.example/confirmation/88", "Appointment confirmed", "Your appointment with Dr. Lee on 2026-11-30 at 10:30 is confirmed", [{ id: "2", role: "button", label: "Book another appointment" }] as PageMap["items"])
  const s = running(SLOT, { kind: "appointment", date: "2026-11-30", at: "10:30", from: "10:30", until: "10:30", minutes: 30, venue: "Dr. Lee" })
  const io = stand(slot, { "4": confirmed }, [
    step({ tool: "click", id: "4", why: "Booking the slot" }, "confirm", "submit"),
    step({ tool: "click", id: "2", why: "Booking it" }, "confirm", "submit"),
    done("Booked with Dr. Lee.")
  ])
  let st = await drive(s, io)
  assert.equal(st.status, "confirm")
  st = await answer(st, io, "yes")
  assert.equal(st.status, "done")
  assert.equal(presses(io, "2"), 0)
  assert.match(st.log.find((e) => e.call.id === "2")!.result, /this page now shows: "Appointment confirmed: Your appointment with Dr\. Lee/)
})

test("Q1: a model that keeps pressing ends the task done after three refusals, never a loop", async () => {
  const s = running(STAY, STAY_BOOKING)
  const again = () => step({ tool: "click", id: "3", why: "Reserve" }, "confirm", "submit")
  const io = stand(STAY_FORM, { "6": STAY_BOOKED }, [step({ tool: "click", id: "6", why: "Completing" }, "confirm", "submit"), again(), again(), again(), again()])
  let st = await drive(s, io)
  st = await answer(st, io, "yes")
  assert.equal(st.status, "done")
  assert.equal(presses(io, "3"), 0)
})

// Q2: the place answered on the card.
const LIST = "https://stays.example/stays?in=2026-12-04&out=2026-12-06"
const listItems = ["Harbour View Suites", "Olive Grove Apartments", "Old Town Guesthouse", "Palm Court Residences"].map((label, i) => ({ id: String(i + 1), role: "link", label })) as PageMap["items"]
const LIST_PAGE = page(LIST, "Stays in Limassol", "Stays in Limassol 2026-12-04 – 2026-12-06", listItems)

async function afterCard(replies: ActReply[], dead?: string[]) {
  const s = newState("q2", "Book a stay for 2 nights from next Friday", "en", LIST)
  s.status = "plan"
  s.plan = { steps: ["Asking you which stay to book"], questions: [{ q: "Which stay should I book?", options: ["Old Town Guesthouse", "Harbour View Suites", "Olive Grove Apartments"], fact: "venue", place: true }], perms: [], self: [], prices: [], booking: { ...STAY_BOOKING, personal: true } } as unknown as TaskPlan
  if (dead) s.dead = dead
  const io = stand(LIST_PAGE, {}, replies)
  return approvePlan(s, io, { answers: ["Old Town Guesthouse"], off: [] })
}

test("Q2: with the place answered on the card, «Which stay should I book…» again is refused with the answer", async () => {
  const st = await afterCard([
    step({ tool: "ask_user", question: "Which stay should I book for Fri, Dec 4 – Sun, Dec 6? Harbour View Suites (8.9), Old Town Guesthouse (9.0), or Palm Court Residences?", choices: ["Harbour View Suites, €96/night", "Old Town Guesthouse, €88/night", "Palm Court Residences, €142/night"] } as ToolCall, "free", "read"),
    done()
  ])
  assert.equal(st.cardPlace, "Old Town Guesthouse")
  assert.notEqual(st.status, "asked")
  assert.match(st.log.find((e) => e.call.tool === "ask_user")!.result, /^refused: the person already chose the place on the plan card: «Old Town Guesthouse»/)
})

test("Q2: asked again when it says what's wrong with the chosen place (not offered again), or its tap did nothing", async () => {
  const why = await afterCard([step({ tool: "ask_user", question: "Old Town Guesthouse has no rooms for Dec 4–6. Which other stay?", choices: ["Harbour View Suites", "Palm Court Residences"] } as ToolCall, "free", "read")])
  assert.equal(why.status, "asked")
  const dead = await afterCard([step({ tool: "ask_user", question: "Which stay should I book?", choices: ["Old Town Guesthouse", "Harbour View Suites"] } as ToolCall, "free", "read")], ["Old Town Guesthouse"])
  assert.equal(dead.status, "asked")
  // A question about something else (the room) goes as before.
  const room = await afterCard([step({ tool: "ask_user", question: "Double or twin room?", choices: ["Double", "Twin"] } as ToolCall, "free", "read")])
  assert.equal(room.status, "asked")
})

test("Q2: the plan's step «Asking you which stay to book» goes when the card carries the question", async () => {
  assert.equal(asksSame("Asking you which stay to book", "Which stay should I book?"), true)
  assert.equal(asksSame("Booking the stay", "Which stay should I book?"), false)
  assert.equal(asksSame("Choosing the stay you pick", "Which stay should I book?"), false)
  assert.equal(asksSame("Спрашиваю, какое жильё забронировать", "Какое жильё забронировать?"), true)
  // Through the plan's arrival (run 4's raw plan).
  const raw = { label: "booking a stay", steps: ["Searching Limassol stays for Fri, Dec 4 to Sun, Dec 6", "Asking you which stay to book", "Reserving the stay"], questions: [{ q: "Which stay should I book?", options: ["Old Town Guesthouse", "Harbour View Suites", "Olive Grove Apartments"], fact: "venue", pick: "" }], prices: [], fromChat: "", chatPlace: "Old Town Guesthouse", risky: [], booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0, venue: "", personal: true, match: [], area: [] } }
  const replies: any[] = [{ ok: true, plan: raw, token: "t" }]
  const io: RunnerIO = { map: async () => LIST_PAGE, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? done(), save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } }
  const st = await drive(newState("q2p", "Book a stay for 2 nights from next Friday", "en", LIST), io)
  assert.deepEqual(st.plan!.steps, ["Searching Limassol stays for Fri, Dec 4 to Sun, Dec 6", "Reserving the stay"])
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /no step says you'll ask it/)
})
