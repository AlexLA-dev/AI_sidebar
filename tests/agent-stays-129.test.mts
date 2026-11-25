// The director's pass on 795dea34 (iPad, the stand's stays): a stay asked from a list never ended in a booking — the
// list's Search not pressed, a card that opens its stay in a new tab by script (blocked for the agent's tap), five ✓
// on a tap that did nothing; dates in text doubled or swallowed; a choice with a price the page didn't show.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { daysAsIso } from "../src/shared/agent/dates.ts"
import { drive, newState, NEW_TAB_ID, searchFirst, type ActReply, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import { honestChoices } from "../src/shared/agent/rules.ts"
import type { TaskPlan } from "../src/shared/agent/taskplan.ts"
import type { PageMap, StepResult, ToolCall } from "../src/shared/agent/types.ts"

const LIST = (url: string, text: string, values: [string, string] = ["", ""]): PageMap => ({
  url, title: "Stays in Limassol", lang: "en", forms: [], more: 0, part: 1, parts: 1, text,
  items: [
    { id: "2", role: "textbox", label: "Check-in", type: "date", ...(values[0] ? { value: values[0] } : {}) },
    { id: "3", role: "textbox", label: "Check-out", type: "date", ...(values[1] ? { value: values[1] } : {}) },
    { id: "5", role: "button", label: "Search" },
    { id: "6", role: "link", label: "Harbour View Suites", card: "8.9 · 412 reviews €96 per night Free cancellation" },
    { id: "7", role: "link", label: "Olive Grove Apartments", card: "9.2 · 188 reviews €120 per night Non-refundable" }
  ]
}) as PageMap

function stay(): AgentState {
  const s = newState("t129", "Book a stay for 2 nights from next Friday", "en", "https://stays.example/stays")
  s.plan = { steps: [], questions: [], self: [], prices: [], approved: true, perms: [], booking: { kind: "stay", date: "2026-12-04", dateEnd: "2026-12-06", at: "", from: "", until: "", minutes: 0 } } as unknown as TaskPlan
  return s
}

function io(replies: ActReply[], maps: PageMap[], results: StepResult[] = []) {
  const asked: Array<Record<string, any>> = []
  const acted: ToolCall[] = []
  const opened: string[] = []
  let n = 0
  const r: RunnerIO & { asked: typeof asked; acted: typeof acted; opened: string[] } = {
    asked, acted, opened,
    map: async () => maps[Math.min(n, maps.length - 1)],
    act: async (c) => {
      acted.push(c)
      n++
      return results.shift() ?? { ok: true, note: "the page changed", changed: true }
    },
    open: async (url) => {
      opened.push(url)
      n++
    },
    waitPage: async () => {},
    ask: async (body) => {
      asked.push(JSON.parse(JSON.stringify(body)))
      return replies.shift() ?? { ok: true, call: { tool: "done", summary: "ok" }, verdict: { cls: "free", reason: "read" } }
    },
    save: async () => {},
    entries: async () => [],
    policy: { amazon: true },
    maxSteps: 30
  }
  return r
}
const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: call.id === "6" ? 'link "Harbour View Suites"' : call.id === NEW_TAB_ID ? 'link "Harbour View Suites (opens in a new tab)"' : null })

test("3: a stay isn't opened from a list whose own search hasn't taken the days — once per page", () => {
  const s = stay()
  const typed = LIST("https://stays.example/stays?city=Limassol", "Stays in Limassol", ["2026-12-04", "2026-12-06"])
  assert.match(searchFirst(s, typed) ?? "", /its date fields have them, but its search wasn't pressed/)
  assert.match(searchFirst(s, LIST("https://stays.example/stays?city=Limassol", "Stays in Limassol")) ?? "", /set them in its own date fields/)
  // Searched: the list's address (or its text) carries the days.
  assert.equal(searchFirst(s, LIST("https://stays.example/stays?city=Limassol&in=2026-12-04&out=2026-12-06", "Stays in Limassol", ["2026-12-04", "2026-12-06"])), null)
  assert.equal(searchFirst(s, LIST("https://stays.example/stays", "Stays in Limassol · 4 Dec – 6 Dec 2026")), null)
  // No date fields of its own: nothing to search with here.
  assert.equal(searchFirst(s, { ...typed, items: typed.items.filter((i) => i.type !== "date") } as PageMap), null)
  s.searchNudged = [typed.url]
  assert.equal(searchFirst(s, typed), null, "said once per page")
})

test("3: in a run, the open is sent back once, then goes", async () => {
  const typed = LIST("https://stays.example/stays?city=Limassol", "Stays in Limassol", ["2026-12-04", "2026-12-06"])
  const open = () => step({ tool: "click", id: "6", why: "Opening Harbour View Suites" }, "free", "click")
  const x = io([open(), open(), step({ tool: "done", summary: "stopped" }, "free", "read")], [typed])
  await drive(stay(), x)
  assert.match(x.asked[1].log.at(-1).result, /refused: this list doesn't carry the stay's days/)
  assert.equal(x.acted.length, 1, "the second time it goes")
})

test("5: a card that opens its stay in a new tab by script: the address is a link here, gone to with the usual checks", async () => {
  const searched = LIST("https://stays.example/stays?city=Limassol&in=2026-12-04&out=2026-12-06", "Stays in Limassol", ["2026-12-04", "2026-12-06"])
  const x = io(
    [step({ tool: "click", id: "6", why: "Opening Harbour View Suites" }, "free", "click"), step({ tool: "go", id: NEW_TAB_ID, why: "Opening it here" }, "free", "click"), step({ tool: "done", summary: "stopped" }, "free", "read")],
    [searched],
    [{ ok: true, note: "the page tried to open another page in a new tab", opened: "https://stays.example/stay?id=0&in=2026-12-04&out=2026-12-06" }]
  )
  const after = await drive(stay(), x)
  assert.match(x.asked[1].log.at(-1).result, /tried to open https:\/\/stays\.example\/stay\?id=0.* go to link #newtab/)
  assert.ok(x.asked[1].map.items.some((i: { id: string; href?: string }) => i.id === NEW_TAB_ID && /stay\?id=0/.test(i.href ?? "")), "the model sees it as a link")
  assert.deepEqual(x.opened, ["https://stays.example/stay?id=0&in=2026-12-04&out=2026-12-06"], "opened in this tab")
  assert.equal(after.openedLink, undefined)
  // Another site's address goes through the device's own check like any «go»: a confirm, never free.
  const other = io(
    [step({ tool: "click", id: "6", why: "Opening" }, "free", "click"), step({ tool: "go", id: NEW_TAB_ID, why: "Opening it here" }, "free", "click")],
    [searched],
    [{ ok: true, note: "the page tried to open another page in a new tab", opened: "https://elsewhere.example/stay" }]
  )
  const asked = await drive(stay(), other)
  assert.deepEqual(other.opened, [], "not opened without the person")
  assert.notEqual(asked.status, "running")
})

test("5: the page's world unreachable and the tap did nothing: the person taps it themselves", async () => {
  const searched = LIST("https://stays.example/stays?in=2026-12-04&out=2026-12-06", "Stays", ["2026-12-04", "2026-12-06"])
  const x = io([step({ tool: "click", id: "6", why: "Opening Harbour View Suites" }, "free", "click")], [searched], [{ ok: true, note: "nothing changed on the page", tabBlocked: true }])
  const after = await drive(stay(), x)
  assert.equal(after.status, "self")
  assert.equal(after.pending?.verdict.reason, "new_tab")
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /case "new_tab": return t\("agentSelfNewTab", name\)/)
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  assert.match(bg, /const theirs = st\?\.status === "self" && st\.pending\?\.verdict\.reason === "new_tab"/)
  const hands = readFileSync(new URL("../src/content/agent/hands.ts", import.meta.url), "utf8")
  // Only during the agent's own tap, and put back after it.
  assert.match(hands, /const win = toggle \? null : catchNewTab\(el!\.ownerDocument\)/)
  // (Put back after the tap: tests/agent-newtab.test.mts runs the page-side script itself.)
})

test("2: a tap that changed nothing gets no ✓, and its place isn't offered again", async () => {
  const searched = LIST("https://stays.example/stays?in=2026-12-04&out=2026-12-06", "Stays", ["2026-12-04", "2026-12-06"])
  const x = io(
    [step({ tool: "click", id: "6", why: "Opening Harbour View Suites" }, "free", "click"), step({ tool: "ask_user", question: "Which one?", choices: ["Try Harbour View Suites again", "Olive Grove Apartments ($74 per night)", "Old Town Guesthouse · €88 per night"] }, "free", "read")],
    [searched],
    [{ ok: true, note: "nothing changed on the page" }]
  )
  const after = await drive(stay(), x)
  assert.equal(after.lines[0].ok, false)
  assert.deepEqual(after.dead, ["Harbour View Suites"])
  // (Old Town isn't on this page: its price can't be the page's.)
  assert.deepEqual(after.choices, ["Olive Grove Apartments", "Old Town Guesthouse"])
})

test("5 (choices): a price stays only when the page shows it for that item", () => {
  const map = LIST("https://stays.example/stays", "Old Town Guesthouse 9.0 €88 per night")
  assert.deepEqual(honestChoices(["Olive Grove Apartments ($74 per night)", "Olive Grove Apartments (€120 per night)", "Harbour View Suites — €96 per night", "Harbour View Suites — €74"], map), ["Olive Grove Apartments", "Olive Grove Apartments (€120 per night)", "Harbour View Suites — €96 per night", "Harbour View Suites"])
})

test("4: dates in text — a weekday before a date goes, a bracket stays, a range is read", () => {
  assert.equal(daysAsIso("Friday, 2026-12-04", "2026-11-25"), "2026-12-04")
  assert.equal(daysAsIso("Fri 2026-12-04 to Sun 2026-12-06", "2026-11-25"), "2026-12-04 to 2026-12-06")
  assert.equal(daysAsIso("пятница 2026-12-04", "2026-11-25"), "2026-12-04")
  assert.equal(daysAsIso("doesn't show your dates yet (Fri, Dec 4 to Sun, Dec 6), so", "2026-11-25"), "doesn't show your dates yet (2026-12-04 to 2026-12-06), so")
  assert.equal(daysAsIso("for 4–6 December", "2026-11-25"), "for 2026-12-04 – 2026-12-06")
  assert.equal(daysAsIso("December 4-6 please", "2026-11-25"), "2026-12-04 – 2026-12-06 please")
})

test("6: a press line with no words says what was pressed", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /\(l\.tool === "click" \|\| l\.tool === "go"\) && l\.target \? t\("agentLinePressed", nameOf\(l\.target\)\)/)
  for (const loc of ["en", "ru", "ja", "ar"]) {
    const m = JSON.parse(readFileSync(new URL(`../src/locales/${loc}.json`, import.meta.url), "utf8"))
    assert.ok(m.agentLinePressed && m.agentSelfNewTab, loc)
  }
})

test("the tap's own watching script isn't a page change («nothing changed» stays true)", () => {
  const hands = readFileSync(new URL("../src/content/agent/hands.ts", import.meta.url), "utf8")
  assert.match(hands, /if \(records\.every\(ownMark\)\) return/)
  assert.match(readFileSync(new URL("../src/content/agent/newtab.ts", import.meta.url), "utf8"), /s\.setAttribute\("data-cf-shim", ""\)/)
  assert.match(hands, /if \(r\.type === "attributes"\) return !!r\.attributeName\?\.startsWith\("data-cf-"\)/)
})
