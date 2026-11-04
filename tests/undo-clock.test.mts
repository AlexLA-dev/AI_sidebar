// How long the "… · Undo" bars stay (src/content/undoClock.ts), and the app keeping the same numbers (UndoClock in
// ContextFlow/Shared (App)/OrganizeViews.swift).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  BAR_AFTER_HOLD_MS, MOVE_BAR_GRACE_MS, MOVE_BAR_MS, UNDO_BAR_MS, barDeadline, deadlineAfterHold, goesOnWork
} from "../src/content/undoClock.ts"

const root = new URL("..", import.meta.url).pathname

test("the bar after a move is shorter than after a delete, with time to tap Undo", () => {
  assert.equal(UNDO_BAR_MS, 8_000)
  assert.equal(MOVE_BAR_MS, 5_000)
  assert.ok(MOVE_BAR_MS < UNDO_BAR_MS)
  assert.ok(MOVE_BAR_GRACE_MS >= 1_500 && MOVE_BAR_GRACE_MS < MOVE_BAR_MS)
  assert.equal(barDeadline("move", 1_000), 6_000)
  assert.equal(barDeadline("undo", 1_000), 9_000)
})

test("going on with the chat takes the bar after a move, not in its first seconds", () => {
  const shown = 10_000
  assert.equal(goesOnWork("move", shown, shown), false)
  assert.equal(goesOnWork("move", shown, shown + 300), false)
  assert.equal(goesOnWork("move", shown, shown + MOVE_BAR_GRACE_MS - 1), false)
  assert.equal(goesOnWork("move", shown, shown + MOVE_BAR_GRACE_MS), true)
  assert.equal(goesOnWork("move", shown, shown + 4_000), true)
})

test("after a delete, scrolling and swiping leave the bar its 8 s", () => {
  const shown = 10_000
  for (const at of [0, 1_000, 3_000, 7_900]) assert.equal(goesOnWork("undo", shown, shown + at), false)
})

test("a pointer resting on the bar holds it, then it goes a moment after", () => {
  const deadline = barDeadline("move", 0)
  // Left early: the bar keeps the rest of its seconds.
  assert.equal(deadlineAfterHold(deadline, 1_000), deadline)
  // Left at the last moment or after it: 1.5 s more.
  assert.equal(deadlineAfterHold(deadline, 4_800), 4_800 + BAR_AFTER_HOLD_MS)
  assert.equal(deadlineAfterHold(deadline, 20_000), 20_000 + BAR_AFTER_HOLD_MS)
})

test("the app's bar after a move keeps the panel's numbers", () => {
  const swift = readFileSync(`${root}ContextFlow/Shared (App)/OrganizeViews.swift`, "utf8")
  const seconds = (name: string): number => {
    const found = swift.match(new RegExp(`static let ${name}: TimeInterval = ([\\d.]+)`))
    assert.ok(found, `UndoClock.${name}`)
    return Number(found[1]) * 1000
  }
  assert.equal(seconds("move"), MOVE_BAR_MS)
  assert.equal(seconds("grace"), MOVE_BAR_GRACE_MS)
  assert.equal(seconds("afterHold"), BAR_AFTER_HOLD_MS)
  // The app's bar goes by itself (before 2.5 (76) it stayed until the next action).
  const chats = readFileSync(`${root}ContextFlow/Shared (App)/ChatsView.swift`, "utf8")
  assert.match(chats, /undoBarClock\.until\.timeIntervalSinceNow/)
  assert.match(chats, /\.onPreferenceChange\(ChatScrollTop\.self\)/)
})
