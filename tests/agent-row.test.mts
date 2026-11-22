// 2.7.1, the owner's notes on the agent: the input row in Do mode, the folded task in the chat, the swipe down for Do.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const app = read("src/content/App.tsx")
const panel = read("src/content/agent/AgentPanel.tsx")

test("a swipe down on the send button is «Сделать» on Pro and Ultra (up stays the note); never on the ✦ circle's drag", () => {
  assert.match(app, /const swipeDo = hasPro\(status\?\.plan \?\? keptPlan \?\? "free"\) && !historyMode/)
  assert.match(app, /if \(dy > 0 && swipeDo\) flipDo\(\)\s*else flipMode\(\)/)
  // The circle's own gestures: tap, hold, drag in any direction — no swipe of its own.
  assert.doesNotMatch(read("src/content/side/drag.ts"), /swipe|agent/i)
})

test("a finished task folds to one line (request and mark), a tap opens it; one that only read shows its answer", () => {
  assert.match(panel, /if \(finished && !open\) \{/)
  assert.match(panel, /aria-expanded=\{false\} title=\{t\("agentShowSteps"\)\} onClick=\{\(\) => setOpen\(true\)\}/)
  assert.match(panel, /const answerOnly = state\.status === "done" && !past && !!state\.summary && state\.lines\.every\(\(l\) => READS\.has\(l\.tool\)\)/)
  // Earlier tasks stay in the chat, folded, without Undo.
  assert.match(app, /type: "agentClose", keep: true/)
  assert.match(panel, /state\.canUndo && !past &&/)
})

test("«Позже» is a choice in the plan card; the row has no clock", () => {
  assert.match(panel, /<LaterFields hasWatch=\{!!later\?\.hasWatch\}/)
  assert.doesNotMatch(app, /Icon\.Clock \/>\s*<\/button>\s*\)\}\s*<textarea/)
})

test("out of Safari mid-task: the paused notification only once steps stop, done or needs-you at once, gone on return", () => {
  const bg = read("src/background/agent.ts")
  assert.match(bg, /if \(state\.status === "running"\) \{\s*await callNative\("agent_schedule", \{ \.\.\.base, at: Date\.now\(\) \+ PAUSE_AFTER_MS/)
  assert.match(bg, /await callNative\("agent_notify", \{ \.\.\.base, body \}/)
  assert.match(bg, /if \(!words \|\| Date\.now\(\) - switchedAt < 1500\) return/)
  // The notification's tap: the task's own tab to the front, the page it opened goes.
  assert.match(bg, /if \(from !== undefined\) chrome\.tabs\.remove\(from/)
  assert.match(app, /if \(id\.startsWith\("run_"\)\) \{/)
})

test("a task Safari froze goes on when the person is back, and the frozen run never acts twice", () => {
  const bg = read("src/background/agent.ts")
  assert.match(bg, /if \(!st \|\| st\.status !== "running" \|\| Date\.now\(\) - \(st\.touchedAt \?\? 0\) < 15_000\) return/)
  assert.match(bg, /if \(now\?\.gen && now\.gen !== gen\) throw new Superseded/)
  assert.match(bg, /act: async \(call: ToolCall\) => \{\s*await live\(\)/)
  assert.match(bg, /for \(const \[tab\] of await activeTasks\(\)\) void resume\(tab\)/)
})

test("an opened finished task lists every step that ran; only a running one shows the newest few", () => {
  assert.match(panel, /const lines = finished \? shown : shown\.slice\(-8\)/)
})
