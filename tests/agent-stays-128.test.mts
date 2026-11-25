// The director's pass on 128 (iPad, the stand's stays, slots and directory): a stay booked with no dates while its
// steps and summary named them, «Not finished» over «is booked», a place choice kept in «My details», someone else's
// booking given the person's own e-mail, an ambiguous «next Friday», and the words the person reads.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { sentence } from "../netlify/shared/act.mts"
import { daysAsIso, daysInText, showsDay, weekdayOnly } from "../src/shared/agent/dates.ts"
import type { FormEntry } from "../src/shared/agent/formdata.ts"
import { checkDayLine, drive, newState, recapOf, unsetDays, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { addContactFill, bareLabel, keepable, planLine, savedAnswers, type TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const STAY = (text: string): PageMap => ({
  url: "https://stays.example/stay?id=0", title: "Harbour View Suites — rooms and rates", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1,
  text: `Harbour View Suites\n8.9 · 412 reviews\n${text}\nRates`,
  items: [
    { id: "1", role: "radio", label: "€108 per night", state: ["checked"] },
    { id: "3", role: "button", label: "Reserve" },
    { id: "4", role: "textbox", label: "Full name", lock: "personal", auto: "name", form: 0, value: "Alex Test" },
    { id: "5", role: "textbox", label: "E-mail", lock: "personal", type: "email", auto: "email", form: 0, value: "alex.test@example.com" },
    { id: "6", role: "button", label: "Complete booking", type: "submit", form: 0 }
  ]
}) as PageMap
const NO_DATES = STAY("Choose your dates")
const DATES = STAY("2026-12-04 – 2026-12-06")

const SAVED: FormEntry[] = [
  { id: "e1", key: "name.full", label: "", value: "Alex Test", updatedAt: 1 },
  { id: "e2", key: "email", label: "", value: "alex.test@example.com", updatedAt: 1 }
] as FormEntry[]

function io(replies: ActReply[], map: PageMap, entries: FormEntry[] = SAVED) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted } = {
    asked, acted,
    map: async () => map,
    act: async (c) => {
      acted.push(c)
      return { ok: true, note: "done" }
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => entries,
    policy: { amazon: true },
    maxSteps: 30
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

function stay(request = "Book a stay for 2 nights from next Friday"): AgentState {
  const s = newState("t128", request, "en", NO_DATES.url)
  s.plan = {
    steps: [], questions: [], self: [], prices: [], approved: true,
    perms: [{ id: "p1", kind: "press", reason: "submit", label: "Complete booking", host: "stays.example", on: true }],
    booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", at: "", from: "", until: "", minutes: 0 }
  } as unknown as TaskPlan
  return s
}

test("days a text names, in words or as dates; a page shows a day only when it's set there", () => {
  assert.deepEqual(daysInText("Opening Harbour View Suites, the place you chose, for 2 nights from Fri, Dec 4.", "2026-12-04"), ["2026-12-04"])
  assert.deepEqual(daysInText("Completing the booking for 2026-12-04 to 2026-12-06", "2026-12-04"), ["2026-12-04", "2026-12-06"])
  assert.deepEqual(daysInText("в пятницу 4 декабря", "2026-11-25"), ["2026-12-04"])
  assert.deepEqual(daysInText("12月4日", "2026-11-25"), ["2026-12-04"])
  assert.deepEqual(daysInText("Choosing the €108 per night rate with free cancellation.", "2026-12-04"), [])
  assert.equal(showsDay(NO_DATES, "2026-12-04"), false, "«Choose your dates»")
  assert.equal(showsDay(DATES, "2026-12-04"), true)
  assert.equal(showsDay({ ...NO_DATES, items: [{ id: "i", role: "textbox", label: "Check-in", type: "date", value: "2026-12-04" }] } as PageMap, "2026-12-04"), true, "a field holding it")
  // A calendar of many days isn't a day set; the one marked chosen is.
  const cal = (chosen: boolean) => ({ ...NO_DATES, text: "December 2026", items: Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, role: "button", label: `${i + 1} December 2026`, ...(chosen && i === 3 ? { state: ["selected"] } : {}) })) }) as PageMap
  assert.equal(showsDay(cal(false), "2026-12-04"), false)
  assert.equal(showsDay(cal(true), "2026-12-04"), true)
})

test("1: a stay's last press is refused while its page doesn't show the dates; it goes once it does", async () => {
  assert.match(unsetDays(stay(), NO_DATES) ?? "", /doesn't show this stay's dates set/)
  assert.equal(unsetDays(stay(), DATES), null)
  const x = io([step({ tool: "click", id: "6", why: "Completing the booking for 2026-12-04 to 2026-12-06" }, "confirm", "submit"), step({ tool: "done", summary: "Not booked: the page has no dates." }, "free", "read")], NO_DATES)
  const after = await drive(stay(), x)
  assert.deepEqual(x.acted, [], "nothing pressed")
  assert.match(x.asked[1].log.at(-1).result, /refused: the page doesn't show this stay's dates set/)
  assert.equal(after.error, "unbooked")
  // Three in a row: the task ends, not finished (never a loop).
  const press = () => step({ tool: "click", id: "6", why: "Completing the booking" }, "confirm", "submit")
  const y = io([press(), press(), press(), press()], NO_DATES)
  const stuck = await drive(stay(), y)
  assert.equal(stuck.status, "done")
  assert.equal(stuck.error, "unbooked")
  assert.deepEqual(y.acted, [])
})

test("2: a «done» without its date after the last press went is the booking's, not «Not finished»", async () => {
  const x = io([step({ tool: "click", id: "6", why: "Completing the booking for 2026-12-04 to 2026-12-06" }, "confirm", "submit"), step({ tool: "done", summary: "Your stay is booked." }, "free", "read")], DATES)
  const after = await drive(stay("Book a stay for 2 nights from 4 Dec"), x)
  assert.equal(x.acted.length, 1)
  assert.equal(after.status, "done")
  assert.notEqual(after.error, "unbooked")
  assert.equal(after.booked?.date, "2026-12-04")
  // Nothing pressed: still not finished, whatever the summary says.
  const y = io([step({ tool: "done", summary: "Your stay is booked." }, "free", "read")], DATES)
  assert.equal((await drive(stay("Book a stay for 2 nights from 4 Dec"), y)).error, "unbooked")
})

test("1: a step's line names a day only when the page it led to shows it set", async () => {
  // (A list's link that opens the place: the page it leads to says «Choose your dates».)
  const LIST = { ...NO_DATES, forms: [], items: [{ id: "7", role: "link", label: "Harbour View Suites", href: "/stay?id=0" }] } as PageMap
  const x = io([step({ tool: "click", id: "7", why: "Opening Harbour View Suites for 2 nights from 2026-12-04" }, "free", "click"), step({ tool: "done", summary: "stopped" }, "free", "read")], LIST)
  const after = await drive(stay(), x)
  assert.equal(after.lines[0].text, "", "the date claim is dropped: the line shows the control's name")
  const s = stay()
  s.lines.push({ text: "Setting check-in to December 4", tool: "type", cls: "free", ok: true })
  s.lineCheck = 0
  checkDayLine(s, { ...NO_DATES, items: [{ id: "2", role: "textbox", label: "Check-in", type: "date", value: "2026-12-04" }] } as PageMap)
  assert.equal(s.lines[0].text, "Setting check-in to December 4", "the field shows it set: kept")
  const t = stay()
  t.lines.push({ text: "Choosing the €108 rate", tool: "click", cls: "free", ok: true })
  t.lineCheck = 0
  checkDayLine(t, NO_DATES)
  assert.equal(t.lines[0].text, "Choosing the €108 rate", "no day named: kept")
})

test("12: a day named only by its weekday is in front of the person before the last press", () => {
  assert.equal(weekdayOnly("Book a stay for 2 nights from next Friday", "2026-11-25"), true)
  assert.equal(weekdayOnly("Запиши в понедельник утром", "2026-11-25"), true)
  assert.equal(weekdayOnly("Book a table tomorrow at 19:30", "2026-11-25"), false)
  assert.equal(weekdayOnly("Book Friday 4 December", "2026-11-25"), false)
  const plain = { ...DATES, text: "Harbour View Suites\n2026-12-04 – 2026-12-06" } as PageMap
  assert.deepEqual(recapOf(stay(), plain), { date: "2026-12-04", dateEnd: "2026-12-06" })
  assert.equal(recapOf(stay("Book a stay from 4 to 6 December"), plain), null, "the request's own dates: no recap")
  // The press the plan didn't allow: the «Do it?» carries what it books.
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /state\.pending\.recap\?\.press && recapWhat\(state\.pending\.recap\)/)
  assert.match(panel, /r\.dateEnd \? `\$\{when\(r\.date\)\} – \$\{when\(r\.dateEnd\)\}`/)
})

test("3: which place is never kept in «My details», nor filled in from an old row", () => {
  assert.equal(keepable({ kind: "venue", fact: "pref:place" }), false)
  assert.equal(keepable({ fact: "venue" }), false)
  assert.equal(keepable({ fact: "Пол" }), true)
  assert.equal(keepable({ fact: "pref:Мастер" }), true)
  assert.equal(keepable({ kind: "contact" }), true)
  const plan = { steps: [], perms: [], self: [], prices: [], questions: [{ q: "Which place should I book?", options: ["Harbour View Suites", "Old Town Guesthouse"], fact: "venue" }] } as unknown as TaskPlan
  assert.deepEqual(savedAnswers(plan, { venue: "Harbour View Suites" }), [""])
})

test("4: someone else's booking: the person's saved contacts start unticked, an optional field stays empty", async () => {
  const plan = (said: string) => {
    const p = { steps: [], questions: [], self: [], prices: [], booking: { kind: "table" }, perms: [{ id: "p0", kind: "personal", reason: "personal", label: "Name, Phone", fields: ["Name", "Phone"], host: "h", on: true }] } as unknown as TaskPlan
    addContactFill(p, ["name.full", "email", "phone"], "h", said)
    return p
  }
  const other = plan("Book a table for Maria Kim, phone +33 6 12 34 56 78, tomorrow at 19:30 for 2")
  assert.equal(other.forOther, true)
  assert.deepEqual(other.perms.find((p) => p.reason === "contact")?.keys, ["email"])
  assert.equal(other.perms.find((p) => p.reason === "contact")?.on, false)
  assert.match(planLine({ ...other, approved: true }), /leave a contact field the page doesn't require empty/)
  const mine = { steps: [], questions: [], self: [], prices: [], booking: { kind: "table" }, perms: [] } as unknown as TaskPlan
  addContactFill(mine, ["name.full", "email"], "h", "Book a table for me tomorrow at 19:30")
  assert.equal(mine.forOther, undefined)
  assert.equal(mine.perms.find((p) => p.reason === "contact")?.on, true)
  // The device: the saved e-mail into an optional field of someone else's booking is refused; a required one asks.
  const FORM = { url: "https://tables.example/slots", title: "Book a table", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "", items: [{ id: "3", role: "textbox", label: "E-mail", lock: "personal", type: "email", auto: "email", form: 0, state: ["empty"] }] } as PageMap
  const run = (required: boolean) => {
    const s = newState("t4", "Book a table for Maria Kim, phone +33 6 12 34 56 78, tomorrow at 19:30 for 2", "en", FORM.url)
    s.plan = { ...other, approved: true, booking: { kind: "table", date: "2026-11-26", at: "19:30", from: "", until: "", minutes: 90 } } as TaskPlan
    const map = required ? { ...FORM, items: [{ ...FORM.items[0], state: ["empty", "required"] }] } as PageMap : FORM
    const x = io([step({ tool: "fill", id: "3", key: "email", why: "Adding the e-mail" }, "confirm", "fill"), step({ tool: "done", summary: "stopped" }, "free", "read")], map)
    return drive(s, x).then((after) => ({ after, x }))
  }
  const optional = await run(false)
  assert.match(optional.x.asked[1].log.at(-1).result, /refused: this booking is for someone the request names/)
  assert.deepEqual(optional.x.acted, [])
  const required = await run(true)
  assert.equal(required.after.status, "fill", "a required field: the person is asked, with the value shown")
})

test("6–9: one day format, labels without their required mark, warnings cut at a sentence, no empty «No questions» line", () => {
  assert.equal(daysAsIso("Choosing the first free day, Thursday 26 November.", "2026-11-25"), "Choosing the first free day, 2026-11-26.")
  assert.equal(daysAsIso("Choosing the earliest free time, 09:00, on Thu 26 Nov.", "2026-11-25"), "Choosing the earliest free time, 09:00, on 2026-11-26.")
  assert.equal(daysAsIso("Booked for December 4, 2026 at 10:00", "2026-11-25"), "Booked for 2026-12-04 at 10:00")
  assert.equal(daysAsIso("You may 5 times", "2026-11-25"), "You may 5 times")
  assert.equal(bareLabel("Phone *"), "Phone")
  assert.equal(bareLabel("*"), "*")
  const cut = sentence("The approved plan says the device asks you before the final step. This step presses Complete booking, which is the final confirmation of the stay you approved, so it is not in the plan at all.", 120)
  assert.equal(cut, "The approved plan says the device asks you before the final step.")
  assert.match(sentence("a ".repeat(150), 40), /…$/)
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /state\.plan\?\.auto && \(state\.plan\.answers \?\? \[\]\)\.some\(\(a\) => !!a\.a\)/)
  assert.match(panel, /\{localWhen\(lines\[lines\.length - 1\]\.text\)\}/)
  assert.match(panel, /\{localWhen\(last\.text\)\}/)
  assert.match(panel, /replace\(\/\\s\*\[\*＊\]\+\\s\*\$\/u, ""\)/)
  const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"))
  assert.doesNotMatch(en.agentPriceChanged, /plan/i, "the price warning stands on its own (no plan card may have been shown)")
})

// ---------------------------------------------------------------- the director's review of 04a35ae3 (A–G)

test("A: a page holding its dates in US order («12/04/2026», «12/4 – 12/6») shows them; the last press goes", async () => {
  const US = { ...STAY("Dec 2026"), items: [{ id: "2", role: "textbox", label: "Check-in", value: "12/04/2026" }, { id: "8", role: "textbox", label: "Check-out", value: "12/06/2026" }, ...STAY("").items] } as PageMap
  assert.equal(showsDay(US, "2026-12-04"), true)
  assert.equal(showsDay(STAY("Your stay: 12/4 – 12/6"), "2026-12-06"), true)
  assert.equal(showsDay(STAY("Your stay: 4/12 – 6/12"), "2026-12-04"), true, "day/month as well")
  const x = io([step({ tool: "click", id: "6", why: "Completing the booking" }, "confirm", "submit"), step({ tool: "done", summary: "Booked." }, "free", "read")], US)
  const after = await drive(stay("Book a stay from 4 to 6 December"), x)
  assert.equal(x.acted.length, 1, "pressed")
  assert.equal(after.booked?.date, "2026-12-04")
})

const TABLE = (items: PageMap["items"]): PageMap => ({ url: "https://tables.example/book", title: "Book a table", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "Book a table", items: [...items, { id: "9", role: "button", label: "Book", type: "submit", form: 0 }] }) as PageMap
function table(request: string): AgentState {
  const s = newState("tB", request, "en", "https://tables.example/book")
  s.plan = { steps: [], questions: [], self: [], prices: [], approved: true, perms: [{ id: "p1", kind: "press", reason: "submit", label: "Book", host: "tables.example", on: true }], booking: { kind: "table", date: "2026-11-26", at: "19:30", from: "", until: "", minutes: 90 } } as unknown as TaskPlan
  return s
}

test("B: a table left on the page's own day (another day set) isn't booked because the strip offered the asked one", () => {
  const strip = TABLE([{ id: "d1", role: "button", label: "Wed 25 Nov", state: ["pressed"] }, { id: "d2", role: "button", label: "Thu 26 Nov" }, { id: "d3", role: "button", label: "Fri 27 Nov" }, { id: "d4", role: "button", label: "Sat 28 Nov" }])
  const s = table("Book a table tomorrow at 19:30")
  s.sawDate = true
  assert.match(unsetDays(s, strip) ?? "", /doesn't show the booking's day/)
  const field = TABLE([{ id: "f", role: "textbox", label: "Date", type: "date", value: "2026-11-25" }])
  assert.match(unsetDays(s, field) ?? "", /doesn't show the booking's day/)
  // The asked day marked chosen: it goes.
  const chosen = TABLE([{ id: "d1", role: "button", label: "Wed 25 Nov" }, { id: "d2", role: "button", label: "Thu 26 Nov", state: ["pressed"] }, { id: "d3", role: "button", label: "Fri 27 Nov" }, { id: "d4", role: "button", label: "Sat 28 Nov" }])
  assert.equal(unsetDays(s, chosen), null)
})

test("C: the person took another day in their answer: the last press goes, the recap and the booking carry their day", async () => {
  const page = TABLE([{ id: "f", role: "textbox", label: "Date", type: "date", value: "2026-11-28" }, { id: "t", role: "button", label: "19:30", state: ["pressed"] }])
  const s = table("Book a table tomorrow at 19:30")
  s.replies = ["2026-11-28"]
  assert.equal(unsetDays(s, page), null)
  // Not allowed by the plan this time: the «Do it?» carries what it books.
  s.plan!.perms = []
  const x = io([step({ tool: "click", id: "9", why: "Booking" }, "confirm", "submit")], page)
  const asked = await drive(s, x)
  assert.equal(asked.status, "confirm")
  assert.equal(asked.pending?.recap?.date, "2026-11-28")
  assert.equal(asked.pending?.recap?.askedDate, "2026-11-26")
  const { answer } = await import("../src/shared/agent/runner.ts")
  x.ask = async () => ({ ok: true, call: { tool: "done", summary: "Booked.", date: "2026-11-26", time: "19:30" }, verdict: { cls: "free", reason: "read" } })
  const after = await answer(asked, x, "yes")
  assert.equal(after.booked?.date, "2026-11-28", "the day the page showed at the press, not the model's asked day")
})

test("D: which place isn't kept in any language: the question whose options are places the page lists", () => {
  assert.equal(keepable({ fact: "Отель", place: true }), false)
  assert.equal(keepable({ fact: "Lieu", place: true }), false)
  assert.equal(keepable({ fact: "Отель" }), true, "by words alone it can't tell: the device marks it from the page")
  const runner = readFileSync(new URL("../src/shared/agent/runner.ts", import.meta.url), "utf8")
  assert.match(runner, /if \(q\.fact === "venue" \|\| q\.options\.filter\(\(o\) => listed\.has\(squashName\(o\)\)\)\.length >= 2\) q\.place = true/)
})

test("E: a phone or an e-mail alone is the person's own booking; a name that isn't theirs makes it someone else's", () => {
  const plan = (said: string, fields: string[]) => {
    const p = { steps: [], questions: [], self: [], prices: [], booking: { kind: "table" }, perms: [{ id: "p0", kind: "personal", reason: "personal", label: fields.join(", "), fields, host: "h", on: true }] } as unknown as TaskPlan
    addContactFill(p, ["name.full", "email", "phone"], "h", said, "Alex Test")
    return p
  }
  assert.equal(plan("Book a table tomorrow, my phone is +33 6 12 34 56 78", ["Phone"]).forOther, undefined)
  assert.equal(plan("Book a table tomorrow, my phone is +33 6 12 34 56 78", ["Phone"]).perms.find((p) => p.reason === "contact")?.on, true)
  assert.equal(plan("Book a table for Alex Test tomorrow", ["Name"]).forOther, undefined, "their own saved name")
  assert.equal(plan("Book a table for Maria Kim tomorrow", ["Name"]).forOther, true)
})

test("F: a required field marked only by «*», or asked again after the press, ends with the person asked — never a loop", async () => {
  const FORM = (label: string) => ({ url: "https://tables.example/slots", title: "Book", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "", items: [{ id: "3", role: "textbox", label, lock: "personal", type: "email", auto: "email", form: 0, state: ["empty"] }] }) as PageMap
  const other = { steps: [], questions: [], self: [], prices: [], approved: true, forOther: true, booking: { kind: "table", date: "2026-11-26", at: "19:30", from: "", until: "", minutes: 90 }, perms: [{ id: "pcontact", kind: "fill", reason: "contact", label: "", keys: ["email"], host: "tables.example", on: false }] } as unknown as TaskPlan
  const run = async (label: string) => {
    const s = newState("tF", "Book a table for Maria Kim tomorrow at 19:30", "en", "https://tables.example/slots")
    s.plan = structuredClone(other)
    const fill = () => step({ tool: "fill", id: "3", key: "email", why: "Adding the e-mail" }, "confirm", "fill")
    const x = io([fill(), fill(), fill()], FORM(label))
    return { after: await drive(s, x), x }
  }
  assert.equal((await run("E-mail *")).after.status, "fill", "«*»: required, the person is asked")
  const again = await run("E-mail")
  assert.match(again.x.asked[1].log.at(-1).result, /refused: this booking is for someone the request names/)
  assert.equal(again.after.status, "fill", "the second time (the form asked for it): the person is asked")
})

test("G: an emptied line shows its control's name; a table's day pressed on a strip keeps its line", () => {
  const s = table("Book a table tomorrow at 19:30")
  s.lines.push({ text: "Choosing 2026-11-26 for 2", tool: "click", cls: "free", ok: true, target: 'button "Thu 26"' })
  s.lineCheck = 0
  s.picked = { date: "2026-11-26" }
  checkDayLine(s, TABLE([{ id: "d", role: "button", label: "Thu 26" }, { id: "e", role: "button", label: "Fri 27" }]))
  assert.equal(s.lines[0].text, "Choosing 2026-11-26 for 2")
  const t = table("Book a table tomorrow at 19:30")
  t.lines.push({ text: "Choosing Thu 26 Nov", tool: "click", cls: "free", ok: true, target: 'button "Thu 26 Nov"' })
  t.lineCheck = 0
  checkDayLine(t, TABLE([{ id: "d", role: "button", label: "Thu 26 Nov" }, ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, role: "button", label: `Fri ${27 + i} Nov` }) as PageMap["items"][number])]))
  assert.equal(t.lines[0].text, "Choosing Thu 26 Nov", "the pressed control is that day")
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /l\.text \? localWhen\(l\.text\) : l\.tool === "fill" && l\.target \? t\("agentLineFilled", nameOf\(l\.target\)\) : nameOf\(l\.target\)/)
})

test("4 (iPad): the plan card starts a permission unticked when the plan does", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /useState<Set<string>>\(\(\) => new Set\(plan\.perms\.filter\(\(p\) => p\.on === false\)\.map\(\(p\) => p\.id\)\)\)/)
})
