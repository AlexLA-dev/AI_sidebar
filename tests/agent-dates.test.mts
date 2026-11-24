// 124, the owner on a salon booking site: «по яркости даты видно доступна ли она к букированию… агент сделал уже более 11 шагов».
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
import { approvePlan, bookingFrame, cancelTerms, recapOf, widgetDay, dateStep, dayItems, drive, isDateLabel, newState, seesDate, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap } from "../src/shared/agent/types.ts"

function domMap(html: string, colors: Record<string, string> = {}, url = ""): PageMap {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
  if (url) { const loc = new URL(url); Object.defineProperty(document, "location", { configurable: true, get: () => loc }); Object.defineProperty(document, "baseURI", { configurable: true, get: () => url }); Object.defineProperty(window, "location", { configurable: true, get: () => loc }) }
  // linkedom has no layout: computed styles from a small table (text colour by id, opacity and pointer-events inline).
  ;(window as any).getComputedStyle = (el: Element) => {
    const inline = (el.getAttribute("style") ?? "")
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`).exec(inline)?.[1]?.trim()
    return { display: "block", visibility: "visible", contentVisibility: "visible", opacity: get("opacity") ?? "1", pointerEvents: get("pointer-events") ?? "auto", cursor: get("cursor") ?? "auto", textDecorationLine: get("text-decoration-line") ?? get("text-decoration") ?? "none", color: colors[el.id] ?? "rgb(20, 20, 20)", backgroundColor: el.tagName === "BODY" ? "rgb(255, 255, 255)" : "rgba(0, 0, 0, 0)" }
  }
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  if ((document as any).defaultView !== window) Object.defineProperty(document, "defaultView", { configurable: true, get: () => window })
  // (data-top: where the element is against the screen, for what's scrolled past.)
  for (const el of document.querySelectorAll("*")) {
    const top = Number(el.getAttribute("data-top") ?? 100)
    ;(el as any).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 10, right: 80, width: 70, height: 40 })
  }
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
    <button id="d28" class="day is-disabled">Mon 28 Dec</button>
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
const page = (items: MapItem[]): PageMap => ({ url: "https://book.example/a/x/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "The specialist has no free time on this date. Next free day: Tue, Dec 29", forms: [], items })
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
  for (const l of ["10:30", "Book now", "Alex", "€25"]) assert.equal(isDateLabel(l), false, l)
})

test("the card shows the place the rules picked as a changeable answer; a changed one fixes the booking's place, the pick stays the rules'", async () => {
  const LIST: PageMap = {
    url: "https://tables.example/restaurants/paris", title: "Italian restaurants", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [],
    items: [
      { id: "1", role: "link", label: "Trattoria Uno Italian 9.1 (320 reviews)", href: "/restaurant/uno" },
      { id: "2", role: "link", label: "Trattoria Due Italian 9.4 (2179 reviews)", href: "/restaurant/due" },
      { id: "3", role: "link", label: "Trattoria Tre Italian 9.6 (201 reviews)", href: "/restaurant/tre" },
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
  assert.deepEqual(q.options, ["Trattoria Tre Italian", "Trattoria Due Italian", "Trattoria Uno Italian", "@auto"], "the rules' order (9.6, 9.4, 9.1), not the page's, and «pick for me»")
  assert.equal(q.pick, "Trattoria Tre Italian", "a table at «any Italian»: the rules' first, shown chosen")
  assert.equal(s.plan!.how?.rating, 0, "no «I'll pick the place» line besides the shown pick")
  // Left as picked: still the rules' (the next is tried when it doesn't fit).
  let after = await approvePlan(s, io, { answers: s.plan!.questions.map((x) => x.pick ?? ""), off: [] })
  assert.equal(after.plan!.booking!.venue, undefined)
  // Changed on the card: that place, nothing chosen on the way.
  io = mk()
  s = await drive(newState("w", "Book a table at an Italian restaurant on Friday at 20:00", "en", LIST.url), io)
  after = await approvePlan(s, io, { answers: s.plan!.questions.map((x) => (x.kind === "venue" ? "Trattoria Uno Italian" : "")), off: [] })
  assert.equal(after.plan!.booking!.venue, "Trattoria Uno Italian")
  assert.equal(after.chooseVenue, false)
})

test("the page has shown the booking's day: a strip's day with its month, «26.12», or a calendar's bare day under its month", () => {
  const page = (labels: string[], text = ""): PageMap => ({ url: "https://book.example/a/x", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text, forms: [], items: labels.map((label, i) => ({ id: String(i + 1), role: "button", label })) })
  assert.equal(seesDate(page(["Wed 25 Nov", "Thu 26 Nov", "Sat 28 Nov"]), "2026-12-26"), false, "26 Nov isn't 26 Dec")
  assert.equal(seesDate(page(["Fri 25 Dec", "Sat 26 Dec"]), "2026-12-26"), true)
  assert.equal(seesDate(page(["сб, 26 дек."]), "2026-12-26"), true)
  assert.equal(seesDate(page(["26.12."]), "2026-12-26"), true)
  assert.equal(seesDate(page(["25", "26", "27"], "December 2026"), "2026-12-26"), true, "a calendar's cells under «December 2026»")
  assert.equal(seesDate(page(["25", "26", "27"], "November 2026"), "2026-12-26"), false, "November's calendar")
  assert.equal(seesDate(page(["11:30 AM", "12:26"], "December"), "2026-12-26"), false, "a time isn't a day")
})

test("a question about the booking's day before the page showed it is sent back once to go there (124: «26 Dec closed, nearest Sat 5 Dec» unseen)", async () => {
  const STRIP: PageMap = {
    url: "https://book.example/a/nova/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "Select a date Pick a time", forms: [],
    items: [
      { id: "1", role: "button", label: "Wed 25 Nov" }, { id: "2", role: "button", label: "Thu 26 Nov" }, { id: "3", role: "button", label: "Sat 28 Nov" },
      { id: "4", role: "button", label: "Open calendar" }, { id: "5", role: "button", label: "11:30 AM" }
    ]
  }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Salon Nova", match: [], area: [] } }
  const ASK = { ok: true, call: { tool: "ask_user", question: "26 Dec is closed. Nearest Saturday is 5 Dec?", choices: ["Sat 5 Dec", "Another day"] }, verdict: { cls: "free", reason: "read" } }
  const mk = (replies: any[]): RunnerIO => ({ map: async () => STRIP, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } })
  let io = mk([{ ok: true, plan: RAW, token: "t" }, ASK, ASK])
  let s = await drive(newState("d1", "Book me a haircut at Salon Nova in a month on Saturday", "en", STRIP.url), io)
  let after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  const sent = after.log.find((l) => l.call.tool === "ask_user" && /^refused/.test(l.result ?? ""))
  assert.ok(sent && /hasn't shown Sat,? 26 Dec 2026/.test(sent.result!), "sent back with the day to go to")
  assert.equal(after.status, "asked", "asked again: the question goes to the person (one nudge only)")
  // Once the page shows the day, the question goes straight through.
  STRIP.items.push({ id: "6", role: "button", label: "Sat 26 Dec" })
  io = mk([{ ok: true, plan: RAW, token: "t" }, ASK])
  s = await drive(newState("d2", "Book me a haircut at Salon Nova in a month on Saturday", "en", STRIP.url), io)
  after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  assert.equal(after.log.some((l) => /^refused/.test(l.result ?? "")), false)
  assert.equal(after.status, "asked")
})

test("the asked day shown greyed is pressed once to hear the page; a question before that press makes the device press it (124: a strip that greys days it hasn't loaded)", async () => {
  const STRIP: PageMap = {
    url: "https://book.example/a/nova/booking", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "Select a date", forms: [],
    items: [
      { id: "1", role: "button", label: "Wed 9 Dec" }, { id: "2", role: "button", label: "Fri 25 Dec", state: ["unavailable"] },
      { id: "3", role: "button", label: "Sat 26 Dec", state: ["unavailable"] }, { id: "4", role: "button", label: "Sun 27 Dec", state: ["unavailable"] }
    ]
  }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Salon Nova", match: [], area: [] } }
  const ASK = { ok: true, call: { tool: "ask_user", question: "26 Dec and the days around are closed; free only until 9 Dec", choices: ["Wed 9 Dec"] }, verdict: { cls: "free", reason: "read" } }
  const PRESS27 = { ok: true, call: { tool: "click", id: "4", why: "next day" }, verdict: { cls: "free", reason: "click" } }
  const pressed: string[] = []
  const replies: any[] = [{ ok: true, plan: RAW, token: "t" }, ASK, PRESS27, ASK]
  const io: RunnerIO = { map: async () => STRIP, act: async (c: any) => { pressed.push(c.id); return { ok: true } }, waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  const s = await drive(newState("g1", "Book me a haircut at Salon Nova in a month on Saturday", "en", STRIP.url), io)
  const after = await approvePlan(s, io, { answers: s.plan!.questions.map(() => ""), off: [] })
  const held = after.log.find((l) => l.call.tool === "ask_user" && /^held/.test(l.result ?? ""))
  assert.ok(held && /pressed the asked day «Sat 26 Dec»/.test(held.result!), "the device pressed the asked day itself")
  assert.deepEqual(pressed, ["3"], "the asked day pressed once though greyed; another greyed day isn't")
  assert.equal(after.status, "asked", "then the question goes to the person")
})

test("the place pick reads the list's cards past the map's first part; the option the request names is shown chosen (124)", async () => {
  const TOP: PageMap = {
    url: "https://salons.example/places/mens-haircut/in-soho/", title: "Men's haircuts in Soho", lang: "en", more: 6, part: 1, parts: 2, text: "", forms: [],
    items: [{ id: "1", role: "textbox", label: "Treatment or venue" }, { id: "2", role: "button", label: "Sort by" }]
  }
  const REST: PageMap = { ...TOP, part: 2, more: 0, items: [
    { id: "10", role: "link", label: "Barber One Soho 4.9 (812 reviews) Soho, London Men's Haircut from £40", href: "/place/one/" },
    { id: "11", role: "link", label: "Barber Two 4.8 (1204 reviews) Soho, London Men's Haircut from £35", href: "/place/two/" },
    { id: "12", role: "link", label: "Barber Three Soho 4.7 (530 reviews) Soho, London Men's Haircut from £30", href: "/place/three/" }
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
  assert.ok(venue && venue.options.length === 4 && venue.options[3] === "@auto", "the page's places by the rules, and «pick for me»")
  assert.equal(venue.pick, undefined, "a salon matters to the person: nothing chosen for them unless remembered")
  assert.ok(venue.notes?.[0] && /★ 4\.9/.test(venue.notes[0]), "rating beside the place")
  assert.equal(s.plan!.questions[0].pick, "Men's Haircut", "the service the request names")
  assert.equal(s.plan!.questions[1].pick, undefined, "a pick that isn't an option is dropped")
})

test("a time is pressed only for the day the page has chosen (124: 11:30 of the first day «booked» as Sat 26 Dec)", () => {
  const st = (): AgentState => ({ ...newState("s", "haircut", "en", "https://book.example/a/x"), plan: { booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30 } } as any })
  const page = (items: MapItem[]): PageMap => ({ url: "https://book.example/a/x", title: "Select date and time", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items })
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

test("the person's answer counts the date steps again (124: «Mon 28 Dec» chosen, then refused as a third date step)", async () => {
  const { answer } = await import("../src/shared/agent/runner.ts")
  const st: AgentState = { ...newState("a", "haircut", "en", "https://book.example/a/x"), status: "asked", summary: "26 Dec is full", dateSteps: 2, lastDate: "Sun 27 Dec" }
  const io = { save: async () => {}, map: async () => null, waitPage: async () => {} } as any
  const after = await answer(st, io, "reply", ["Mon 28 Dec"]).catch(() => st)
  assert.equal(after.dateSteps, 0)
  assert.equal(after.lastDate, undefined)
})

// Patterns booking pages draw days and times with (no site's markup: the shapes they share).
test("pattern: disabled day buttons (disabled, aria-disabled) count as not choosable", async () => {
  const map = domMap(`<div><div>
    <button id="a">Fri 25 Dec</button><button id="b" disabled>Sat 26 Dec</button><button id="c" aria-disabled="true">Sun 27 Dec</button><button id="d">Mon 28 Dec</button>
  </div></div>`)
  const st = (l: string) => map.items.find((i) => i.label === l)?.state ?? []
  assert.ok(st("Sat 26 Dec").includes("disabled"))
  assert.ok(st("Sun 27 Dec").includes("disabled"))
  const s = booking()
  assert.match(dateStep(s, map, map.items.find((i) => i.label === "Sun 27 Dec")!) ?? "", /not available/, "another day greyed: never pressed")
  assert.equal(dateStep(s, map, map.items.find((i) => i.label === "Sat 26 Dec")!), null, "the asked day: pressed once to hear the page")
  assert.match(dateStep(s, map, map.items.find((i) => i.label === "Sat 26 Dec")!) ?? "", /not available/, "not twice")
})

test("pattern: a calendar grid — bare day numbers under the month, cells off by aria-disabled, a not-allowed cursor or their own words", async () => {
  const map = domMap(`<section><h2>December 2026</h2><table role="grid"><tr>
    <td role="gridcell" id="g25" tabindex="0">25</td>
    <td role="gridcell" id="g26" tabindex="0">26</td>
    <td role="gridcell" id="g27" tabindex="0" style="cursor: not-allowed">27</td>
    <td role="gridcell" id="g28" tabindex="0" aria-label="28 December, not available">28</td>
    <td role="gridcell" id="g29" tabindex="0" aria-label="29 декабря, нет мест">29</td>
    <td role="gridcell" id="g30" tabindex="0" aria-disabled="true">30</td>
    <td role="gridcell" id="g31" tabindex="0"><span style="text-decoration: line-through">31</span></td>
  </tr></table></section>`)
  const st = (l: string) => map.items.find((i) => i.label.startsWith(l))?.state ?? []
  assert.deepEqual(dayItems(map, "2026-12-26").map((i) => i.label), ["26"], "the bare 26 under «December 2026»")
  assert.ok(!st("26").includes("unavailable"))
  assert.ok(st("27").includes("unavailable"), "not-allowed cursor")
  assert.ok(st("28 December").includes("unavailable"), "its own words")
  assert.ok(st("29 декабря").includes("unavailable"), "its own words in Russian")
  assert.ok(st("30").includes("disabled"))
  assert.ok(st("31").includes("unavailable"), "struck through")
  assert.equal(dayItems(map, "2026-11-26").length, 0, "another month's 26 isn't there")
})

test("pattern: a dropdown of times marks the ones the page won't take; the hands never set one", async () => {
  const map = domMap(`<form><label for="t">Time</label><select id="t">
    <option>19:00</option><option disabled>19:30</option><option>20:00 – fully booked</option><option>20:30 — complet</option><option>21:00 満席</option><option>21:30</option>
  </select></form>`)
  const sel = map.items.find((i) => i.role === "select")!
  assert.deepEqual(sel.options, ["19:00", "19:30 [unavailable]", "20:00 – fully booked [unavailable]", "20:30 — complet [unavailable]", "21:00 満席 [unavailable]", "21:30"])
})

test("pattern: days in other languages and orders are read as days, times and prices aren't", () => {
  for (const l of ["сб, 26 дек.", "Sa., 26. Dez.", "sam. 26 déc.", "sáb, 26 dic", "sab 26 dic", "Sáb., 26 de dez.", "Cmt 26 Ara", "السبت 26 ديسمبر", "12月26日(土)", "12월 26일 (토)", "12月26日 週六", "T7, 26 thg 12", "Tue, Nov 24, 2026", "26.12"]) assert.equal(isDateLabel(l), true, l)
  for (const l of ["11:30 AM", "€18", "1 item", "Decide", "Market 12", "Top 10", "9.1 (7936)", "Rated 4.8", "Trattoria 9.4 (2179)"]) assert.equal(isDateLabel(l), false, l)
  for (const l of ["26.12.", "5.1.", "Sa 26.12."]) assert.equal(isDateLabel(l), true, l)
  const m = (labels: string[], text = ""): PageMap => ({ url: "https://book.example/x", title: "", lang: "", more: 0, part: 1, parts: 1, text, forms: [], items: labels.map((label, i) => ({ id: String(i), role: "button" as const, label })) })
  assert.equal(seesDate(m(["12月25日(金)", "12月26日(土)"]), "2026-12-26"), true)
  assert.equal(seesDate(m(["12月16日(水)"]), "2026-12-26"), false)
  assert.equal(seesDate(m(["25", "26"], "Dezember 2026"), "2026-12-26"), true)
})

test("pattern: «tap a date first» — times shown before any day is chosen aren't the asked day's", () => {
  const st = (): AgentState => ({ ...newState("t", "haircut", "en", "https://book.example/x"), plan: { booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30 } } as any })
  const map = (items: MapItem[]): PageMap => ({ url: "https://book.example/x", title: "Choose a time", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items })
  const slot: MapItem = { id: "9", role: "option", label: "12:30" }
  // The asked day greyed (not loaded) and nothing chosen: the times are another day's.
  assert.match(dateStep(st(), map([{ id: "1", role: "option", label: "Fri 25 Dec", state: ["unavailable"] }, { id: "2", role: "option", label: "Sat 26 Dec", state: ["unavailable"] }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "12:30" }) ?? "", /isn't chosen/)
  // The asked day chosen (aria-selected / pressed / current): fine.
  for (const mark of ["selected", "pressed", "current"]) assert.equal(dateStep(st(), map([{ id: "2", role: "option", label: "Sat 26 Dec", state: [mark] }, slot]), slot, { tool: "click", id: "9", date: "2026-12-26", time: "12:30" }), null, mark)
})

test("pattern: another site's booking form in a frame is known by its title or address, in any language; other frames aren't", () => {
  assert.equal(bookingFrame({ src: "https://widgets.provider.example/reservations/r/123", host: "widgets.provider.example" }), true)
  assert.equal(bookingFrame({ src: "https://w.provider.example/embed?id=9", host: "w.provider.example", title: "Online booking" }), true)
  assert.equal(bookingFrame({ src: "https://w.provider.example/x", host: "w.provider.example", title: "予約フォーム" }), true)
  assert.equal(bookingFrame({ src: "https://w.provider.example/x", host: "w.provider.example", title: "Бронирование столика" }), true)
  assert.equal(bookingFrame({ src: "https://ads.example/banner?id=3", host: "ads.example", title: "Advertisement" }), false)
  assert.equal(bookingFrame({ src: "https://social.example/plugins/facebook-page.php", host: "social.example" }), false)
  assert.equal(bookingFrame({ src: "https://maps.example/embed?q=place", host: "maps.example", title: "Map" }), false)
})

test("a press the person said no to isn't put to them again in the same task", async () => {
  const PAGE: PageMap = { url: "https://tables.example/r/1", title: "Book", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [],
    items: [{ id: "7", role: "link", label: "Find a table at a similar restaurant", href: "/similar" }] }
  const { answer } = await import("../src/shared/agent/runner.ts")
  const PRESS = { ok: true, call: { tool: "click", id: "7", why: "similar" }, verdict: { cls: "confirm", reason: "other" }, target: 'link "Find a table at a similar restaurant"' }
  const ASK = { ok: true, call: { tool: "ask_user", question: "How to go on?", choices: ["Another day"] }, verdict: { cls: "free", reason: "read" } }
  const replies: any[] = [PRESS, PRESS, ASK]
  const io = { map: async () => PAGE, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  let s = await drive(newState("n", "book a table", "en", PAGE.url), io)
  assert.equal(s.status, "confirm")
  s = await answer(s, io, "no")
  assert.ok(s.log.some((l) => /^refused: the person said no to/.test(l.result ?? "")), "the second proposal refused on the device")
  assert.equal(s.status, "asked")
})

test("pattern: another day than the asked one — never an earlier one, a later one only after the asked day was shown", () => {
  const st = (saw: boolean): AgentState => ({ ...newState("o", "table", "en", "https://tables.example/r"), sawDate: saw, plan: { booking: { kind: "table", date: "2026-12-26", from: "19:00", until: "21:00", minutes: 90 } } as any })
  const m: PageMap = { url: "https://tables.example/r", title: "", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items: [] }
  const press = (label: string, saw = false) => dateStep(st(saw), { ...m, items: [{ id: "1", role: "button", label }] }, { id: "1", role: "button", label })
  assert.match(press("Sat 28 Nov") ?? "", /before the asked day/)
  assert.match(press("сб, 28 нояб.") ?? "", /before the asked day/)
  assert.match(press("Mon 28 Dec") ?? "", /hasn't shown that day yet/)
  assert.equal(press("Mon 28 Dec", true), null, "after the asked day was shown full")
  assert.equal(press("Sat 26 Dec"), null)
  assert.equal(press("Sat 2 Jan", true), null, "January after a December request is later")
})

test("pattern: a results list whose cards' links are just the names, rating and reviews beside them — the places are read from the card", async () => {
  const { venuesOn, cardsOf } = await import("../src/shared/agent/venues.ts")
  const card = (slug: string, name: string, rating: string, reviews: string, kind: string) => `<article><a href="/restaurant/${slug}"><img alt=""></a><h3><a href="/restaurant/${slug}">${name}</a></h3><p>${kind} · Paris</p><span>${rating}</span><span>(${reviews})</span><button>19:00</button><button>19:30</button></article>`
  const map = domMap(`<main><section>${card("uno", "Trattoria Uno", "9.1", "320", "Italian")}${card("due", "Trattoria Due", "9.4", "2 179", "Italian")}${card("tre", "Bistro Tre", "8.8", "201", "French")}</section></main>`, {}, "https://tables.example/restaurants/paris")
  map.url = map.url || "https://tables.example/restaurants/paris"
  const places = venuesOn(map)
  assert.deepEqual(places.map((v) => v.name), ["Trattoria Uno", "Trattoria Due", "Bistro Tre"])
  assert.equal(places[1].reviews, 2179)
  assert.ok([...cardsOf(map).values()].some((t) => /Italian/.test(t)), "the card's cuisine for matching")
  // The model never gets the card text (the device's own reading).
  assert.ok(map.items.some((i) => i.card))
})

test("a contact detail the booking will ask for and «Мои данные» lacks is asked on the card; its value goes by key, never into the request", async () => {
  const PAGE: PageMap = { url: "https://tables.example/r/1", title: "Book", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items: [{ id: "1", role: "button", label: "Book a table" }] }
  const RAW = { label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "table", date: "2026-12-26", from: "19:00", until: "21:00", minutes: 90, tz: "", venue: "Trattoria Uno", match: [], area: [], contacts: ["email", "phone"] } }
  const saved = [{ id: "p", key: "phone", label: "", value: "+100000000", updatedAt: 1 }]
  const asked: any[] = []
  const replies: any[] = [{ ok: true, plan: RAW, token: "t" }]
  const io = { map: async () => PAGE, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async (b: any) => { asked.push(b); return replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } } }, save: async () => {}, entries: async () => saved, policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  const s = await drive(newState("c", "Book a table for two on Saturday at 20:00", "en", PAGE.url), io)
  const qs = s.plan!.questions.filter((q) => q.kind === "contact")
  assert.deepEqual(qs.map((q) => q.key), ["email"], "the phone is saved; the e-mail is asked")
  const after = await approvePlan(s, io, { answers: s.plan!.questions.map((q) => (q.kind === "contact" ? "me@mail.example" : "")), off: [] })
  assert.deepEqual(after.oneTime, [{ key: "email", value: "me@mail.example" }])
  assert.ok(after.plan!.perms.find((p) => p.reason === "contact")!.keys!.includes("email"), "filled by the plan's contact fill")
  assert.ok(!JSON.stringify(asked.slice(1)).includes("me@mail.example"), "the value never goes to the server")
})

test("pattern: layers over the page that aren't the task are closed by their own «Not now» / «×»; sign-ins, the task's dialogs, cookie banners and «Allow» never", async () => {
  const promo = (inner: string) => domMap(`<main><button>Book</button></main><div role="dialog" aria-modal="true">${inner}</div>`, {}, "https://shop.example/x").promo
  assert.equal(promo(`<h2>Collect points and earn up to £25 in rewards</h2><button aria-label="Close">×</button><button>Join now</button>`)?.label, "Close")
  assert.equal(promo(`<p>Open in app for a better experience</p><button>Open the app</button><button>Not now</button>`)?.label, "Not now")
  assert.equal(promo(`<p>Abonnieren Sie unseren Newsletter: 10 % Rabatt</p><input type="email" aria-label="E-Mail"><button>Abonnieren</button><button>Nein danke</button>`)?.label, "Nein danke")
  assert.equal(promo(`<p>Включите уведомления о скидках</p><button>Разрешить</button><button>Не сейчас</button>`)?.label, "Не сейчас")
  assert.equal(promo(`<p>アプリをダウンロードしてポイントを貯めよう</p><button>ダウンロード</button><button>後で</button>`)?.label, "後で")
  assert.equal(promo(`<h2>Log in to collect your points</h2><input type="password" aria-label="Password"><button>Log in</button><button>Close</button>`), undefined, "a sign-in")
  assert.equal(promo(`<p>Book with points</p><button>Sat 26 Dec</button><button>19:30</button><button>Close</button>`), undefined, "the task's own dialog")
  assert.equal(promo(`<p>Turn on notifications</p><button>Allow</button><button>Subscribe</button>`), undefined, "only agreeing controls")
  assert.equal(promo(`<p>We use cookies and similar technologies. Rewards partners…</p><button>Reject all</button><button>Close</button>`), undefined, "a cookie banner is the cookie closer's")
})

test("a layer over the page that isn't the task is closed as a free step, with no model call and no question", async () => {
  const PAGE: PageMap = { url: "https://salons.example/s/1", title: "Salon", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], overlay: true, promo: { id: "9", label: "Not now" },
    items: [{ id: "9", role: "button", label: "Not now", where: "dialog" }, { id: "1", role: "button", label: "Select" }] }
  const pressed: string[] = []
  let calls = 0
  const io = { map: async () => (pressed.length ? { ...PAGE, overlay: undefined, promo: undefined } : PAGE), act: async (c: any) => { pressed.push(c.id); return { ok: true } }, waitPage: async () => {}, ask: async () => { calls++; return { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  const s = await drive(newState("pp", "find a haircut", "en", PAGE.url), io)
  assert.deepEqual(pressed, ["9"])
  assert.equal(calls, 1, "the model was asked only after the layer was gone")
  assert.ok(s.lines.some((l) => l.popup))
})

test("a personal service's open choices are asked on the card from the plan's fields: the specialist and a service when several fit; a named one isn't", async () => {
  const PAGE: PageMap = { url: "https://salons.example/s/nova", title: "Salon Nova", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items: [{ id: "1", role: "button", label: "Book now" }] }
  const plan = (b: Record<string, unknown>) => ({ label: "booking", steps: ["a"], questions: [], prices: [], fromChat: "", risky: [], booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Salon Nova", match: [], area: [], contacts: [], specialists: [], services: [], specialistNamed: "", serviceNamed: "", ...b } })
  const run = async (b: Record<string, unknown>) => {
    const replies: any[] = [{ ok: true, plan: plan(b), token: "t" }]
    const io = { map: async () => PAGE, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
      device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
    return (await drive(newState("sp", "Book me a haircut on Saturday", "en", PAGE.url), io)).plan!.questions
  }
  let qs = await run({ specialists: ["Yasmin", "Angel", "Maria", "Leo"], services: ["Haircut", "Haircut & Beard", "Wash & Cut"] })
  assert.deepEqual(qs.map((q) => q.kind), ["specialist", "service"])
  assert.deepEqual(qs[0].options, ["@any", "Yasmin", "Angel", "Maria"], "«any» first, then the page's names")
  qs = await run({ specialists: ["Yasmin"], specialistNamed: "Yasmin", services: ["Haircut", "Wash & Cut"], serviceNamed: "Haircut" })
  assert.deepEqual(qs.map((q) => q.kind), [], "named in the request: nothing to ask")
  qs = await run({ services: ["Haircut"] })
  assert.deepEqual(qs.map((q) => q.kind), [], "one service fits: no question")
})

test("the page naming its next free day sends a question back once with its own words and control, in any language", async () => {
  const { nextFreeSaid } = await import("../src/shared/agent/runner.ts")
  const m = (text: string, labels: string[] = []): PageMap => ({ url: "https://book.example/x", title: "", lang: "", more: 0, part: 1, parts: 1, text, forms: [], items: labels.map((label, i) => ({ id: String(i), role: "button" as const, label })) })
  assert.deepEqual(nextFreeSaid(m("The specialist is fully booked on this date. Available from Mon, Dec 28", ["Go to next available date"])), { text: "Available from Mon, Dec 28", button: "Go to next available date" })
  assert.equal(nextFreeSaid(m("Мастер занят в этот день. Ближайшее свободное время: пн, 28 дек."))?.text, "Ближайшее свободное время: пн, 28 дек.")
  assert.equal(nextFreeSaid(m("Prochaine disponibilité : lundi 28 décembre"))?.text, "Prochaine disponibilité : lundi 28 décembre")
  assert.equal(nextFreeSaid(m("Pick a time", ["11:30", "12:00"])), null)
})

test("pattern: a results list whose whole cards are links named by their aria-label — the card's own text holds the rating", async () => {
  const { venuesOn } = await import("../src/shared/agent/venues.ts")
  const card = (slug: string, name: string, rating: string, reviews: string) => `<li><a href="/restaurant/${slug}" aria-label="${name}"><span>Slide 1 of 8</span><h3>${name}</h3><span>12 Rue X, Paris</span><span>${rating}</span><span>(${reviews})</span><span>Italian</span></a></li>`
  const map = domMap(`<ul>${card("uno", "Trattoria Uno", "9.1", "320")}${card("due", "Trattoria Due", "9.4", "2179")}${card("tre", "Trattoria Tre", "8.8", "201")}</ul>`, {}, "https://tables.example/restaurants/paris")
  map.url = map.url || "https://tables.example/restaurants/paris"
  assert.deepEqual(venuesOn(map).map((v) => v.name), ["Trattoria Uno", "Trattoria Due", "Trattoria Tre"])
  assert.equal(venuesOn(map)[0].rating, 4.55, "9.1 of 10, not the slide's «1 of 8»")
})

test("a layer that comes back after the same press is that press's next step: closed once, then left to the model", async () => {
  const LAYER = { id: "9", label: "Close" }
  let n = 0
  const pressed: string[] = []
  const page = (): PageMap => ({ url: "https://salons.example/s/1", title: "Salon", lang: "en", more: 0, part: 1, parts: 1, text: "Collect points", forms: [], overlay: true, promo: LAYER,
    items: [{ id: "9", role: "button", label: "Close", where: "dialog" }, { id: "5", role: "button", label: "Keep earning", where: "dialog" }, { id: "4", role: "button", label: "Continue" }] })
  const replies: any[] = [
    { ok: true, call: { tool: "click", id: "4", why: "continue" }, verdict: { cls: "free", reason: "nav" }, target: 'button "Continue"' },
    { ok: true, call: { tool: "click", id: "4", why: "continue" }, verdict: { cls: "free", reason: "nav" }, target: 'button "Continue"' }
  ]
  const asked: any[] = []
  const io = { map: async () => (n++ === 0 ? { ...page(), overlay: undefined, promo: undefined } : page()), act: async (c: any) => { pressed.push(c.id); return { ok: true } }, waitPage: async () => {}, ask: async (b: any) => { asked.push(b); return replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
  await drive(newState("lb", "book a haircut", "en", "https://salons.example/s/1"), io)
  assert.deepEqual(pressed, ["4", "9", "4"], "closed once after «Continue», not again after the same press")
  assert.ok(asked.some((b) => /came back after/.test(JSON.stringify(b))), "the model hears it's that press's next step")
})

test("pattern: a card's rating and review count side by side («4.4 268 reviews», «4.5 3 822 reviews») and a service term matched word by word", async () => {
  const { venuesOn, cardsOf, rankVenues } = await import("../src/shared/agent/venues.ts")
  const L = ["Barber One Soho 4.5 3 822 reviews Soho, London Men's Wash, Haircut & Style 45 mins", "Barber Two 4.4 268 reviews Fitzrovia, London Men's Wash, Cut & Finish", "Barber Three 4.7 303 reviews Mayfair, London Men - Haircut, Wash & Styling"]
  const map: PageMap = { url: "https://salons.example/places/x/", title: "", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [], items: L.map((label, i) => ({ id: String(i), role: "link" as const, label, href: `/place/p${i}/` })) }
  const v = venuesOn(map)
  assert.deepEqual(v.map((x) => [x.rating * 2, x.reviews]), [[9, 3822], [8.8, 268], [9.4, 303]].map(([r, n]) => [r / 2 * 2, n]))
  assert.deepEqual(rankVenues(v, cardsOf(map), ["Men's Haircut"], 4.5, []).map((x) => x.name), ["Barber Three", "Barber One Soho"])
})

test("a salon not named: the card asks the place (ranked by the rules, «Featured» never first for being first) and the specialist in general form; «choose on the page» lets one question through there", async () => {
  const HOME: PageMap = { url: "https://book.example/", title: "Book beauty & wellness", lang: "en", more: 0, part: 1, parts: 1, text: "Recommended", forms: [],
    items: [
      { id: "1", role: "link", label: "Featured Glow Couture 5.0 Germasogeia, Limassol Hair Salon 1,127 reviews", href: "/a/glow" },
      { id: "2", role: "link", label: "Cut Studio 5.0 Agios Tychonas, Limassol Barber 2,410 reviews", href: "/a/cut" },
      { id: "3", role: "link", label: "Barber Nova 4.6 Neapoli, Limassol Barber 300 reviews", href: "/a/nova" },
      { id: "4", role: "button", label: "Search" }
    ] }
  const RAW = { label: "booking", steps: ["Opening Glow Couture"], questions: [], prices: [], fromChat: "", risky: [],
    booking: { kind: "appointment", date: "2026-12-26", from: "10:00", until: "18:00", minutes: 30, tz: "", venue: "Glow Couture", match: ["hair", "barber"], area: ["Limassol"], contacts: [], specialists: [], services: [], specialistNamed: "", serviceNamed: "" } }
  const run = async (entries: any[] = [], replies: any[] = []) => {
    const q: any[] = [{ ok: true, plan: RAW, token: "t" }, ...replies]
    const io = { map: async () => HOME, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => q.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => entries, policy: { amazon: true }, maxSteps: 30, planning: true, open: async () => {},
      device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } } as any
    return { s: await drive(newState("salon", "Book me a haircut in Limassol on Saturday in a month", "en", HOME.url), io), io }
  }
  const { s } = await run()
  assert.equal(s.plan!.booking!.venue, undefined, "a place the request doesn't name isn't the plan's to pick")
  const place = s.plan!.questions.find((x) => x.kind === "venue")!
  assert.deepEqual(place.options, ["Cut Studio", "Glow Couture", "Barber Nova", "@auto"], "5.0 with more reviews first; the «Featured» one loses the tie")
  assert.equal(place.pick, undefined, "nothing chosen for the person")
  assert.match(place.notes![0], /★ 5 · 2,410 · Agios Tychonas, Limassol/)
  const who = s.plan!.questions.find((x) => x.kind === "specialist")!
  assert.deepEqual(who.options, ["@any", "@page"], "no names before the salon's page")
  // Remembered: last time's place and specialist offered (and pre-filled by the card).
  const saved = [{ id: "a", key: "fact", label: "book.example · place", value: "Salon Old", updatedAt: 1 }, { id: "b", key: "fact", label: "book.example · specialist", value: "Maria", updatedAt: 1 }]
  const r2 = (await run(saved)).s.plan!.questions
  assert.deepEqual(r2.find((x) => x.kind === "venue")!.options[0], "Salon Old")
  assert.equal(r2.find((x) => x.kind === "venue")!.notes![0], "@last")
  assert.deepEqual(r2.find((x) => x.kind === "specialist")!.options, ["@any", "Maria", "@page"])
  // «Choose on the salon's page»: the one question there goes to the person (no place guard sends it back).
  const ASK = { ok: true, call: { tool: "ask_user", question: "Which specialist?", choices: ["Any", "Eleni", "Marios"] }, verdict: { cls: "free", reason: "read" } }
  const { s: s3, io: io3 } = await run([], [ASK])
  const after = await approvePlan(s3, io3, { answers: s3.plan!.questions.map((x) => (x.kind === "venue" ? "@auto" : x.kind === "specialist" ? "@page" : "")), off: [] })
  assert.equal(after.chooseVenue, true, "«pick for me»: the rules choose")
  assert.equal(after.status, "asked", "the specialist question reached the person")
  assert.ok(after.plan!.answers!.some((a) => /chosen on the place's own page/.test(a.a)))
})

test("a stay or a rental: its first day, then its last (check-out, return), never a day before the first", () => {
  const cal = [day("1", "Thu 24 Dec"), day("2", "Fri 25 Dec"), day("3", "Sat 26 Dec"), day("4", "Sun 27 Dec"), day("5", "Mon 28 Dec"), day("6", "Tue 29 Dec"), day("7", "Wed 30 Dec")]
  const map = page(cal)
  const s = { plan: { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "stay" as const, date: "2026-12-26", dateEnd: "2026-12-29", personal: true, from: "09:00", until: "21:00", minutes: 0 } } } as unknown as AgentState
  assert.match(dateStep(s, map, cal[1]) ?? "", /before the asked day/, "not before check-in")
  assert.equal(dateStep(s, map, cal[2]), null, "check-in")
  assert.equal(dateStep(s, map, cal[5]), null, "check-out after it")
  // The range set: another day is a third date step that went somewhere else.
  assert.equal(dateStep(s, map, cal[6]), null)
  assert.match(dateStep(s, map, cal[4]) ?? "", /two date steps went nowhere/)
})

test("the recap before the last press: only another day, time or place, or a new site's cancellation terms", () => {
  const st = (o: Partial<AgentState> = {}) => ({ plan: { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment" as const, date: "2026-12-26", at: "09:00", from: "08:00", until: "10:00", minutes: 30, venue: "Studio One" } }, ...o } as unknown as AgentState)
  const plain = { ...page([]), text: "Your booking. Confirm to finish." }
  // As asked, on a site booked on before: no recap.
  assert.equal(recapOf(st({ picked: { date: "2026-12-26", time: "09:00" }, playbook: "x" }), plain), null)
  // Another day.
  assert.deepEqual(recapOf(st({ picked: { date: "2026-12-28", time: "09:00" }, playbook: "x" }), plain), { place: "Studio One", date: "2026-12-28", time: "09:00", askedDate: "2026-12-26" })
  // Another time inside the rules' window.
  assert.equal(recapOf(st({ picked: { date: "2026-12-26", time: "09:30" }, playbook: "x" }), plain)?.askedTime, "09:00")
  // Another place than the first one chosen.
  const venues = { list: [{ url: "a", name: "A", rating: 4.8, reviews: 50 }, { url: "b", name: "B", rating: 4.7, reviews: 40 }], tried: ["a", "b"] }
  const other = recapOf(st({ picked: { date: "2026-12-26", time: "09:00" }, playbook: "x", venues } as never), plain)
  assert.equal(other?.otherPlace, true)
  assert.equal(other?.place, "B")
  // The first booking on a site whose page shows its cancellation terms (in its own words, any language).
  const terms = { ...page([]), text: "Your booking. Free cancellation until 24 hours before. Confirm to finish." }
  assert.equal(recapOf(st({ picked: { date: "2026-12-26", time: "09:00" } }), terms)?.terms, "Free cancellation until 24 hours before.")
  assert.equal(recapOf(st({ picked: { date: "2026-12-26", time: "09:00" }, playbook: "x" }), terms), null, "booked there before")
  assert.equal(cancelTerms({ ...page([]), text: "Бронь. Бесплатная отмена за 24 часа до визита." }), "Бесплатная отмена за 24 часа до визита.")
  assert.equal(cancelTerms({ ...page([]), text: "Tarif non remboursable." }), "Tarif non remboursable.")
  assert.equal(cancelTerms({ ...page([]), text: "Pick a time that suits you." }), "")
})

test("a booking's own settings scrolled past stay in the map's first part (B3): fields, a form's controls, a day", () => {
  // The slots on the screen, then a long footer below it.
  const slots = Array.from({ length: 40 }, (_, i) => `<button>${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}</button>`).join("") +
    Array.from({ length: 100 }, (_, i) => `<a href="/p${i}" data-top="2000">Page ${i}</a>`).join("")
  const map = domMap(`<form data-top="-600"><label>Date <input id="date" type="date" data-top="-600"></label><select id="party" aria-label="Guests" data-top="-560"><option>2</option></select></form>
    <a href="/about" data-top="-700">About us</a><button data-top="-650">Sat 26 Dec</button>${slots}`)
  const labels = map.items.map((i) => i.label)
  assert.equal(map.parts, 2)
  assert.ok(labels.includes("Date"), "the date field")
  assert.ok(labels.includes("Guests"), "the party")
  assert.ok(labels.includes("Sat 26 Dec"), "a day")
  assert.ok(!labels.includes("About us"), "a link scrolled past stays last")
})

test("a widget's own date field on another day than the asked one is found (B3)", () => {
  const field = (value: string, extra: Partial<MapItem> = {}): MapItem => ({ id: "f", role: "textbox", label: "Date", value, ...extra })
  assert.equal(widgetDay(page([field("2026-12-24", { type: "date" })]), "2026-12-26")?.value, "2026-12-24")
  assert.equal(widgetDay(page([field("Thu 24 Dec")]), "2026-12-26")?.value, "Thu 24 Dec")
  assert.equal(widgetDay(page([field("Sat 26 Dec")]), "2026-12-26"), null, "the asked day")
  assert.equal(widgetDay(page([field("Anna")]), "2026-12-26"), null, "not a date")
})
