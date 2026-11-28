// The agent's usage events (2.7.1, the owner's «да» on 2026-11-24): start and end once each, tied by the task's random
// id; only kinds and counts the registry lists reach the server — never a site, a name, a time or the request.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { agentEvents, pageKind, taskWhat } from "../src/shared/agent/events.ts"
import { newState, type AgentState } from "../src/shared/agent/runner.ts"
import { useFields } from "../src/shared/usage.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

const ID = "0b6e1c2a-6a4f-4c1e-9f3a-2d1b7a9c4e10"
const task = (over: Partial<AgentState>): AgentState => ({ ...newState(ID, "Столик на двоих в Trattoria Sole в 20:00, почта anna@example.com", "ru", "https://tables.example/r/sole"), ...over })

test("a task's start once it leaves its card, its end once it ends; a task cancelled at the card has neither", () => {
  const s = task({ status: "plan", plan: { approved: false, questions: [], perms: [], booking: { kind: "table" } } as never, pageKind: "form", startedAt: 1_000 })
  assert.deepEqual(agentEvents(s, 2_000), [], "still at the card")
  s.status = "running"
  s.plan!.approved = true
  const [start] = agentEvents(s, 3_000)
  assert.deepEqual(start, { f: "agent", a: "start", task: ID, what: "book_table", page: "form", card: "shown" })
  assert.deepEqual(agentEvents(s, 4_000), [], "once")
  s.status = "done"
  s.step = 7
  s.recapShown = true
  const [end] = agentEvents(s, 61_400)
  assert.deepEqual(end, { f: "agent", a: "end", task: ID, what: "book_table", result: "done", steps: 7, calls: 8, secs: 60, recap: "yes" })
  assert.deepEqual(agentEvents(s, 70_000), [], "once")
  const cancelled = task({ status: "stopped", plan: { approved: false, questions: [], perms: [] } as never })
  assert.deepEqual(agentEvents(cancelled), [])
})

test("how a task ended: stopped, failed with its error class, done; a plan that went alone is «skipped»", () => {
  const ended = (over: Partial<AgentState>) => {
    const s = task({ plan: { approved: true, auto: true, questions: [], perms: [] } as never, ...over })
    return agentEvents(s)
  }
  assert.equal(ended({})[0].card, "skipped")
  assert.equal(ended({ status: "stopped" })[1].result, "stopped")
  assert.deepEqual([ended({ status: "done", error: "steps" })[1].result, ended({ status: "done", error: "steps" })[1].err], ["failed", "steps"])
  assert.equal(ended({ status: "error", error: "UPSTREAM" })[1].err, "upstream")
  assert.equal(ended({ status: "blocked" })[1].err, "blocked")
})

test("what the task does and the start page's kind, by the device's own reading", () => {
  const p = (perms: unknown[], booking?: unknown) => ({ plan: { perms, booking } }) as never
  assert.equal(taskWhat(p([], { kind: "stay" })), "book_stay")
  assert.equal(taskWhat(p([], { kind: "appointment" })), "book_visit")
  assert.equal(taskWhat(p([{ kind: "press", reason: "cart" }])), "cart")
  assert.equal(taskWhat(p([{ kind: "personal" }])), "form")
  assert.equal(taskWhat(p([])), "other")
  const map = (fillable: boolean): PageMap => ({ url: "https://x.example/", title: "", lang: "en", more: 0, part: 1, parts: 1, text: "", forms: [{ n: 0, fillable }], items: [] })
  assert.equal(pageKind(map(false), { kind: "product", name: "Runner" }), "product")
  assert.equal(pageKind(map(false), null, { kind: "rental" }), "stay")
  assert.equal(pageKind(map(true), null), "form")
  assert.equal(pageKind(map(false), null), "other")
})

test("the server keeps only the registry's fields: the task id, kinds and counts — nothing else that rides along", () => {
  const kept = useFields({ f: "agent", a: "end", task: ID.toUpperCase(), what: "book_table", result: "done", steps: 7, secs: 60, calls: 8, recap: "yes", url: "https://tables.example/r/sole", request: "Столик…", place: "Trattoria Sole" })
  assert.deepEqual(kept, { f: "agent", a: "end", task: ID, what: "book_table", result: "done", recap: "yes", steps: 7, secs: 60, calls: 8 })
  assert.deepEqual(useFields({ f: "agent", a: "question", via: "bubble", options: 3, did: "answered", task: "not-a-uuid" }), { f: "agent", a: "question", via: "bubble", did: "answered", options: 3 })
  assert.equal(useFields({ f: "agent", a: "booked" }), null, "an action the registry doesn't list")
})

test("where the events are sent: the background on save, the recap's and the questions' answers; the bubble's ✕ and «Show»", () => {
  const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  const act = readFileSync(new URL("../netlify/functions/v2-act.mts", import.meta.url), "utf8")
  assert.match(bg, /const events = agentEvents\(state\)\n\s+await write\(tab, state\)\n\s+for \(const e of events\) deps\.use\?\.\(e\)/)
  assert.match(bg, /a: a === "yes" \? "accepted" : "rejected", task: state\.id, via/)
  assert.match(bg, /via: "card", options: Math\.min\(9999, q\.options\.length\), did: a\.answers\[i\]\?\.trim\(\) \? "answered" : "dismissed"/)
  assert.match(app, /if \(b\.kind === "end"\) count\(\{ a: "result", did: "show" \}\)/)
  assert.match(app, /count\(\{ a: "question", via: "bubble", options: b\.options\.length, did: "dismissed" \}\)/)
  assert.equal((act.match(/logEvent\("agent_step", installId, \{\n\s+task: taskId,/g) ?? []).length, 2, "both agent_step rows carry the task id")
})
