// The director's real-site run on 10eed066: device rules whose condition was too wide, narrowed by what the control or
// the page is — each with what it still refuses.
import assert from "node:assert/strict"
import { test } from "node:test"

import { answer, drive, newState, ownBookingPage, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, StepResult, ToolCall } from "../src/shared/agent/types.ts"

const step = (call: ToolCall, cls: "free" | "confirm", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const page = (title: string, text: string, items: PageMap["items"], url = "https://venue.example/reserve"): PageMap => ({ url, title, lang: "en", forms: [], more: 0, part: 1, parts: 1, text, items }) as PageMap
function io(maps: Array<PageMap | null>, replies: ActReply[], acts: Array<StepResult> = []): RunnerIO & { bodies: any[] } {
  const bodies: any[] = []
  let last = maps[maps.length - 1]
  return {
    bodies,
    map: async () => (maps.length ? (last = maps.shift() ?? null) : last),
    act: async () => acts.shift() ?? { ok: true, note: "the page changed" },
    waitPage: async () => {},
    ask: async (b) => {
      bodies.push(JSON.parse(JSON.stringify(b)))
      return replies.shift() ?? step({ tool: "done", summary: "x" }, "free", "read")
    },
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30
  }
}
const running = (url: string, booking: Record<string, unknown>): AgentState => {
  const s = newState("r137", "Book it", "en", url)
  s.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking } as unknown as TaskPlan
  s.chooseVenue = true
  return s
}

test("«the request names no place»: not on one place's own booking page; still on a page titled by its action", async () => {
  const days = [{ id: "1", role: "button", label: "Fri 27 Nov" }, { id: "2", role: "button", label: "19:00" }] as PageMap["items"]
  const own = page("Olive Room Tokyo - Reservations", "Olive Room Tokyo Reserve a table", days)
  assert.equal(ownBookingPage(own), true)
  const ask = step({ tool: "ask_user", question: "Friday is full. Saturday?", choices: ["Saturday"] } as ToolCall, "free", "read")
  const a = await drive(running(own.url, { kind: "table", date: "2026-11-27", from: "19:00", until: "19:00", minutes: 90 }), io([own], [ask]))
  assert.equal(a.status, "asked", "asked: the page is the place")
  // The case the rule was written for: a booking page that names no place («Book»), a request for any barbershop.
  const generic = page("Book", "Select date and time", days)
  assert.equal(ownBookingPage(generic), false)
  const b = await drive(running(generic.url, { kind: "table", date: "2026-11-27", from: "19:00", until: "19:00", minutes: 90 }), io([generic], [ask, ask, ask]))
  assert.equal(b.log.filter((e) => /refused: the request names no place/.test(e.result)).length, 2, "still refused there")
  // A list of places is never one place's own page.
  const list = page("Hotels in Limassol", "Hotels in Limassol", [...days, { id: "9", role: "link", label: "Harbour View Suites 8.9 (412 reviews)", href: "/h/1" }, { id: "10", role: "link", label: "Olive Grove 9.2 (188 reviews)", href: "/h/2" }, { id: "11", role: "link", label: "Seafront 8.4 (951 reviews)", href: "/h/3" }])
  assert.equal(ownBookingPage(list), false)
})

test("a day pressed that changed nothing doesn't count toward «two date steps went nowhere»; three that changed the page still do", async () => {
  const cal = page("Pick dates", "December 2026", [
    { id: "1", role: "option", label: "Fri 4 Dec" }, { id: "2", role: "checkbox", label: "Fri 4 Dec" },
    { id: "3", role: "option", label: "Sun 6 Dec" }, { id: "4", role: "checkbox", label: "Sun 6 Dec" }
  ])
  const press = (id: string, label: string) => step({ tool: "click", id, why: label } as ToolCall, "free", "date")
  const stay = { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0 }
  // The option copies do nothing, the checkboxes work: no refusal.
  const x = io([cal], [press("1", "4"), press("2", "4"), press("3", "6"), press("4", "6")], [{ ok: true, note: "nothing changed on the page" }, { ok: true, note: "the page changed" }, { ok: true, note: "nothing changed on the page" }, { ok: true, note: "the page changed" }])
  const st = await drive(running(cal.url, stay), x)
  assert.ok(!st.log.some((e) => /refused: (two date steps went nowhere|«Fri 4 Dec» was pressed already)/.test(e.result)), st.log.map((e) => e.result).join(" / "))
  // Three day presses that each changed the page: the rule is said about the third, as a note since decision 21.
  const table = page("Book", "December 2026", [{ id: "1", role: "button", label: "Sat 5 Dec" }, { id: "2", role: "button", label: "Sun 6 Dec" }, { id: "3", role: "button", label: "Mon 7 Dec" }])
  const y = io([table], [press("1", "5"), press("2", "6"), press("3", "7")])
  const t = await drive(running(table.url, { kind: "table", date: "2026-12-05", from: "19:00", until: "19:00", minutes: 90 }), y)
  assert.ok(t.log.some((e) => /device note: two date steps went nowhere/.test(e.result)), t.log.map((e) => e.result).join(" / "))
})

test("an empty map (between two pages after «back») is read again, never sent to the server", async () => {
  const empty = page("", "", [])
  const real = page("Book", "Select date", [{ id: "1", role: "button", label: "Fri 27 Nov" }])
  const x = io([empty, real], [step({ tool: "done", summary: "x" }, "free", "read")])
  await drive(running(real.url, { kind: "table", date: "2026-11-27", from: "19:00", until: "19:00", minutes: 90 }), x)
  assert.ok(x.bodies.length >= 1)
  assert.ok(x.bodies.every((b) => b.map && (b.map.items?.length || b.map.text)), "no empty map sent")
})

test("days the person gives in an answer are the booking's days from then on (a stay keeps its nights for one day given)", async () => {
  const cal = page("Casa Marina", "Casa Marina noviembre 2026", [{ id: "1", role: "option", label: "27 nov 2026" }, { id: "2", role: "option", label: "28 nov 2026" }])
  const s = running(cal.url, { kind: "stay", date: "2026-11-27", dateEnd: "2026-11-29", from: "", until: "", minutes: 0 })
  s.status = "asked"
  s.summary = "29 and 30 Nov are sold out. Book 1 night?"
  const st = await answer(s, io([cal], [step({ tool: "click", id: "2", why: "check-out 28" } as ToolCall, "free", "date")]), "reply", ["Reservar 1 noche (2026-11-27 a 2026-11-28)"])
  assert.equal(st.plan!.booking!.date, "2026-11-27")
  assert.equal(st.plan!.booking!.dateEnd, "2026-11-28")
  assert.ok(!st.log.some((e) => /isn't a day of this stay/.test(e.result)), "the new check-out isn't refused")
  // One day given: as many nights on as before.
  const t = running(cal.url, { kind: "stay", date: "2026-11-27", dateEnd: "2026-11-29", from: "", until: "", minutes: 0 })
  t.status = "asked"
  t.summary = "Friday is full. Another day?"
  const u = await answer(t, io([cal], []), "reply", ["2026-12-04"])
  assert.equal(u.plan!.booking!.dateEnd, "2026-12-06")
})

test("split name fields: a saved full name fills «First name» and «名» where the plan allows the full name; «氏» is the family name", async () => {
  const { fieldKind, saidInWords } = await import("../src/shared/agent/taskplan.ts")
  assert.equal(fieldKind({ label: "氏" } as never, null), "name.family")
  assert.equal(fieldKind({ label: "名" } as never, null), "name.given")
  // (Round 142, the director's S1: the full name's field takes the full name, never the given name's part.)
  assert.equal(fieldKind({ label: "氏名" } as never, null), "name.full", "the full name's field isn't the given name's")
  assert.equal(fieldKind({ label: "First name*" } as never, null), "name.given")
  // The request's own name, written with a middle dot and no spaces, counts as the person's words; a made-up one doesn't.
  assert.equal(saidInWords("名前はアレックス・テスト", "アレックス"), true)
  assert.equal(saidInWords("名前はアレックス・テスト", "レック"), false)
  assert.equal(saidInWords("名前はアレックス・テスト", "ボブ"), false)
  // Through a run: the plan's contact fill names the full name; the form asks first and last name apart.
  const form = page("Guest details", "Guest details", [
    { id: "10", role: "textbox", label: "First name*", lock: "personal", form: 0, state: ["empty"] },
    { id: "11", role: "textbox", label: "Last name*", lock: "personal", form: 0, state: ["empty"] }
  ] as PageMap["items"])
  form.forms = [{ n: 0, fillable: true }] as never
  const s = newState("r137n", "Book a stay", "en", form.url)
  s.plan = { steps: [], questions: [], perms: [{ id: "pc", kind: "fill", reason: "contact", label: "", keys: ["name.full", "email"], host: "venue.example", on: true }], self: [], prices: [], approved: true, booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", from: "", until: "", minutes: 0 } } as unknown as TaskPlan
  const x = { ...io([form], [step({ tool: "fill", id: "10", key: "name.given", why: "Filling in your first name" } as ToolCall, "confirm", "fill")]), entries: async () => [{ id: "e1", key: "name.full", label: "", value: "Alex Test", updatedAt: 1 }] as never }
  const st = await drive(s, x)
  const fill = st.log.find((e) => e.call.tool === "fill" && e.call.id === "10")!
  assert.doesNotMatch(fill.result, /doesn't fit this field/)
})
