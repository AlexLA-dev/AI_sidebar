// 2.7 (107), C2 on an iPad mini: a selection one tap made in a field (iPadOS selects a word it marks) gets none of the
// selection's buttons; one made on purpose (double tap, long press, handles, Select All) still does.
import assert from "node:assert/strict"
import { test } from "node:test"

import { AFTER_TAP_MS, byOneTap, onPurpose, pressDown, secondTap, TAP_MS, type Press } from "../src/content/tapSelect.ts"

const tap = (prev: Press | null, at: number, inField = true, x = 100, y = 200, held = 90): Press => {
  const p = pressDown(prev, at, x, y, inField)
  p.upAt = at + held
  return p
}

test("one short tap in a field: the selection right after it is the tap's", () => {
  const p = tap(null, 1000)
  assert.equal(byOneTap(p, 1090), true)
  assert.equal(byOneTap(p, 1090 + 200), true)
  // While the finger is still down, at a tap's pace.
  const down = pressDown(null, 5000, 10, 10, true)
  assert.equal(byOneTap(down, 5000 + 120), true)
})

test("a selection made on purpose keeps its buttons", () => {
  // A double tap: the second tap soon after the first and near it.
  const first = tap(null, 1000)
  const second = tap(first, 1000 + 90 + 200, true, 104, 203)
  assert.equal(second.count, 2)
  assert.equal(byOneTap(second, second.upAt! + 50), false)
  // A long press: held past a tap, with the finger down or up.
  const long = pressDown(null, 3000, 50, 50, true)
  assert.equal(byOneTap(long, 3000 + 520), false)
  long.upAt = 3000 + 700
  assert.equal(byOneTap(long, 3000 + 720), false)
  // The handles dragged, or Select All from the menu: the selection comes long after the tap that showed the caret.
  const caret = tap(null, 8000)
  assert.equal(byOneTap(caret, caret.upAt! + AFTER_TAP_MS + 1), false)
  // A drag (the finger moved), or the system took the press (pointercancel).
  const dragged = tap(null, 9000)
  dragged.moved = true
  assert.equal(byOneTap(dragged, 9100), false)
})

test("a press made on purpose: a double tap, a long press; one short tap or a scroll isn't", () => {
  assert.equal(onPurpose(tap(null, 1000)), false)
  const first = tap(null, 1000)
  assert.equal(onPurpose(tap(first, 1000 + 90 + 200, true, 102, 201)), true)
  assert.equal(onPurpose(tap(null, 3000, true, 100, 200, TAP_MS + 200)), true)
  // A long press the system takes (pointercancel) while the finger is still down.
  assert.equal(onPurpose(pressDown(null, 4000, 10, 10, true), 4000 + 520), true)
  // A scroll: the finger moved.
  const scrolled = tap(null, 5000, true, 100, 200, 600)
  scrolled.moved = true
  assert.equal(onPurpose(scrolled), false)
})

test("iPad Safari's double tap: one pointer press, then dblclick, then the word selected", () => {
  // What the simulator showed: pointerdown 98324, pointerup 98391, click, dblclick 98474, the selection right after.
  const first = tap(null, 98324, true, 100, 200, 67)
  assert.equal(byOneTap(first, 98474), true)
  const both = secondTap(first)
  assert.equal(both.count, 2)
  assert.equal(byOneTap(both, 98475), false)
  assert.equal(onPurpose(both), true)
})

test("page text and a pointer are untouched", () => {
  // A tap in the page's text, outside any field.
  assert.equal(byOneTap(tap(null, 1000, false), 1100), false)
  // No finger press at all (a mouse, a trackpad): nothing recorded.
  assert.equal(byOneTap(null, 1100), false)
})

test("two taps far apart in time or place are two single taps", () => {
  const first = tap(null, 1000)
  const late = tap(first, 1000 + 90 + 600)
  assert.equal(late.count, 1)
  const far = tap(first, 1000 + 90 + 150, true, 400, 600)
  assert.equal(far.count, 1)
  // A slow press isn't the first of a double tap.
  const slow = tap(null, 2000, true, 100, 200, TAP_MS + 50)
  assert.equal(tap(slow, 2000 + TAP_MS + 50 + 100).count, 1)
})
