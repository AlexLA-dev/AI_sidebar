// Autonomous booking (2.7.1, the owner 2026-11-22: «Доделывай нормальную автономизацию агента… оглядывался и на
// свободные слоты в календаре»): the Calendar's free time, standing rules, remembered choices, no plan card when nothing
// is left to ask, playbooks; and none of it widens what's allowed (paying, codes, signing in, messages, Amazon).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { classify } from "../src/shared/agent/classify.ts"
import { DEFAULT_RULES, looksLikeSlot, readRules, rulesLine } from "../src/shared/agent/rules.ts"
import { drive, goesAlone, newState, playbookOf, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import { buildPlan, checkPlan, factKey, factLabel, savedAnswers } from "../src/shared/agent/taskplan.ts"
import type { FormEntry } from "../src/shared/agent/formdata.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const SALON: PageMap = {
  url: "https://www.salon.example.com/booking?cart=abc123&email=a%40b.c", title: "Book", lang: "en", more: 0, part: 1, parts: 1,
  text: "Select date and time",
  forms: [],
  items: [
    { id: "1", role: "button", label: "Select Tue, Nov 24" },
    { id: "2", role: "button", label: "17:00" },
    { id: "3", role: "button", label: "17:45" },
    { id: "4", role: "button", label: "Confirm booking" },
    { id: "5", role: "button", label: "Pay €18 now" }
  ]
}
const BOOKING = { kind: "appointment", date: "2026-11-24", from: "17:00", until: "21:00", minutes: 45 }
const RAW = {
  label: "booking a haircut",
  steps: ["Choosing a time", "Booking"],
  questions: [{ q: "Who is it for?", options: ["Man", "Woman"], fact: "Gender" }, { q: "Which specialist?", options: ["Yasmin", "Angelos"], fact: "pref:Specialist" }],
  risky: [{ tool: "click", id: "", text: "Confirm booking", key: "" }],
  prices: [],
  booking: BOOKING
}
const fact = (label: string, value: string): FormEntry => ({ id: label, key: "fact", label, value, updatedAt: 1 })

function io(replies: ActReply[], opts: { busy?: string[]; playbook?: string[] | null; entries?: FormEntry[]; calendar?: string; map?: PageMap } = {}) {
  const asked: Array<Record<string, unknown>> = []
  const acted: ToolCall[] = []
  const events: ToolCall[] = []
  const kept: Record<string, string[]> = {}
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted; events: typeof events; kept: typeof kept } = {
    asked, acted, events, kept,
    map: async () => opts.map ?? SALON,
    act: async (c) => (acted.push(c), { ok: true }),
    waitPage: async () => {},
    ask: async (body) => (asked.push(JSON.parse(JSON.stringify(body))), replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }),
    save: async () => {},
    entries: async () => opts.entries ?? [],
    policy: { amazon: true },
    maxSteps: 30,
    planning: true,
    device: async () => ({ reminders: "yes", calendar: "yes" }),
    apple: async (c) => (events.push(c), { ok: true, note: "added" }),
    rules: async () => DEFAULT_RULES,
    calendarFree: async () => opts.calendar ?? "2026-11-24 17:30–21:00",
    slotFree: async (date, time) => !(opts.busy ?? []).includes(`${date} ${time}`),
    playbook: { get: async () => opts.playbook ?? null, put: async (site, steps) => void (kept[site] = steps) }
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string, target: string | null = null): ActReply => ({ ok: true, call, verdict: { cls, reason }, target })

test("rules: stored values are clamped, the defaults fill the rest, the model hears them as one line", () => {
  assert.deepEqual(readRules(null), DEFAULT_RULES)
  const r = readRules({ window: 9999, days: -3, party: 0, auto: "yes" })
  assert.equal(r.window, 240)
  assert.equal(r.days, 0)
  assert.equal(r.party, 1)
  assert.equal(r.auto, true, "a value of the wrong kind keeps the default")
  assert.match(rulesLine(DEFAULT_RULES, true), /60 minutes either way; .*2 days later; 2 people .*any specialist.*free in the person's calendar/)
  assert.doesNotMatch(rulesLine(DEFAULT_RULES, false), /calendar/)
})

test("the plan's booking is checked: a real date and times, a sane length, or none", () => {
  assert.deepEqual(checkPlan(RAW).booking, BOOKING)
  assert.equal(checkPlan({ ...RAW, booking: { kind: "none", date: "", from: "", until: "", minutes: 0 } }).booking, undefined)
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, date: "tomorrow" } }).booking, undefined)
  assert.deepEqual(checkPlan({ ...RAW, booking: { ...BOOKING, from: "25:00", minutes: 9000 } }).booking, { ...BOOKING, from: "08:00", minutes: 600 })
  assert.equal(looksLikeSlot("17:45"), true)
  assert.equal(looksLikeSlot("5:45 PM"), true)
  assert.equal(looksLikeSlot("Select Tue, Nov 24"), false)
  assert.equal(looksLikeSlot("Confirm booking"), false)
})

test("remembered choices are this site's; facts about the person are everyone's", () => {
  const ctx = { map: SALON, startHost: "www.salon.example.com", request: "book a haircut", confirmedHere: false, policy: { amazon: true } }
  const plan = buildPlan(checkPlan(RAW), ctx)
  assert.equal(plan.site, "example.com")
  assert.equal(factLabel("pref:Specialist", plan.site), "example.com · Specialist")
  assert.equal(factLabel("Gender", plan.site), "Gender")
  assert.equal(factLabel("pref:Specialist", undefined), "", "no site: not kept")
  const pre = savedAnswers(plan, { [factKey("Gender")]: "Man", [factKey("example.com · Specialist")]: "Yasmin", [factKey("other.com · Specialist")]: "Angelos" })
  assert.deepEqual(pre, ["Man", "Yasmin"])
  const elsewhere = buildPlan(checkPlan(RAW), { ...ctx, map: { ...SALON, url: "https://third.example.org/booking" } })
  assert.deepEqual(savedAnswers(elsewhere, { [factKey("Gender")]: "Man", [factKey("example.com · Specialist")]: "Yasmin" }), ["Man", ""], "another site's choice isn't used")
})

test("no card only when nothing is paid and the only steps are the booking's press, saved details and the Calendar", () => {
  const ctx = { map: SALON, startHost: "www.salon.example.com", request: "book a haircut", confirmedHere: false, policy: { amazon: true } }
  const plan = buildPlan(checkPlan(RAW), ctx)
  assert.equal(goesAlone(plan, SALON), true)
  assert.equal(goesAlone({ ...plan, prices: ["18 €"] }, SALON), true, "a booking's price is paid there")
  assert.equal(goesAlone({ ...plan, prices: ["18 €"], booking: undefined }, SALON), false, "an order's price is paid now")
  assert.equal(goesAlone(plan, { ...SALON, pay: true }), false, "a page that takes payment")
  assert.equal(goesAlone(plan, { ...SALON, deposit: true }), false, "a deposit or no-show fee")
  assert.equal(goesAlone({ ...plan, self: [{ reason: "pay", label: "Pay" }] }, SALON), false)
  assert.equal(goesAlone({ ...plan, perms: [...plan.perms, { id: "x", kind: "consent", reason: "consent", label: "terms", host: "", on: true }] }, SALON), false, "a terms box")
  assert.equal(goesAlone({ ...plan, perms: [...plan.perms, { id: "y", kind: "press", reason: "cart", label: "Add to cart", host: "", on: true }] }, SALON), false, "a cart")
})

test("a known site with every answer known starts without the card; a first visit shows it", async () => {
  const entries = [fact("Gender", "Man"), fact("example.com · Specialist", "Yasmin")]
  const known = io([{ ok: true, plan: RAW, token: "t" }], { entries, playbook: ["Book now", "Haircut"] })
  const s = await drive(newState("a", "book me a haircut tomorrow after 17:00", "en", SALON.url), known)
  assert.equal(s.plan?.auto, true)
  assert.equal(s.status, "done", "no plan card: it went on")
  assert.deepEqual(s.plan?.answers?.map((a) => a.a), ["Man", "Yasmin"])
  assert.match(String((known.asked[1].task as Record<string, unknown>).playbook), /«Book now» → «Haircut»/)
  assert.match(String((known.asked[1].task as Record<string, unknown>).calendar), /2026-11-24 17:30–21:00/)
  const first = io([{ ok: true, plan: RAW, token: "t" }], { entries, playbook: null })
  const s2 = await drive(newState("b", "book me a haircut", "en", SALON.url), first)
  assert.equal(s2.status, "plan", "first time on the site: the card, once")
  const unknown = io([{ ok: true, plan: RAW, token: "t" }], { entries: [fact("Gender", "Man")], playbook: ["Book now"] })
  assert.equal((await drive(newState("c", "book", "en", SALON.url), unknown)).status, "plan", "an answer not known: the card")
  assert.ok(s2.plan?.perms.some((p) => p.kind === "apple" && p.reason === "event_add" && p.on), "the Calendar event is a ticked permission")
})

test("a time slot that clashes with the Calendar is never pressed; the model must say its date and time", async () => {
  const x = io([
    { ok: true, plan: RAW, token: "t" },
    step({ tool: "click", id: "2" }, "free", "click"),
    step({ tool: "click", id: "2", date: "2026-11-24", time: "17:00" }, "free", "click"),
    step({ tool: "click", id: "3", date: "2026-11-24", time: "17:45" }, "free", "click", 'button "17:45"'),
    step({ tool: "click", id: "4" }, "confirm", "submit", 'button "Confirm booking"'),
    step({ tool: "done", summary: "17:00 was taken — booked 17:45", date: "2026-11-24", time: "17:45", place: "Cutter Barbershop" }, "free", "read")
  ], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Yasmin")], playbook: ["Book now"], busy: ["2026-11-24 17:00"] })
  const s = await drive(newState("d", "haircut tomorrow at 17:00", "en", SALON.url), x)
  assert.deepEqual(x.acted.map((c) => c.id), ["3", "4"], "only the free slot was pressed, then the booking's own button without a question (the rules)")
  assert.match(s.log[0].result, /refused: a time slot: say its date/)
  assert.match(s.log[1].result, /refused: 2026-11-24 17:00 is busy in the person's calendar/)
  // Booked: the device adds it to the Calendar, with the page's link without its query.
  assert.equal(x.events.length, 1)
  assert.equal(x.events[0].tool, "event_add")
  assert.equal(x.events[0].date, "2026-11-24")
  assert.equal(x.events[0].time, "17:45")
  assert.equal(x.events[0].link, "https://www.salon.example.com/booking")
  assert.deepEqual(s.booked, { date: "2026-11-24", time: "17:45", place: "Cutter Barbershop" })
  assert.deepEqual(x.kept["example.com"], ["17:45", "Confirm booking"], "the playbook: what was pressed, no typed values")
})

test("nothing booked (a sign-in left to the person), or the Calendar permission unticked: no event", async () => {
  const x = io([{ ok: true, plan: RAW, token: "t" }, step({ tool: "done", summary: "Sign in to finish" }, "free", "read")], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  await drive(newState("e", "haircut", "en", SALON.url), x)
  assert.equal(x.events.length, 0)
  const y = io([{ ok: true, plan: RAW, token: "t" }], { playbook: null })
  const s = await drive(newState("f", "haircut", "en", SALON.url), y)
  assert.equal(s.status, "plan")
  s.plan!.perms = s.plan!.perms.map((p) => (p.reason === "event_add" ? { ...p, on: false } : p))
})

test("security: rules, remembered choices and playbooks never widen what's allowed", async () => {
  const known = { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Yasmin")], playbook: ["Book now", "Pay €18 now", "Sign in"] }
  // Paying (an amount on the button) stays the person's in a task that started without a card.
  const pay = io([{ ok: true, plan: RAW, token: "t" }, step({ tool: "click", id: "5" }, "free", "click")], known)
  const s = await drive(newState("g", "haircut", "en", SALON.url), pay)
  assert.equal(s.plan?.auto, true)
  assert.equal(s.status, "self")
  assert.equal(s.pending?.verdict.reason, "pay")
  assert.equal(pay.acted.length, 0)
  // A deposit on the page: the committing press is the person's (the device's own map says so).
  const dep = { ...SALON, deposit: true, items: [...SALON.items, { id: "8", role: "textbox" as const, label: "Phone", lock: "personal" as const, form: 0 }, { id: "9", role: "button" as const, label: "Book appointment", form: 0, type: "submit" }], forms: [{ n: 0, fillable: true }] }
  assert.deepEqual(classify({ tool: "click", id: "9" }, { map: dep, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } }), { cls: "self", reason: "pay" })
  // (A fee named on a page that isn't where the booking commits doesn't make its buttons paying.)
  const home: PageMap = { ...SALON, deposit: true, forms: [{ n: 0, fillable: true }], items: [{ id: "1", role: "textbox", label: "Search", form: 0 }, { id: "2", role: "button", label: "Search", type: "submit", form: 0 }] }
  assert.notEqual(classify({ tool: "click", id: "2" }, { map: home, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } }).reason, "pay")
  // Signing in, a message, Amazon: the same as without rules.
  const login: PageMap = { ...SALON, forms: [{ n: 0, fillable: true, secret: true }], items: [{ id: "1", role: "textbox", label: "Password", lock: "secret", form: 0 }, { id: "2", role: "button", label: "Log in", type: "submit", form: 0 }] }
  assert.equal(classify({ tool: "click", id: "2" }, { map: login, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } }).cls, "self")
  const amazon: PageMap = { ...SALON, url: "https://www.amazon.de/x" }
  assert.equal(classify({ tool: "click", id: "4" }, { map: amazon, startHost: "www.amazon.de", request: "book", confirmedHere: true, policy: { amazon: true } }).cls, "blocked")
  // The playbook is text for the model only: the runner's classes don't read it.
  const runner = readFileSync(new URL("../src/shared/agent/runner.ts", import.meta.url), "utf8")
  assert.doesNotMatch(runner.split("export function goesAlone")[1].split("\n}\n")[0], /playbook|rules/)
})

test("the Calendar's contents never leave the device: the server takes times only", () => {
  const fn = readFileSync(new URL("../netlify/functions/v2-act.mts", import.meta.url), "utf8")
  assert.match(fn, /function calendarLine/)
  assert.match(fn, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\} \\d\{2\}:\\d\{2\}–\\d\{2\}:\\d\{2\}\$\//)
  // A payment frame counts only when it's shown (an invisible Stripe frame is on every page of a site that uses it).
  const map = readFileSync(new URL("../src/content/agent/map.ts", import.meta.url), "utf8")
  assert.match(map, /if \(!shownFrame\(f\)\) continue/)
  assert.match(map, /if \(r\.width < 40 \|\| r\.height < 20\) return false/)
  const swift = readFileSync(new URL("../ContextFlow/Shared (Extension)/AgentApple.swift", import.meta.url), "utf8")
  assert.match(swift, /padPlace: Int = 0/)
  assert.match(swift, /\(e\.location \?\? ""\)\.isEmpty \? pad : max\(pad, padPlace\)/)
  assert.deepEqual(playbookOf([
    { call: { tool: "type", id: "1", text: "Anna" }, result: "done" },
    { call: { tool: "click", id: "2" }, target: 'button "Book now"', result: "the page went on" },
    { call: { tool: "click", id: "3" }, target: 'button "Pay"', result: "refused: pay" },
    { call: { tool: "select", id: "4", option: "Haircut" }, result: "done" }
  ]), ["Book now", "Haircut"])
})

test("a search box isn't a personal field, even when its label says «name»", async () => {
  const { fieldLock } = await import("../src/shared/agent/fields.ts")
  assert.equal(fieldLock({ tag: "input", label: "Cuisine, restaurant name..." }), null)
  assert.equal(fieldLock({ tag: "input", type: "search", label: "Name" }), null)
  assert.equal(fieldLock({ tag: "input", label: "Поиск по названию" }), null)
  assert.equal(fieldLock({ tag: "input", label: "Near me, exact address, station..." }), null, "TheFork's place search")
  assert.equal(fieldLock({ tag: "input", label: "Address" }), "personal")
  assert.equal(fieldLock({ tag: "input", label: "Name" }), "personal")
  assert.equal(fieldLock({ tag: "input", label: "Your name" }), "personal")
  assert.equal(fieldLock({ tag: "input", label: "Search", autocomplete: "email" }), "personal", "the page's own token wins")
  assert.equal(fieldLock({ tag: "input", label: "Search", type: "password" }), "secret")
})

test("a time slot's date and time survive the call's check (the device needs them for the Calendar)", async () => {
  const { checkCall } = await import("../src/shared/agent/call.ts")
  const r = checkCall({ tool: "click", id: "3", date: "2026-11-24", time: "17:45", why: "" }, SALON, [])
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.call.date, "2026-11-24")
  assert.equal(r.ok && r.call.time, "17:45")
  const bad = checkCall({ tool: "click", id: "3", date: "tomorrow", time: "5pm", why: "" }, SALON, [])
  assert.equal(bad.ok && bad.call.date, undefined)
  const done = checkCall({ tool: "done", summary: "Booked", date: "2026-11-24", time: "17:45", place: "Cutter" }, SALON, [])
  assert.equal(done.ok && done.call.place, "Cutter")
})

test("an unticked step is asked at the time, not dropped; this site's new-tab links open in the agent's tab", async () => {
  const { planLine } = await import("../src/shared/agent/taskplan.ts")
  const ctx = { map: SALON, startHost: "www.salon.example.com", request: "book", confirmedHere: false, policy: { amazon: true } }
  const plan = buildPlan(checkPlan(RAW), ctx)
  plan.approved = true
  plan.perms = plan.perms.map((p) => ({ ...p, on: false }))
  assert.match(planLine(plan), /ask the person first \(they unticked it: go on, and the device asks them at that step\): Confirm booking/)
  const hands = readFileSync(new URL("../src/content/agent/hands.ts", import.meta.url), "utf8")
  assert.match(hands, /sameSite\(hostOf\(a\.href\), hostOf\(el\.ownerDocument\.location\?\.href \?\? ""\)\)/)
})

test("a listing card with a price «from …» is a link to the place, not paying; a button with an amount still pays", () => {
  const ctx = (items: PageMap["items"]) => ({ map: { ...SALON, items }, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } })
  const card = { id: "1", role: "link" as const, label: "Groom Room 5.0 1178 reviews West Hampstead, London Men - Haircut from £35", href: "www.salon.example.com/groom" }
  assert.notEqual(classify({ tool: "click", id: "1" }, ctx([card])).reason, "pay")
  assert.deepEqual(classify({ tool: "click", id: "2" }, ctx([{ id: "2", role: "button", label: "Pay £35" }])), { cls: "self", reason: "pay" })
  assert.deepEqual(classify({ tool: "click", id: "3" }, ctx([{ id: "3", role: "link", label: "Donate £10" }])), { cls: "self", reason: "pay" })
})

test("a wordless button over the page (a banner's ×) closes it freely; elsewhere it still asks", () => {
  const ctx = (items: PageMap["items"]) => ({ map: { ...SALON, items, forms: [{ n: 0, fillable: true }] }, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } })
  assert.deepEqual(classify({ tool: "click", id: "1" }, ctx([{ id: "1", role: "button", label: "", where: "dialog" }])), { cls: "free", reason: "close" })
  assert.equal(classify({ tool: "click", id: "2" }, ctx([{ id: "2", role: "button", label: "" }])).cls, "confirm")
  assert.equal(classify({ tool: "click", id: "3" }, ctx([{ id: "3", role: "button", label: "", where: "dialog", form: 0, type: "submit" }])).cls, "confirm")
})

test("typing what an approved fill would put in (the request's words or the saved value) is the plan's; another value asks", async () => {
  const FORM: PageMap = { ...SALON, forms: [{ n: 0, fillable: true }], items: [{ id: "1", role: "textbox", label: "Name", lock: "personal", form: 0, state: ["empty"] }, { id: "2", role: "textbox", label: "Phone", lock: "personal", form: 0, state: ["empty"] }, { id: "9", role: "button", label: "Book", type: "submit", form: 0 }] }
  const raw = { label: "", steps: ["Booking"], questions: [], risky: [{ tool: "fill", id: "1", text: "", key: "name.full" }, { tool: "fill", id: "2", text: "", key: "phone" }], prices: [] }
  const entries: FormEntry[] = [{ id: "n", key: "name.full", label: "", value: "Анна Петрова", updatedAt: 1 }, { id: "p", key: "phone", label: "", value: "+357 99 123456", updatedAt: 1 }]
  const run = async (typed: ToolCall[], request: string) => {
    const x = io([{ ok: true, plan: raw, token: "t" }, ...typed.map((c) => step(c, "confirm", "personal")), step({ tool: "done", summary: "ok" }, "free", "read")], { map: FORM, entries, playbook: null })
    const s = await drive(newState("h", request, "ru", FORM.url), x)
    if (s.status === "plan") {
      const { approvePlan } = await import("../src/shared/agent/runner.ts")
      return approvePlan(s, x, { answers: [], off: [] }).then((r) => ({ s: r, x }))
    }
    return { s, x }
  }
  const a = await run([{ tool: "type", id: "1", text: "Анна Петрова" }], "забронируй на имя Анна Петрова")
  assert.equal(a.s.status, "done", "the request's own words into the planned field")
  assert.equal(a.x.acted.length, 1)
  const b = await run([{ tool: "type", id: "2", text: "+357 99 123 456" }], "забронируй")
  assert.equal(b.s.status, "done", "the saved phone's own value")
  const c = await run([{ tool: "type", id: "2", text: "+44 20 7946 0000" }], "забронируй")
  assert.equal(c.s.status, "confirm", "another number asks")
})
