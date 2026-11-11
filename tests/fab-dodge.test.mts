import { test } from "node:test"
import assert from "node:assert/strict"

import { dodgeFab, type Box } from "../src/content/fabDodge.ts"

// iPhone portrait: 375 × 667, the round button on the right at 60 % (center 400), 48 pt.
const box = (top: number, bottom: number, left = 8, right = 367): Box => ({ top, bottom, left, right })
const fabAt = (center: number, left = 313, right = 361): Box => ({ top: center - 24, bottom: center + 24, left, right })
const view = { top: 0, bottom: 667 }
const covers = (fab: Box, center: number, b: Box) => {
  const top = center - (fab.bottom - fab.top) / 2
  const bottom = top + (fab.bottom - fab.top)
  return fab.left < b.right && fab.right > b.left && top < b.bottom && bottom > b.top
}

test("buttons elsewhere: the round button stays home", () => {
  assert.equal(dodgeFab(fabAt(400), box(100, 230), box(60, 90), view), null)
  // Mac: a narrow pop-up in the middle doesn't reach the right edge.
  assert.equal(dodgeFab(fabAt(400, 1380, 1428), box(380, 470, 600, 900), box(330, 360, 620, 880), { top: 0, bottom: 900 }), null)
})

test("the pop-up over it: it steps to the nearer free side, clear of the pop-up and the selection", () => {
  const fab = fabAt(400)
  const bubble = box(360, 492)
  const selection = box(250, 272)
  const c = dodgeFab(fab, bubble, selection, view)
  assert.notEqual(c, null)
  assert.ok(!covers(fab, c!, bubble), `center ${c} covers the pop-up`)
  assert.ok(!covers(fab, c!, selection), `center ${c} covers the selection`)
  assert.ok(c! - 24 >= 8 && c! + 24 <= 659, "on screen")
})

test("the chips row makes the pop-up taller: still out of the way", () => {
  const fab = fabAt(330)
  const bubble = box(270, 440)
  const c = dodgeFab(fab, bubble, box(180, 200), view)!
  assert.ok(!covers(fab, c, bubble))
})

test("a selection at the bottom edge: the pop-up above it, the button above the pop-up", () => {
  const fab = fabAt(560)
  const bubble = box(470, 602)
  const selection = box(620, 650)
  const c = dodgeFab(fab, bubble, selection, view)!
  assert.ok(c + 24 <= 470, `center ${c}`)
})

test("a selection at the top edge: the button below the pop-up", () => {
  const fab = fabAt(130)
  const bubble = box(60, 192)
  const c = dodgeFab(fab, bubble, box(10, 40), view)!
  assert.ok(c - 24 >= 192, `center ${c}`)
})

test("landscape, the pop-up nearly as tall as the screen: the edge with more room", () => {
  const land = { top: 0, bottom: 375 }
  const fab = fabAt(200, 740, 788)
  const bubble = box(60, 330, 400, 800)
  const c = dodgeFab(fab, bubble, box(20, 45, 400, 600), land)!
  assert.ok(c - 24 >= 8 && c + 24 <= 367)
  assert.ok(!covers(fab, c, bubble), `center ${c}`)
})

test("the keyboard up (a smaller visible part): stays within it", () => {
  const vis = { top: 0, bottom: 380 }
  const fab = fabAt(300)
  const bubble = box(230, 362)
  const c = dodgeFab(fab, bubble, box(150, 170), vis)!
  assert.ok(c - 24 >= 8 && c + 24 <= 372, `center ${c}`)
  assert.ok(!covers(fab, c, bubble))
})
