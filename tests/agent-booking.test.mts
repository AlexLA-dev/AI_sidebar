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
  assert.match(rulesLine(DEFAULT_RULES, true), /60 minutes either way; .*2 days later; 2 people .*«any» is its first option.*free in the person's calendar/)
  assert.doesNotMatch(rulesLine(DEFAULT_RULES, false), /calendar/)
})

test("the plan's booking is checked: a real date and times, a sane length, or none", () => {
  // (A session with someone is the person's choice unless the plan says otherwise.)
  assert.deepEqual(checkPlan(RAW).booking, { ...BOOKING, personal: true })
  assert.equal(checkPlan({ ...RAW, booking: { kind: "none", date: "", from: "", until: "", minutes: 0 } }).booking, undefined)
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, date: "tomorrow" } }).booking, undefined)
  assert.deepEqual(checkPlan({ ...RAW, booking: { ...BOOKING, from: "25:00", minutes: 9000 } }).booking, { ...BOOKING, personal: true, from: "08:00", minutes: 600 })
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
  const unbooked = await drive(newState("e", "haircut", "en", SALON.url), x)
  assert.equal(unbooked.error, "unbooked", "a booking that didn't happen isn't shown as done")
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

test("a summary bar with the total and the count chosen goes on; a pay or order word, or a checkout page, still pays (124)", () => {
  const ctx = (items: PageMap["items"], pay = false) => ({ map: { ...SALON, items, pay }, startHost: "www.salon.example.com", request: "book", confirmedHere: true, policy: { amazon: true } })
  assert.notEqual(classify({ tool: "click", id: "1" }, ctx([{ id: "1", role: "button", label: "€20 1 item • 30min" }])).reason, "pay")
  assert.notEqual(classify({ tool: "click", id: "1" }, ctx([{ id: "1", role: "button", label: "2 услуги · 36 €" }])).reason, "pay")
  assert.deepEqual(classify({ tool: "click", id: "2" }, ctx([{ id: "2", role: "button", label: "Pay €18 · 1 item" }])), { cls: "self", reason: "pay" })
  assert.deepEqual(classify({ tool: "click", id: "3" }, ctx([{ id: "3", role: "button", label: "€18 1 item" }], true)), { cls: "self", reason: "pay" })
  assert.deepEqual(classify({ tool: "click", id: "4" }, ctx([{ id: "4", role: "button", label: "€18 for 30min" }])), { cls: "self", reason: "pay" })
  // The count in other languages, from the lexicon.
  for (const label of ["3 Artikel · 54 €", "2 articles — 40 €", "1 servicio · 18 €", "2 ürün ₺300", "¥3,000 2点", "2개 30,000원", "1 dịch vụ 200.000₫"]) assert.notEqual(classify({ tool: "click", id: "5" }, ctx([{ id: "5", role: "button", label }])).reason, "pay", label)
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

test("the place's time zone: Paris 19:00 is Nicosia 20:00; free time is said in the place's clock", async () => {
  const { shiftZone, freeLineIn } = await import("../src/shared/agent/rules.ts")
  assert.deepEqual(shiftZone("2026-11-23", "19:00", "Europe/Paris", "Asia/Nicosia"), { date: "2026-11-23", time: "20:00" })
  assert.deepEqual(shiftZone("2026-11-23", "23:30", "Europe/London", "Asia/Nicosia"), { date: "2026-11-24", time: "01:30" })
  assert.deepEqual(shiftZone("2026-11-23", "19:00", "Asia/Nicosia", "Asia/Nicosia"), { date: "2026-11-23", time: "19:00" })
  assert.equal(freeLineIn("2026-11-23 20:00–22:30", "Europe/Paris").length > 0, true)
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, tz: "Europe/Paris" } }).booking?.tz, "Europe/Paris")
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, tz: "Mars/Olympus" } }).booking?.tz, undefined)
})

test("a slot in another zone is checked in the device's clock", async () => {
  const seen: string[] = []
  const raw = { ...RAW, booking: { ...BOOKING, tz: "Europe/Paris" } }
  const x = io([{ ok: true, plan: raw, token: "t" }, step({ tool: "click", id: "3", date: "2026-11-24", time: "17:45" }, "free", "click", 'button "17:45"'), step({ tool: "done", summary: "x" }, "free", "read")], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  x.slotFree = async (date, time) => (seen.push(`${date} ${time}`), true)
  process.env.TZ = process.env.TZ ?? ""
  await drive(newState("z", "haircut", "en", SALON.url), x)
  const { shiftZone } = await import("../src/shared/agent/rules.ts")
  assert.deepEqual(seen, [`${shiftZone("2026-11-24", "17:45", "Europe/Paris").date} ${shiftZone("2026-11-24", "17:45", "Europe/Paris").time}`])
})

test("a question's times come from the page: a time only the Calendar has isn't offered", async () => {
  const { timesIn, pageChoices } = await import("../src/shared/agent/rules.ts")
  assert.deepEqual(timesIn("5:45 PM, 17.30 or 9am"), ["17:45", "17:30", "09:00"])
  assert.deepEqual(pageChoices(["Вт 24 ноя, 14:30", "Пн 23 ноя, 20:00", "Другой день"], new Set(["14:30", "14:45"])), ["Вт 24 ноя, 14:30", "Другой день"])
  const x = io([{ ok: true, plan: { ...RAW, booking: { ...BOOKING, venue: "Cutter" } }, token: "t" }, step({ tool: "ask_user", question: "Which?", choices: ["17:45", "20:00", "Another day"] }, "free", "read")], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  const s = await drive(newState("q", "haircut at Cutter", "en", SALON.url), x)
  assert.deepEqual(s.choices, ["17:45", "Another day"], "20:00 isn't on the page")
})

test("obvious presses go together; each is checked on the page as it is and only a free one is done", async () => {
  const { checkCall } = await import("../src/shared/agent/call.ts")
  const r = checkCall({ tool: "click", id: "1", also: [{ id: "4", why: "" }, { id: "99", why: "" }, { id: "1", why: "" }], why: "" }, SALON, [])
  assert.deepEqual(r.ok && r.call.also, [{ id: "4", why: "" }], "unknown ids and the first press itself are dropped")
  const PAGE: PageMap = { ...SALON, items: [{ id: "1", role: "button", label: "Haircut" }, { id: "2", role: "button", label: "Any professional" }, { id: "3", role: "button", label: "Select Tue, Nov 24" }, { id: "4", role: "button", label: "Pay €18 now" }, { id: "5", role: "button", label: "17:45" }] }
  const x = io([{ ok: true, plan: RAW, token: "t" }, step({ tool: "click", id: "1", also: [{ id: "2" }, { id: "3" }, { id: "4" }] }, "free", "click", 'button "Haircut"'), step({ tool: "done", summary: "x" }, "free", "read")], { map: PAGE, entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  await drive(newState("b", "haircut", "en", PAGE.url), x)
  assert.deepEqual(x.acted.map((c) => c.id), ["1", "2", "3"], "paying stops the batch")
  const y = io([{ ok: true, plan: RAW, token: "t" }, step({ tool: "click", id: "1", also: [{ id: "5" }] }, "free", "click", 'button "Haircut"'), step({ tool: "done", summary: "x" }, "free", "read")], { map: PAGE, entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  await drive(newState("c", "haircut", "en", PAGE.url), y)
  assert.deepEqual(y.acted.map((c) => c.id), ["1"], "a time slot is never pressed in a batch (it needs its Calendar check)")
})

test("the plan follows the request's language; the venue is the agent's to choose by the rules", async () => {
  const { sameScript } = await import("../netlify/shared/act.mts")
  assert.equal(sameScript("Запиши меня на стрижку", "Searching men's haircuts"), false)
  assert.equal(sameScript("Запиши меня на стрижку", "Ищу барбершоп в London"), true)
  assert.equal(sameScript("book a table", "Booking"), true)
  assert.match(rulesLine(DEFAULT_RULES, true), /choose it yourself: .*rated 4\.5 or more .*try the next two before asking/)
  assert.match(rulesLine({ ...DEFAULT_RULES, chooseVenue: false }, true), /ask which one/)
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /never ask which one/)
  assert.match(act, /never offer or choose a time from <calendar> alone/)
})

test("a place the agent chose: its first two questions go back to try the next place; a named place asks at once", async () => {
  const ask = step({ tool: "ask_user", question: "No evening slots here. What now?", choices: [] }, "free", "read")
  const x = io([{ ok: true, plan: RAW, token: "t" }, ask, ask, ask], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  const s = await drive(newState("v", "find a barbershop", "en", SALON.url), x)
  assert.equal(s.status, "asked")
  assert.equal(s.log.filter((e) => /refused: the request names no place/.test(e.result)).length, 2)
  const named = { ...RAW, booking: { ...BOOKING, venue: "Cutter Barbershop" } }
  const y = io([{ ok: true, plan: named, token: "t" }, ask], { entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  const s2 = await drive(newState("w", "book at Cutter", "en", SALON.url), y)
  assert.equal(s2.status, "asked")
  assert.equal(s2.log.filter((e) => /refused: the request names no place/.test(e.result)).length, 0)
})

const RESULTS: PageMap = {
  url: "https://www.salon.example.com/search?q=barber", title: "Results", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [],
  items: [
    { id: "1", role: "link", label: "Chez Milo French · Average price €19 9.1 (7936)", href: "/r/chez-milo" },
    { id: "2", role: "link", label: "Fellini Italian · Average price €25 9.3 (812 reviews)", href: "/r/fellini" },
    { id: "3", role: "link", label: "Batistou Italian pizza 8.6 (95 reviews)", href: "/r/batistou" },
    { id: "4", role: "link", label: "Luigi Italian 9.6 (4 reviews)", href: "/r/luigi" },
    { id: "5", role: "link", label: "Partner site 4.9 (900 reviews)", href: "other.example.org/x" }
  ]
}

test("places come from the results list: matching the request, in the rules' order (rating, then reviews), not the page's", async () => {
  const { venuesOn, rankVenues, cardsOf } = await import("../src/shared/agent/venues.ts")
  const all = venuesOn(RESULTS)
  assert.deepEqual(all.map((v) => v.url.split("/").pop()), ["chez-milo", "fellini", "batistou", "luigi"], "another site's link isn't a place here")
  assert.equal(all[0].rating, 4.55, "TheFork's /10 counts as /5")
  const ranked = rankVenues(all, cardsOf(RESULTS), ["Italian", "italien"], 4.2)
  assert.deepEqual(ranked.map((v) => v.url.split("/").pop()), ["fellini", "batistou"], "French dropped (not Italian), Luigi dropped (4 reviews)")
  assert.deepEqual(rankVenues(all, cardsOf(RESULTS), [], 4.5).map((v) => v.url.split("/").pop()), ["fellini", "chez-milo"], "9.3 before 9.1, whatever comes first on the page")
})

test("a misfit place is refused; when one doesn't fit, the device opens the next by its link", async () => {
  const opened: string[] = []
  const raw = { ...RAW, booking: { ...BOOKING, kind: "table", match: ["Italian"] } }
  const pages = [RESULTS]
  const x = io([
    { ok: true, plan: raw, token: "t" },
    step({ tool: "click", id: "1" }, "free", "click", 'link "Chez Milo"'),
    step({ tool: "click", id: "2" }, "free", "click", 'link "Fellini"'),
    step({ tool: "ask_user", question: "No evening slots at Fellini", choices: [] }, "free", "read"),
    step({ tool: "done", summary: "x" }, "free", "read")
  ], { map: RESULTS, entries: [fact("Gender", "Man"), fact("example.com · Specialist", "Y")], playbook: ["a"] })
  x.map = async () => pages[pages.length - 1]
  x.rules = async () => ({ ...DEFAULT_RULES, rating: 4.2 })
  x.open = async (url) => {
    opened.push(url)
  }
  const s = await drive(newState("n", "find an Italian restaurant", "en", RESULTS.url), x)
  assert.match(s.log.find((e) => /refused: «Chez Milo/.test(e.result))?.result ?? "", /doesn't fit the request or the rules; the ones that do: «Fellini/)
  assert.deepEqual(x.acted.map((c) => c.id), ["2"], "only the fitting place was opened")
  assert.equal(opened.length, 1)
  assert.match(opened[0], /\/r\/(fellini|batistou)$/)
  assert.match(s.log.find((e) => /the device opened the next place/.test(e.result))?.result ?? "", /by the rules/)
})

test("the watchdog: a visible page pings while its task runs; a run idle for 45 s is picked up again", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /if \(!document\.hidden\) void sendBackground\(\{ type: "agentPing" \}\)/)
  assert.match(app, /setInterval\(ping, 20_000\)/)
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  assert.match(bg, /case "agentPing":[\s\S]{0,200}resume\(tab, PING_IDLE_MS\)/)
  assert.match(bg, /const PING_IDLE_MS = 45_000/)
})

test("a booking's contact form isn't the place failing: saved name, e-mail and phone go in by the plan; a missing one is asked once, with «remember»", async () => {
  const { contactAsked } = await import("../src/shared/agent/taskplan.ts")
  const opened: string[] = []
  const CONTACT: PageMap = {
    ...RESULTS, url: "https://www.example.com/r/fellini/book",
    forms: [{ n: 0, fillable: true }],
    items: [
      { id: "1", role: "textbox", label: "Email", type: "email", lock: "personal", form: 0 },
      { id: "2", role: "textbox", label: "Phone", type: "tel", lock: "personal", form: 0 },
      { id: "9", role: "button", label: "Continue", form: 0 }
    ]
  }
  const raw = { ...RAW, questions: [], booking: { ...BOOKING, match: ["Italian"] } }
  const pages = [RESULTS]
  const saved: FormEntry[] = [{ id: "e", key: "email", label: "", value: "anna@example.org", updatedAt: 1 }]
  const x = io([
    { ok: true, plan: raw, token: "t" },
    step({ tool: "click", id: "2" }, "free", "click", 'link "Fellini"'),
    step({ tool: "fill", id: "1", key: "email" }, "confirm", "fill", 'field "Email"'),
    step({ tool: "ask_user", question: "Which phone number should the booking use?", choices: [] }, "free", "read")
  ], { map: RESULTS, entries: saved, playbook: null })
  x.map = async () => pages[pages.length - 1]
  x.act = async (c) => {
    x.acted.push(c)
    if (c.id === "2" && c.tool === "click") pages.push(CONTACT)
    return { ok: true }
  }
  x.rules = async () => ({ ...DEFAULT_RULES, rating: 4.2 })
  x.open = async (url) => void opened.push(url)
  let s = await drive(newState("c", "book an Italian restaurant for two at 20:00", "en", RESULTS.url), x)
  assert.equal(s.status, "plan")
  const contact = s.plan!.perms.find((p) => p.reason === "contact")
  assert.deepEqual(contact?.keys, ["email"], "the card's one line: the saved contact details only")
  const { approvePlan } = await import("../src/shared/agent/runner.ts")
  s = await approvePlan(s, x, { answers: [], off: [] })
  assert.equal(s.status, "asked", "the missing phone is asked")
  assert.deepEqual(opened, [], "no next place for a details form")
  assert.ok(x.acted.some((c) => c.tool === "fill" && c.key === "email"), "the saved e-mail went in without a question")
  assert.equal(s.askKey, "phone", "the answer may be kept in «Мои данные»")
  assert.equal(contactAsked("Какой e-mail указать для брони?"), "email")
  assert.equal(contactAsked("Your name and phone?"), null, "two details: no single key to keep")
})

test("the contact fill covers saved contact keys into the person's fields only, never a secret field or another key", async () => {
  const { covered, addContactFill } = await import("../src/shared/agent/taskplan.ts")
  const plan = buildPlan(checkPlan(RAW)!, { map: SALON, startHost: "salon.example.com", request: "book", confirmedHere: false, policy: { amazon: true } })
  plan.approved = true
  addContactFill(plan, ["email", "phone", "address.city"], "salon.example.com")
  const m: PageMap = { ...SALON, url: "https://www.salon.example.com/details", items: [{ id: "1", role: "textbox", label: "Email", lock: "personal" }, { id: "2", role: "textbox", label: "Card", lock: "secret" }, { id: "3", role: "textbox", label: "City", lock: "personal" }] }
  const v = { cls: "confirm" as const, reason: "fill" }
  assert.ok(covered(plan, { tool: "fill", id: "1", key: "email" }, v, m, "book"))
  assert.equal(covered(plan, { tool: "fill", id: "2", key: "email" }, v, m, "book"), null, "never into a secret field")
  assert.equal(covered(plan, { tool: "fill", id: "3", key: "address.city" }, v, m, "book"), null, "only contact keys")
  assert.equal(covered(plan, { tool: "fill", id: "1", key: "email" }, v, { ...m, url: "https://other.example.net/x" }, "book"), null, "only on the booking's site")
})

test("a saved detail of another kind never goes into a field (the full name into «email»): refused, then the missing e-mail is asked once", async () => {
  const FORM: PageMap = { ...SALON, url: "https://www.thefork.com/booking/x", forms: [{ n: 0, fillable: true }], items: [{ id: "1", role: "textbox", label: "email", type: "email", lock: "personal", form: 0 }, { id: "9", role: "button", label: "Continue", form: 0 }] }
  const raw = { ...RAW, questions: [], risky: [] }
  const name: FormEntry = { id: "n", key: "name.full", label: "", value: "Anna Petrova", updatedAt: 1 }
  const x = io([
    { ok: true, plan: raw, token: "t" },
    step({ tool: "fill", id: "1", key: "name.full" }, "confirm", "fill", 'field "email"'),
    step({ tool: "ask_user", question: "Какой e-mail указать для брони?", choices: [] }, "free", "read")
  ], { map: FORM, entries: [name], playbook: null })
  let s = await drive(newState("k", "забронируй", "ru", FORM.url), x)
  if (s.status === "plan") {
    const { approvePlan } = await import("../src/shared/agent/runner.ts")
    s = await approvePlan(s, x, { answers: [], off: [] })
  }
  assert.ok(!x.acted.some((c) => c.tool === "fill"), "nothing filled")
  assert.match(s.log.find((e) => /refused: the field "email" asks for the email/.test(e.result))?.result ?? "", /<saved> has no email: ask the person/)
  assert.equal(s.status, "asked")
  assert.equal(s.askKey, "email")
})

test("a diner's review card (a name, their reviews, a score, «5 months ago») is not a place; places share the list's path", async () => {
  const { venuesOn } = await import("../src/shared/agent/venues.ts")
  const PAGE: PageMap = {
    url: "https://www.thefork.com/restaurants/paris-c415144/italian", title: "Italian", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [],
    items: [
      { id: "1", role: "link", label: "Borgo Paris Italian 9.4 (2179 reviews)", href: "/restaurant/borgo-paris-r1" },
      { id: "2", role: "link", label: "Tra di Noi Italian 9.6 (201 reviews)", href: "/restaurant/tra-di-noi-r2" },
      { id: "3", role: "link", label: "Rhadamanthe Italian 9.5 (90 reviews)", href: "/restaurant/rhadamanthe-r3" },
      { id: "4", role: "link", label: "M Marine E. 20 reviews 10 5 months ago A pizzeria with the authentic taste of Italy", href: "/restaurant/senza-nome-r9/reviews" },
      { id: "5", role: "link", label: "Top 100 guide 9.9 (500 reviews)", href: "/guide/top-100" }
    ]
  }
  assert.deepEqual(venuesOn(PAGE).map((v) => v.name.split(" ")[0]), ["Borgo", "Tra", "Rhadamanthe"])
})

test("any reservable thing: a stay or a rental by days, a slot, a ticket; who or where matters decides who chooses", () => {
  const stay = checkPlan({ ...RAW, booking: { ...BOOKING, kind: "stay", date: "2026-12-26", dateEnd: "2026-12-29", personal: true, minutes: 0 } }).booking!
  assert.equal(stay.kind, "stay")
  assert.equal(stay.dateEnd, "2026-12-29")
  assert.equal(stay.personal, true)
  // A last day before the first, or a year on, isn't one.
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, kind: "rental", date: "2026-12-26", dateEnd: "2026-12-20" } }).booking!.dateEnd, undefined)
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, kind: "rental", date: "2026-12-26", dateEnd: "2028-01-01" } }).booking!.dateEnd, undefined)
  // Said by the plan: any parking spot or yoga class then is the rules' choice.
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, kind: "slot", personal: false } }).booking!.personal, false)
  // Not said: a session with someone and a stay are the person's; a table, a slot, a ticket, a rental the rules'.
  for (const [kind, personal] of [["appointment", true], ["stay", true], ["table", false], ["slot", false], ["ticket", false], ["rental", false]] as const)
    assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, kind } }).booking!.personal, personal, kind)
  assert.equal(checkPlan({ ...RAW, booking: { ...BOOKING, kind: "cinema" } }).booking, undefined)
})

test("a card's own choice remembered («@page», «@auto») counts only where this card offers it", async () => {
  const { optionFor } = await import("../src/shared/agent/taskplan.ts")
  assert.equal(optionFor(["@any", "Yasmin", "Angelos"], "@page"), "")
  assert.equal(optionFor(["@any", "@page"], "@page"), "@page")
  assert.equal(optionFor(["@any", "Yasmin"], "@any"), "@any")
})

test("a contact the request already gives isn't asked again on the card (the director on 125)", async () => {
  const { contactInWords } = await import("../src/shared/agent/taskplan.ts")
  const req = "Забронируй столик на 20 декабря в 19:00 на двоих, имя Мария Ким, почта maria@example.com"
  assert.equal(contactInWords("email", req), true)
  assert.equal(contactInWords("phone", req), false, "a date and a time aren't a phone")
  assert.equal(contactInWords("phone", "столик, телефон +357 99 123456"), true)
  assert.equal(contactInWords("phone", "table for 2 on 2026-12-20 at 19:30"), false)
  assert.equal(contactInWords("email", "book a table, my email is the usual one"), false)
})

test("the contact fill leaves out what the request gives: its e-mail, its phone, a name it types (the director on 126)", async () => {
  const { addContactFill } = await import("../src/shared/agent/taskplan.ts")
  const plan = buildPlan(checkPlan(RAW)!, { map: SALON, startHost: "salon.example.com", request: "book", confirmedHere: false, policy: { amazon: true } })
  addContactFill(plan, ["name.full", "email", "phone"], "salon.example.com", "столик, почта maria@example.com")
  assert.deepEqual(plan.perms.find((p) => p.reason === "contact")?.keys, ["name.full", "phone"])
  const plan2 = buildPlan(checkPlan(RAW)!, { map: SALON, startHost: "salon.example.com", request: "book", confirmedHere: false, policy: { amazon: true } })
  plan2.perms.push({ id: "pp", kind: "personal", reason: "personal", label: "Имя", fields: ["Имя"], host: "salon.example.com", on: true })
  addContactFill(plan2, ["name.full", "email"], "salon.example.com", "столик, телефон +357 99 123456")
  assert.deepEqual(plan2.perms.find((p) => p.reason === "contact")?.keys, ["email"])
  const plan3 = buildPlan(checkPlan(RAW)!, { map: SALON, startHost: "salon.example.com", request: "book", confirmedHere: false, policy: { amazon: true } })
  addContactFill(plan3, ["email"], "salon.example.com", "почта a@b.example")
  assert.equal(plan3.perms.find((p) => p.reason === "contact"), undefined, "nothing left: no line")
})
