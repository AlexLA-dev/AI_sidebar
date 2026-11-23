// 124, the owner on fresha: «по яркости даты видно доступна ли она к букированию… агент сделал уже более 11 шагов».
// Days and slots the page shows as not choosable are marked in the map and never pressed; two date steps without
// progress end in the one question; the card asks what the request left open and shows the place the rules picked.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { approvePlan, dateStep, drive, isDateLabel, newState, seesDate, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap } from "../src/shared/agent/types.ts"

function domMap(html: string, colors: Record<string, string> = {}): PageMap {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
  // linkedom has no layout: computed styles from a small table (text colour by id, opacity and pointer-events inline).
  ;(window as any).getComputedStyle = (el: Element) => {
    const inline = (el.getAttribute("style") ?? "")
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`).exec(inline)?.[1]?.trim()
    return { display: "block", visibility: "visible", contentVisibility: "visible", opacity: get("opacity") ?? "1", pointerEvents: get("pointer-events") ?? "auto", color: colors[el.id] ?? "rgb(20, 20, 20)", backgroundColor: el.tagName === "BODY" ? "rgb(255, 255, 255)" : "rgba(0, 0, 0, 0)" }
  }
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  if ((document as any).defaultView !== window) Object.defineProperty(document, "defaultView", { configurable: true, get: () => window })
  for (const el of document.querySelectorAll("*")) (el as any).getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 10, right: 80, width: 70, height: 40 })
  return (globalThis as any).__buildMap(document)
}

before(async () => {
  // The content script's map, bundled as the extension has it (its imports are the bundler's).
  const dir = mkdtempSync(join(tmpdir(), "cf-dates-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export { buildMap } from "${new URL("../src/content/agent/map.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "map.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", define: { __TARGET__: '"safari"', __API_BASE__: '""', __TEST_PLAN__: '""' } })
  ;(globalThis as any).__buildMap = (await import(pathToFileURL(out).href)).buildMap
})

test("days the page shows as not choosable are marked: a disabled class, faded, no presses, or greyed among their siblings", async () => {
  const map = domMap(`<div class="strip"><div>
    <button id="d26" class="day selected" aria-selected="true">Sat 26 Dec</button>
    <button id="d27" class="day">Sun 27 Dec</button>
    <button id="d28" class="day day--disabled">Mon 28 Dec</button>
    <button id="d29" class="day">Tue 29 Dec</button>
    <button id="d30" class="day">Wed 30 Dec</button>
    <button id="d31" class="day" style="opacity: 0.4">Thu 31 Dec</button>
    <button id="d1" class="day" style="pointer-events: none">Fri 1 Jan</button>
  </div></div>`, { d27: "rgb(200, 200, 200)" })
  const state = (label: string) => map.items.find((i) => i.label === label)?.state ?? []
  assert.ok(state("Sun 27 Dec").includes("unavailable"), "greyed among its siblings")
  assert.ok(state("Mon 28 Dec").includes("unavailable"), "its class")
  assert.ok(state("Thu 31 Dec").includes("unavailable"), "faded")
  assert.ok(state("Fri 1 Jan").includes("unavailable"), "takes no presses")
  assert.ok(!state("Tue 29 Dec").includes("unavailable"))
  assert.ok(!state("Sat 26 Dec").includes("unavailable"), "the chosen day isn't")
})

const day = (id: string, label: string, s: string[] = []): MapItem => ({ id, role: "button", label, ...(s.length ? { state: s } : {}) })
const page = (items: MapItem[]): PageMap => ({ url: "https://www.fresha.com/a/x/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "Sarbast is not available on this date. Available from Tue, Dec 29", forms: [], items })
const booking = () => ({ plan: { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment" as const, date: "2026-12-26", from: "09:00", until: "18:00", minutes: 30 } } } as unknown as AgentState)

test("a greyed day is never pressed, the same day isn't pressed twice, two date steps without progress end in the one question", () => {
  const strip = [day("1", "Sat 26 Dec", ["selected"]), day("2", "Sun 27 Dec", ["unavailable"]), day("3", "Mon 28 Dec", ["unavailable"]), day("4", "Tue 29 Dec"), day("5", "Wed 30 Dec"), day("6", "Thu 31 Dec")]
  const map = page(strip)
  let s = booking()
  assert.match(dateStep(s, map, strip[1]) ?? "", /shown as not available on the page/)
  assert.equal(dateStep(s, map, strip[3]), null, "an available day")
  assert.match(dateStep(s, map, strip[3]) ?? "", /was pressed already/)
  assert.equal(dateStep(s, map, strip[4]), null, "a second date step")
  assert.match(dateStep(s, map, strip[5]) ?? "", /two date steps went nowhere: don't press more dates\. ask_user once now, with the page's real nearest options/)
  // A time chosen: the dates got somewhere, the count starts again.
  s = booking()
  assert.equal(dateStep(s, map, strip[3]), null)
  assert.equal(dateStep(s, map, { id: "9", role: "button", label: "10:30" }), null)
  assert.equal(s.dateSteps, 0)
  // Every day greyed until one is tapped: one tap, then the rules again.
  const grey = page(strip.map((d) => ({ ...d, state: ["unavailable"] })))
  s = booking()
  assert.equal(dateStep(s, grey, grey.items[3]), null, "one tap to wake the strip")
  assert.match(dateStep(s, grey, grey.items[4]) ?? "", /not available/)
  for (const l of ["Sat 26 Dec", "вт, 29 дек", "Di. 29. Dez", "29.12", "Sáb 26"]) assert.equal(isDateLabel(l), true, l)
  for (const l of ["10:30", "Book now", "Sarbast", "€25"]) assert.equal(isDateLabel(l), false, l)
})

test("the card shows the place the rules picked as a changeable answer; a changed one fixes the booking's place, the pick stays the rules'", async () => {
  const LIST: PageMap = {
    url: "https://www.thefork.com/restaurants/paris", title: "Italian restaurants", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [],
    items: [
      { id: "1", role: "link", label: "Il Gusto Italian 9.1 (320 reviews)", href: "/restaurant/il-gusto" },
      { id: "2", role: "link", label: "Borgo Paris Italian 9.4 (2179 reviews)", href: "/restaurant/borgo" },
      { id: "3", role: "link", label: "Tra di Noi Italian 9.6 (201 reviews)", href: "/restaurant/tra" },
      { id: "4", role: "button", label: "Book" }
    ]
  }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [{ tool: "click", id: "4", text: "Book", key: "" }], booking: { kind: "table", date: "2026-11-27", from: "19:00", until: "21:00", minutes: 90, tz: "Europe/Paris", venue: "", match: ["Italian"], area: [] } }
  const mk = (): RunnerIO => {
    const replies: any[] = [{ ok: true, plan: RAW, token: "t" }]
    return { map: async () => LIST, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
      device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } }
  }
  let io = mk()
  let s = await drive(newState("v", "Book a table at an Italian restaurant on Friday at 20:00", "en", LIST.url), io)
  const q = s.plan!.questions.find((x) => x.kind === "venue")!
  assert.deepEqual(q.options, ["Il Gusto Italian", "Borgo Paris Italian", "Tra di Noi Italian"])
  assert.equal(q.pick, "Il Gusto Italian", "the rules' first in the page's order")
  assert.equal(s.plan!.how?.rating, 0, "no «I'll pick the place» line besides the shown pick")
  // Left as picked: still the rules' (the next is tried when it doesn't fit).
  let after = await approvePlan(s, io, { answers: s.plan!.questions.map((x) => x.pick ?? ""), off: [] })
  assert.equal(after.plan!.booking!.venue, undefined)
  // Changed on the card: that place, nothing chosen on the way.
  io = mk()
  s = await drive(newState("w", "Book a table at an Italian restaurant on Friday at 20:00", "en", LIST.url), io)
  after = await approvePlan(s, io, { answers: s.plan!.questions.map((x) => (x.kind === "venue" ? "Tra di Noi Italian" : "")), off: [] })
  assert.equal(after.plan!.booking!.venue, "Tra di Noi Italian")
  assert.equal(after.chooseVenue, false)
})

test("the page has shown the booking's day: a strip's day with its month, «26.12», or a calendar's bare day under its month", () => {
  const page = (labels: string[], text = ""): PageMap => ({ url: "https://www.fresha.com/a/x", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text, forms: [], items: labels.map((label, i) => ({ id: String(i + 1), role: "button", label })) })
  assert.equal(seesDate(page(["Wed 25 Nov", "Thu 26 Nov", "Sat 28 Nov"]), "2026-12-26"), false, "26 Nov isn't 26 Dec")
  assert.equal(seesDate(page(["Fri 25 Dec", "Sat 26 Dec"]), "2026-12-26"), true)
  assert.equal(seesDate(page(["сб, 26 дек."]), "2026-12-26"), true)
  assert.equal(seesDate(page(["26.12."]), "2026-12-26"), true)
  assert.equal(seesDate(page(["25", "26", "27"], "December 2026"), "2026-12-26"), true, "a calendar's cells under «December 2026»")
  assert.equal(seesDate(page(["25", "26", "27"], "November 2026"), "2026-12-26"), false, "November's calendar")
  assert.equal(seesDate(page(["11:30 AM", "12:26"], "December"), "2026-12-26"), false, "a time isn't a day")
})

test("a question about the booking's day before the page showed it is sent back once to go there (fresha, 124: «26 Dec closed, nearest Sat 5 Dec» unseen)", async () => {
  const STRIP: PageMap = {
    url: "https://www.fresha.com/a/cutter/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "Select a date Pick a time", forms: [],
    items: [
      { id: "1", role: "button", label: "Wed 25 Nov" }, { id: "2", role: "button", label: "Thu 26 Nov" }, { id: "3", role: "button", label: "Sat 28 Nov" },
      { id: "4", role: "button", label: "Open calendar" }, { id: "5", role: "button", label: "11:30 AM" }
    ]
  }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Cutter Barbershop", match: [], area: [] } }
  const ASK = { ok: true, call: { tool: "ask_user", question: "26 Dec is closed. Nearest Saturday is 5 Dec?", choices: ["Sat 5 Dec", "Another day"] }, verdict: { cls: "free", reason: "read" } }
  const mk = (replies: any[]): RunnerIO => ({ map: async () => STRIP, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } })
  let io = mk([{ ok: true, plan: RAW, token: "t" }, ASK, ASK])
  let s = await drive(newState("d1", "Book me a haircut in a month on Saturday", "en", STRIP.url), io)
  let after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  const sent = after.log.find((l) => l.call.tool === "ask_user" && /^refused/.test(l.result ?? ""))
  assert.ok(sent && /hasn't shown Sat,? 26 Dec 2026/.test(sent.result!), "sent back with the day to go to")
  assert.equal(after.status, "asked", "asked again: the question goes to the person (one nudge only)")
  // Once the page shows the day, the question goes straight through.
  STRIP.items.push({ id: "6", role: "button", label: "Sat 26 Dec" })
  io = mk([{ ok: true, plan: RAW, token: "t" }, ASK])
  s = await drive(newState("d2", "Book me a haircut in a month on Saturday", "en", STRIP.url), io)
  after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  assert.equal(after.log.some((l) => /^refused/.test(l.result ?? "")), false)
  assert.equal(after.status, "asked")
})

test("the asked day shown greyed is pressed once to hear the page; a question before that press makes the device press it (fresha, 124: «Sat 26 Dec» greyed until pressed: «fully booked… Available from Mon, Dec 28»)", async () => {
  const STRIP: PageMap = {
    url: "https://www.fresha.com/a/cutter/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "Select a date", forms: [],
    items: [
      { id: "1", role: "button", label: "Wed 9 Dec" }, { id: "2", role: "button", label: "Fri 25 Dec", state: ["unavailable"] },
      { id: "3", role: "button", label: "Sat 26 Dec", state: ["unavailable"] }, { id: "4", role: "button", label: "Sun 27 Dec", state: ["unavailable"] }
    ]
  }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Cutter Barbershop", match: [], area: [] } }
  const ASK = { ok: true, call: { tool: "ask_user", question: "26 Dec and the days around are closed; free only until 9 Dec", choices: ["Wed 9 Dec"] }, verdict: { cls: "free", reason: "read" } }
  const PRESS27 = { ok: true, call: { tool: "click", id: "4", why: "next day" }, verdict: { cls: "free", reason: "click" } }
  const pressed: string[] = []
  const replies: any[] = [{ ok: true, plan: RAW, token: "t" }, ASK, PRESS27, ASK]
  const io: RunnerIO = { map: async () => STRIP, act: async (c: any) => { pressed.push(c.id); return { ok: true } }, waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  const s = await drive(newState("g1", "Book me a haircut in a month on Saturday", "en", STRIP.url), io)
  const after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  const held = after.log.find((l) => l.call.tool === "ask_user" && /^held/.test(l.result ?? ""))
  assert.ok(held && /pressed the asked day «Sat 26 Dec»/.test(held.result!), "the device pressed the asked day itself")
  assert.deepEqual(pressed, ["3"], "the asked day pressed once though greyed; another greyed day isn't")
  assert.equal(after.status, "asked", "then the question goes to the person")
})

test("the place pick reads the list's cards past the map's first part; the option the request names is shown chosen (TheFork, Treatwell, 124)", async () => {
  const TOP: PageMap = {
    url: "https://www.treatwell.co.uk/places/treatment-mens-haircut/in-soho-london-uk/", title: "Men's haircuts in Soho", lang: "en", more: 6, part: 1, parts: 2, text: "", forms: [],
    items: [{ id: "1", role: "textbox", label: "Treatment or venue" }, { id: "2", role: "button", label: "Sort by" }]
  }
  const REST: PageMap = { ...TOP, part: 2, more: 0, items: [
    { id: "10", role: "link", label: "Ruffians Soho 4.9 (812 reviews) Soho, London Men's Haircut from £40", href: "/place/ruffians-soho/" },
    { id: "11", role: "link", label: "Pall Mall Barbers 4.8 (1204 reviews) Soho, London Men's Haircut from £35", href: "/place/pall-mall-barbers/" },
    { id: "12", role: "link", label: "Blade Soho 4.7 (530 reviews) Soho, London Men's Haircut from £30", href: "/place/blade-soho/" }
  ] }
  const RAW = { label: "booking", steps: ["a"], prices: [], fromChat: "", risky: [],
    questions: [
      { q: "Какая услуга?", options: ["Men's Haircut", "Wash & Haircut"], fact: "pref:Услуга", pick: "Men's Haircut" },
      { q: "Какой мастер?", options: ["Любой мастер", "Sam"], fact: "pref:Мастер", pick: "Kim" }
    ],
    booking: { kind: "appointment", date: "2026-12-26", from: "12:00", until: "18:00", minutes: 30, tz: "Europe/London", venue: "", match: ["Men's Haircut"], area: ["Soho"] } }
  const parts: number[] = []
  const replies: any[] = [{ ok: true, plan: RAW, token: "t" }]
  const io: RunnerIO = { map: async (o?: { part?: number }) => { parts.push(o?.part ?? 1); return o?.part === 2 ? REST : TOP }, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  const s = await drive(newState("p1", "Запиши меня на мужскую стрижку в субботу 26 декабря после 12", "ru", TOP.url), io)
  assert.ok(parts.includes(2), "the next part was read on the device")
  const venue = s.plan!.questions.find((q) => q.kind === "venue")!
  assert.ok(venue && venue.options.length === 3 && venue.pick === venue.options[0], "the rules' place shown chosen")
  assert.equal(s.plan!.questions[0].pick, "Men's Haircut", "the service the request names")
  assert.equal(s.plan!.questions[1].pick, undefined, "a pick that isn't an option is dropped")
})

test("a time is pressed only for the day the page has chosen (fresha, 124: 11:30 of the first day «booked» as Sat 26 Dec)", () => {
  const st = (): AgentState => ({ ...newState("s", "haircut", "en", "https://www.fresha.com/a/x"), plan: { booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30 } } as any })
  const page = (items: MapItem[]): PageMap => ({ url: "https://www.fresha.com/a/x", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items })
  const slot: MapItem = { id: "9", role: "button", label: "11:30 AM" }
  assert.equal(isDateLabel("Select Tue, Nov 24, 2026"), true, "the US order")
  // The greyed 26th, nothing chosen: the times aren't the 26th's.
  let why = dateStep(st(), page([{ id: "1", role: "button", label: "Tue 22 Dec" }, { id: "2", role: "button", label: "Sat 26 Dec", state: ["unavailable"] }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "11:30" })
  assert.ok(why && /isn't chosen/.test(why))
  // Another day chosen.
  why = dateStep(st(), page([{ id: "1", role: "button", label: "Select Tue, Nov 24, 2026", state: ["selected"] }, { id: "2", role: "button", label: "Select Sat, Dec 26, 2026" }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "11:30" })
  assert.ok(why && /chosen day is «Select Tue, Nov 24, 2026»/.test(why))
  // The 26th chosen: fine.
  why = dateStep(st(), page([{ id: "2", role: "button", label: "Sat 26 Dec", state: ["selected"] }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "11:30" })
  assert.equal(why, null)
  // A page that marks no day and shows the 26th plainly: fine.
  why = dateStep(st(), page([{ id: "2", role: "button", label: "Sat 26 Dec" }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "11:30" })
  assert.equal(why, null)
})

test("the person's answer counts the date steps again (fresha, 124: «Mon 28 Dec» chosen, then refused as a third date step)", async () => {
  const { answer } = await import("../src/shared/agent/runner.ts")
  const st: AgentState = { ...newState("a", "haircut", "en", "https://www.fresha.com/a/x"), status: "asked", summary: "26 Dec is full", dateSteps: 2, lastDate: "Sun 27 Dec" }
  const io = { save: async () => {}, map: async () => null, waitPage: async () => {} } as any
  const after = await answer(st, io, "reply", ["Mon 28 Dec"]).catch(() => st)
  assert.equal(after.dateSteps, 0)
  assert.equal(after.lastDate, undefined)
})
