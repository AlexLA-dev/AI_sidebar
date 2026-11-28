// The agent's bubble by the circle (2.7.1, the owner: work with the chat closed). The bubble is a .tsx component, so the
// rules are checked in its source, as the panel's other tests do: what it may answer, what only opens the chat, how
// another tab's answer reaches the task, and that a page's script can't press it.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const bubble = readFileSync(new URL("../src/content/agent/Bubble.tsx", import.meta.url), "utf8")
const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
const bg = readFileSync(new URL("../src/background/agent.ts", import.meta.url), "utf8")
const locales = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]

test("only a real tap presses the bubble (a page's script dispatches untrusted events)", () => {
  assert.match(bubble, /const real = \(fn: \(\) => void\) => \(e: Event\) => \{\n\s+if \(!e\.isTrusted\) return/)
  // Every button goes through it, the «×» too; none takes focus from the page.
  const buttons = bubble.match(/<button [^>]*>/g) ?? []
  assert.ok(buttons.length >= 2)
  for (const b of buttons) {
    assert.match(b, /onClick=\{real\(/)
    assert.match(b, /tabIndex=\{-1\}/)
  }
})

test("at most three answers; more than three: two and «Другое…» (the chat)", () => {
  assert.match(bubble, /const fit = choices\.length > 3 \? choices\.slice\(0, 2\) : choices/)
  assert.match(bubble, /other: choices\.length > 3/)
  assert.match(bubble, /buttons\.slice\(0, 3\)/)
  // The model's «Отмена» isn't an answer (the chat has Stop); a detail to type goes to the chat's field.
  assert.match(bubble, /filter\(\(c\) => c && !isCancelChoice\(c\)\)/)
  assert.match(bubble, /if \(s\.askKey \|\| choices\.length === 0\) return \{ \.\.\.base, kind: "open"/)
})

test("a warning, a form to check, an app's access: the bubble only opens the chat", () => {
  assert.match(bubble, /if \(p\.offRequest \|\| p\.price\) return \{ \.\.\.base, kind: "open"/)
  assert.match(bubble, /if \(isAccess\(s\)\) return \{ \.\.\.base, kind: "open"/)
  assert.match(bubble, /case "fill":\n\s+case "plan":\n\s+return \{ \.\.\.base, kind: "open"/)
  // The person's own step (sign-in, payment) is answered with «Готово» only: never done for them.
  assert.match(bubble, /\{ label: t\("agentSelfDone"\), on: act\.did, primary: true \}/)
  // Stopped by the person: nothing to say.
  assert.match(bubble, /const ENDED = new Set\(\["done", "error", "blocked"\]\)/)
})

test("another tab's answer names the step and goes through the panel's own check", () => {
  // The notice carries the step's key and the step (never the form's values).
  assert.match(bg, /key: pendingKey\(state\), \.\.\.\(p \? \{ pending: \{ call: p\.call, verdict: p\.verdict, target: p\.target, offRequest: p\.offRequest, price: p\.price, recap: p\.recap \} \} : \{\}\)/)
  assert.doesNotMatch(bg, /pending: \{[^}]*fill/)
  // Only for the notice's step, then the same reply() as the panel (its key check, once per step).
  assert.match(bg, /if \(!n \|\| !key \|\| n\.key !== key \|\| a === "stop"\) return \{ ok: false, code: "STALE" \}\n\s+const r = await reply\(n\.tab, a, chosen, key, "bubble"\)/)
  assert.match(app, /sendBackground<\{ ok: boolean \}>\(\{ type: "agentNoticeAnswer", answer: a, chosen, key: b\.key \}\)/)
})

test("the bubble steps aside: the chat open, a selection's buttons, the keyboard, a drag; «×» keeps a question for the circle", () => {
  assert.match(app, /const hereBubble = !popup && !open && agentTask \?/)
  assert.match(app, /const bubbleUp = !!agentBubble && fabVisible && !fabDrag\.state\.dragging && !bubble\?\.rect && !pageTyping && bubbleGone !== agentBubble\.key/)
  // The other lines by the circle make way for it.
  assert.match(app, /show=\{fabVisible && !fabDrag\.state\.dragging && !bubble\?\.rect && !bubbleUp\}/)
  // On the sheet, what the bubble answers keeps the chat closed after a step; only what needs the chat brings it back.
  assert.match(app, /if \(!b \|\| b\.kind === "open"\) show\(\)/)
  // The person closed the chat in a task: the next page of it doesn't open it again.
  assert.match(app, /if \(v\[AGENT_QUIET\] !== id\) show\(\)/)
})

test("the bubble's words in all 15 languages", () => {
  const keys = [...new Set([...bubble.matchAll(/t\("(agent[A-Za-z]+)"/g)].map((m) => m[1]))]
  assert.ok(keys.includes("agentBubbleSignIn") && keys.includes("agentBubbleOther"))
  for (const loc of locales) {
    const d = JSON.parse(readFileSync(new URL(`../src/locales/${loc}.json`, import.meta.url), "utf8")) as Record<string, string>
    for (const k of keys) assert.ok(d[k], `${loc}: ${k}`)
    for (const k of ["agentBubbleDone", "agentBubbleNotDone", "agentBubbleCheck"]) assert.match(d[k], /\{0\}/, `${loc}: ${k}`)
  }
})

test("the recap's asked time is in the device's clock, as the booked one (the director on 126: «07:00 PM» beside «19:10»)", () => {
  const panel = readFileSync(new URL("../src/content/agent/AgentPanel.tsx", import.meta.url), "utf8")
  assert.match(panel, /r\.askedDate \? when\(r\.askedDate, r\.askedTime\) : clock\(r\.askedTime \?\? ""\)/)
  // (In clockform.ts since 0a3d9e23's round, with the task's own form when its request wrote a time.)
  const clockSrc = readFileSync(new URL("../src/content/agent/clockform.ts", import.meta.url), "utf8")
  assert.match(clockSrc, /export function clock\(time: string\): string \{[\s\S]{0,200}Intl\.DateTimeFormat\(undefined, \{ hour: "2-digit", minute: "2-digit", \.\.\.hours\(\) \}\)/)
  assert.match(panel, /import \{ clock, clockFrom, hours, twelveToClock \} from "\.\/clockform"/)
})

test("another tab's finished task doesn't speak over a task working in this tab (126)", () => {
  assert.match(app, /const workingHere = agentTask\?\.status === "running"/)
  assert.match(app, /otherBubble && !\(workingHere && otherBubble\.kind === "end"\) \? otherBubble : null/)
})
