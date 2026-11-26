// The director's pass on 03a95321: the chat's suggested place first in the place question by the device, not by the
// model's ordering (P1); «Дело на паузе» with Safari in front, a tab's two pages speaking out of order (P2).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { PagesSeen } from "../src/background/pagesSeen.ts"
import { DEFAULT_RULES, type AgentRules } from "../src/shared/agent/rules.ts"
import { drive, newState, suggestFirst, type RunnerIO } from "../src/shared/agent/runner.ts"
import { checkPlan, PLAN_SCHEMA } from "../src/shared/agent/taskplan.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

const REQ = "Book a stay for 2 nights from next Friday"
const LINKS: PageMap = { url: "https://stays.example/stays?in=2026-12-04&out=2026-12-06", title: "Stays in Limassol", lang: "en", more: 0, part: 1, parts: 1, forms: [], text: "Stays in Limassol",
  items: [
    { id: "1", role: "link", label: "Harbour View Suites 8.9 (412 reviews)", href: "/stay?id=0" },
    { id: "2", role: "link", label: "Olive Grove Apartments 9.2 (188 reviews)", href: "/stay?id=1" },
    { id: "3", role: "link", label: "Seafront Studio Rooms 8.7 (95 reviews)", href: "/stay?id=2" },
    { id: "4", role: "link", label: "Old Town Guesthouse 9.0 (266 reviews)", href: "/stay?id=3" }
  ] } as PageMap
// The stand's list: cards a script opens (no addresses), the iPad's runs u and v.
const SCRIPT: PageMap = { ...LINKS, items: [{ id: "1", role: "link", label: "Harbour View Suites" }, { id: "2", role: "link", label: "Olive Grove Apartments" }, { id: "3", role: "link", label: "Seafront Studio Rooms" }, { id: "4", role: "link", label: "Old Town Guesthouse" }] } as PageMap

// The model's plan as the new prompt has it: no place in booking.venue nor in fromChat, the suggestion in chatPlace.
const RAW = (over: Record<string, unknown> = {}) => ({ label: "booking a stay", steps: ["Opening the stays list", "Booking the stay"], questions: [], prices: [], fromChat: "4–6 Dec", chatPlace: "Old Town Guesthouse", risky: [],
  booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0, venue: "", personal: true, match: [], area: [] }, ...over })
const run = (map: PageMap, plan: unknown, rules: AgentRules = DEFAULT_RULES, request = REQ) => {
  const replies: any[] = [{ ok: true, plan, token: "t" }]
  const io: RunnerIO = { map: async () => map, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => rules, playbook: { get: async () => null, put: async () => {} } }
  return drive(newState("p1", request, "en", map.url), io)
}
const placeQ = (s: Awaited<ReturnType<typeof run>>) => s.plan!.questions.filter((q) => q.kind === "venue" || q.fact === "venue" || q.place)

test("P1: the plan names the chat's suggestion in a field of its own (schema, check, prompt)", () => {
  assert.ok((PLAN_SCHEMA.required as string[]).includes("chatPlace"))
  assert.equal(checkPlan(RAW()).chatPlace, "Old Town Guesthouse")
  assert.equal(checkPlan(RAW({ chatPlace: "" })).chatPlace, undefined)
  const act = readFileSync(new URL("../netlify/shared/act.mts", import.meta.url), "utf8")
  assert.match(act, /its name, exactly as the chat writes it, goes in chatPlace/)
})

test("P1: the plan's own question leaves the suggestion out — the device puts it first", async () => {
  const s = await run(LINKS, RAW({ questions: [{ q: "Which place should I book?", options: ["Harbour View Suites", "Olive Grove Apartments", "Seafront Studio Rooms", "Other…"], fact: "Place", pick: "" }] }))
  const qs = placeQ(s)
  assert.equal(qs.length, 1, "one place question")
  assert.equal(qs[0].options[0], "Old Town Guesthouse", "the page's place, first")
  assert.equal(qs[0].options.length, 4)
  assert.equal(qs[0].options.at(-1), "Other…", "the card's own last option stays")
  assert.equal(qs[0].pick, undefined, "nobody chose it")
  assert.equal(s.plan!.booking!.venue, undefined, "never the booking's place by itself")
  assert.equal(s.plan!.how?.rating ?? 0, 0, "no «I'll pick the place» beside the question")
  assert.equal(s.plan!.chatPlace, undefined, "not kept with the task")
})

test("P1: the plan's own question has it in the middle — moved first", async () => {
  const s = await run(LINKS, RAW({ questions: [{ q: "Which place?", options: ["Harbour View Suites", "Old Town Guesthouse", "Olive Grove Apartments"], fact: "venue", pick: "Harbour View Suites" }] }))
  const qs = placeQ(s)
  assert.deepEqual(qs[0].options, ["Old Town Guesthouse", "Harbour View Suites", "Olive Grove Apartments"])
  assert.equal(qs[0].pick, undefined)
})

test("P1: no question at all — one is added with the suggestion first, «pick for me» on or off", async () => {
  for (const chooseVenue of [true, false]) {
    for (const map of [LINKS, SCRIPT]) {
      const s = await run(map, RAW(), { ...DEFAULT_RULES, chooseVenue })
      const qs = placeQ(s)
      assert.equal(qs.length, 1, `asked (${map === LINKS ? "links" : "script cards"}, chooseVenue ${chooseVenue})`)
      assert.match(qs[0].options[0], /^Old Town Guesthouse/)
      assert.equal(qs[0].pick, undefined)
      assert.equal(s.plan!.booking!.venue, undefined)
    }
  }
})

test("P1: kept only when the page lists it; a request that points to its place keeps it; a plan without chatPlace is as before", async () => {
  const gone = await run(LINKS, RAW({ chatPlace: "Villa Elsewhere" }))
  assert.ok(!placeQ(gone).some((q) => q.options.some((o) => /Villa Elsewhere/.test(o))), "not on the page: never an option")
  const pointed = await run(LINKS, RAW({ chatPlace: "", fromChat: "Old Town Guesthouse, 4–6 Dec", booking: { ...RAW().booking, venue: "Old Town Guesthouse" } }), DEFAULT_RULES, "Book the one you suggested for 2 nights from next Friday")
  assert.equal(pointed.plan!.booking!.venue, "Old Town Guesthouse")
  const plain = await run(LINKS, RAW({ chatPlace: "" }), { ...DEFAULT_RULES, chooseVenue: false })
  assert.equal(placeQ(plain).length, 0, "no chat suggestion, «pick for me» off: asked later from the real list, as before")
})

test("P1: suggestFirst keeps the device question's notes in step and its «pick for me» last", () => {
  const q = { q: "", kind: "venue" as const, fact: "pref:place", options: ["Last Time Inn", "Harbour View Suites", "Olive Grove Apartments", "Seafront Studio Rooms", "@auto"], notes: ["@last", "8.9", "9.2", "8.7", ""], pick: "Harbour View Suites" }
  const listed = new Set(["harbourviewsuites", "olivegroveapartments", "seafrontstudiorooms", "oldtownguesthouse"])
  suggestFirst(q, "Old Town Guesthouse", listed)
  assert.deepEqual(q.options, ["Old Town Guesthouse", "Last Time Inn", "Harbour View Suites", "Olive Grove Apartments", "@auto"])
  assert.deepEqual(q.notes, ["", "@last", "8.9", "9.2", ""])
  assert.equal(q.pick, undefined)
})

test("P2: Safari is away only while no page of ours is visible, whatever order a tab's two pages speak in", () => {
  // The new page shows first, the old one says «hidden» late (the iPad's «Дело на паузе» with Safari in front).
  const a = new PagesSeen()
  a.report(7, "old", true)
  a.report(7, "new", true)
  a.report(7, "old", false)
  assert.equal(a.anyVisible(new Set([7])), true)
  // The other order: hidden, then the new page visible.
  const b = new PagesSeen()
  b.report(7, "old", true)
  b.report(7, "old", false)
  assert.equal(b.anyVisible(new Set([7])), false)
  b.report(7, "new", true)
  assert.equal(b.anyVisible(new Set([7])), true)
  // Two tabs: the old tab hidden, the new tab visible, in either order.
  const c = new PagesSeen()
  c.report(8, "n", true)
  c.report(7, "o", false)
  assert.equal(c.anyVisible(new Set([8])), true)
  // A real leave: the visible page says «hidden» itself.
  const d = new PagesSeen()
  d.report(7, "p", true)
  d.report(7, "p", false)
  assert.equal(d.anyVisible(new Set([7])), false)
  // A tab behind another (not active) or closed doesn't count.
  const e = new PagesSeen()
  e.report(9, "x", true)
  assert.equal(e.anyVisible(new Set([7])), false)
  e.drop(9)
  assert.equal(e.anyVisible(), false)
})

test("P2: the background asks the pages before calling Safari away; a ping (only a visible page sends it) clears it", () => {
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  assert.match(bg, /if \(pagesSeen\.anyVisible\(new Set\(fronts\.flatMap[^\n]+\)\)\)\) return\n\s+away = \{ words \}/)
  assert.match(bg, /case "agentPing":[\s\S]{0,200}pagesSeen\.report\(tab, [^\n]+, true\)\n\s+void back\(\)/)
  assert.match(bg, /pagesSeen\.drop\(tab\)/)
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /type: "agentPing", doc: PAGE_DOC/)
  assert.match(app, /type: "agentSeen", visible, doc: PAGE_DOC/)
  // A note begun before Safari came back isn't sent after the cancel (the iPad: schedule landed 44 ms after it, stayed 21 s).
  assert.match(bg, /const gen = awayGen\n\s+const tabUrl = await[^\n]+\n(\s*\/\/[^\n]*\n)*\s+if \(!away \|\| gen !== awayGen\) return/)
  assert.match(bg, /away = null\n\s+awayGen\+\+/)
  assert.match(bg, /away = \{ words \}\n\s+awayGen\+\+/)
})
