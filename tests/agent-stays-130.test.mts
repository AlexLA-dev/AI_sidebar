// The director's pass on 21c29c5a (iPad, the stand's stays): a saved name offered into a stay's «Destination» box, a
// place taken from the chat's own suggestion, and the last «Do it?» without the place.
import assert from "node:assert/strict"
import { test } from "node:test"

import { fieldLock } from "../src/shared/agent/fields.ts"
import type { FormEntry } from "../src/shared/agent/formdata.ts"
import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { drive, newState, POINTS, recapOf, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const SAVED = [{ id: "e1", key: "name.full", label: "", value: "Alex Test", updatedAt: 1 }] as FormEntry[]
const step = (call: ToolCall, cls: "free" | "confirm", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })

test("N1: a place to search isn't the person's details; a saved contact only into a field of its kind", async () => {
  assert.equal(fieldLock({ tag: "input", name: "city", id: "c", label: "Destination" }), null, "«Destination» named city")
  assert.equal(fieldLock({ tag: "input", name: "city", id: "c", label: "City" }), "personal", "a form's own City stays the person's")
  assert.equal(fieldLock({ tag: "input", name: "email", id: "e", label: "Destination" }), "personal", "a contact's own name stays personal")
  const map = { url: "https://stays.example/stays", title: "Stays", lang: "en", forms: [{ n: 0, fillable: true }], more: 0, part: 1, parts: 1, text: "",
    items: [{ id: "1", role: "textbox", label: "Destination", form: 0, value: "Limassol" }, { id: "2", role: "textbox", label: "Your full name as in your passport", lock: "personal", form: 0, state: ["empty"] }] } as PageMap
  const io = (replies: ActReply[]) => ({ map: async () => map, act: async () => ({ ok: true, note: "done" }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => SAVED, policy: { amazon: true }, maxSteps: 30 }) as RunnerIO
  const s = newState("n1", "Book a stay for 2 nights from next Friday", "en", map.url)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", at: "", from: "", until: "", minutes: 0 } } as unknown as TaskPlan
  const after = await drive(s, io([step({ tool: "fill", id: "1", key: "name.full", why: "Filling in your name" }, "confirm", "fill")]))
  assert.notEqual(after.status, "fill", "never put to the person")
  assert.match(after.log[0].result, /refused: the field "Destination" isn't a name field/)
  // A long name label the page marks personal is still a name field.
  const t = newState("n1b", "Book a stay", "en", map.url)
  t.plan = { ...s.plan, approved: true } as TaskPlan
  const named = await drive(t, io([step({ tool: "fill", id: "2", key: "name.full", why: "Filling in your name" }, "confirm", "fill")]))
  assert.equal(named.status, "fill", "the person is asked with the value shown, as before")
})

test("N2: a place only the chat suggested isn't the person's: asked, the suggestion first; one the request points to stays", async () => {
  assert.equal(POINTS.test("Book a stay for 2 nights from next Friday"), false)
  for (const t of ["Book the second one", "Book that hotel", "Забронируй второй", "Réserve le deuxième", "2番目を予約", "订第二家"]) assert.equal(POINTS.test(t), true, t)
  assert.equal(POINTS.test("Réserve son hôtel"), false)
  const LIST: PageMap = { url: "https://stays.example/stays?in=2026-12-04&out=2026-12-06", title: "Stays in Limassol", lang: "en", more: 0, part: 1, parts: 1, forms: [], text: "Stays in Limassol",
    items: [
      { id: "1", role: "link", label: "Harbour View Suites 8.9 (412 reviews)", href: "/stay?id=0" },
      { id: "2", role: "link", label: "Olive Grove Apartments 9.2 (188 reviews)", href: "/stay?id=1" },
      { id: "3", role: "link", label: "Old Town Guesthouse 9.0 (266 reviews)", href: "/stay?id=3" }
    ] } as PageMap
  const RAW = (request: string) => ({ label: "booking a stay", steps: ["a"], questions: [], prices: [], fromChat: "2 nights, Dec 4–6, Old Town Guesthouse", risky: [], booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0, venue: "Old Town Guesthouse", personal: true, match: [], area: [] }, _r: request })
  const mk = (request: string): RunnerIO => {
    const replies: any[] = [{ ok: true, plan: RAW(request), token: "t" }]
    return { map: async () => LIST, act: async () => ({ ok: true }), waitPage: async () => {}, ask: async () => replies.shift() ?? { ok: true, call: { tool: "done", summary: "x" }, verdict: { cls: "free", reason: "read" } }, save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30, planning: true,
      device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} } }
  }
  const asked = await drive(newState("n2", "Book a stay for 2 nights from next Friday", "en", LIST.url), mk("x"))
  assert.equal(asked.plan!.booking!.venue, undefined)
  assert.doesNotMatch(asked.plan!.fromChat ?? "", /Old Town/)
  const q = asked.plan!.questions.find((x) => x.kind === "venue")
  assert.ok(q, "which place is asked")
  assert.match(q!.options[0], /^Old Town Guesthouse/, "the chat's suggestion first")
  const pointed = await drive(newState("n2b", "Book the one you suggested for 2 nights from next Friday", "en", LIST.url), mk("x"))
  assert.equal(pointed.plan!.booking!.venue, "Old Town Guesthouse")
})

test("N3: the last «Do it?» names the place whatever way it was opened", () => {
  const s = newState("n3", "Book a stay for 2 nights from next Friday", "en", "https://stays.example/stay?id=0")
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", at: "", from: "", until: "", minutes: 0 } } as unknown as TaskPlan
  s.placeOpened = "Harbour View Suites"
  const page = { url: s.url, title: "Rooms and rates", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "2026-12-04 – 2026-12-06", items: [] } as unknown as PageMap
  assert.equal(recapOf(s, page, true)?.place, "Harbour View Suites")
  // The page's own name when it is one place's page.
  s.placeOpened = undefined
  assert.equal(recapOf(s, { ...page, title: "Harbour View Suites — rooms and rates", text: "Harbour View Suites\n8.9 · 412 reviews\n2026-12-04 – 2026-12-06", items: [{ id: "r", role: "button", label: "Reserve" }] } as unknown as PageMap, true)?.place, "Harbour View Suites")
})
