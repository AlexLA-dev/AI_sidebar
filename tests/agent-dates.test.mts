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
import { approvePlan, dateStep, drive, isDateLabel, newState, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
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
