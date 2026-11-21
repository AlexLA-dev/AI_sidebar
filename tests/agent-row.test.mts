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
