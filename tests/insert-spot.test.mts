// Where the button by a field goes: outside the field, never over the site's own buttons, none on searches.
import assert from "node:assert/strict"
import { test } from "node:test"

import { parseHTML } from "linkedom"

import { BUTTON, buttonSpot, noButtonField } from "../src/content/insert/spot.ts"

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })
const view = { width: 375, height: 667 }
const free = () => true
// The site's search button at the field's right end, and a header bar above the field.
const taken = (boxes: Array<{ left: number; top: number; right: number; bottom: number }>) => (x: number, y: number) =>
  !boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)

test("never inside the field: above its top-right corner when that's free", () => {
  const field = rect(16, 200, 343, 44)
  const spot = buttonSpot(field, view, free)!
  assert.deepEqual(spot, { top: 200 - 4 - BUTTON, left: 359 - BUTTON })
  assert.ok(spot.top + BUTTON <= field.top, "above the field, not over it")
})

test("over something of the site's: beside the field, else below, else no button", () => {
  const field = rect(16, 200, 300, 44)
  const header = { left: 0, top: 150, right: 375, bottom: 199 }
  assert.deepEqual(buttonSpot(field, view, taken([header])), { top: 200 + 22 - BUTTON / 2, left: 316 + 4 })
  const wide = rect(16, 200, 343, 44)
  assert.deepEqual(buttonSpot(wide, view, taken([header])), { top: 244 + 4, left: 359 - BUTTON })
  const below = { left: 0, top: 245, right: 375, bottom: 300 }
  assert.equal(buttonSpot(wide, view, taken([header, below])), null)
})

test("a chat's reply box with its corners taken: along its top edge, else its bottom edge (LinkedIn's messages)", () => {
  // The reply box, a read receipt over its top-right corner, "expand" beside it, Send under its bottom-right corner.
  const box = rect(24, 520, 300, 64)
  const receipt = { left: 300, top: 490, right: 330, bottom: 516 }
  const expand = { left: 326, top: 520, right: 358, bottom: 552 }
  const send = { left: 270, top: 588, right: 350, bottom: 616 }
  assert.deepEqual(buttonSpot(box, view, taken([receipt, expand, send])), { top: 520 - 4 - BUTTON, left: 324 - 2 * BUTTON })
  // The last message's text all along the top: under the box, left of Send, right of the attach buttons.
  const message = { left: 0, top: 470, right: 375, bottom: 516 }
  const attach = { left: 24, top: 588, right: 160, bottom: 616 }
  assert.deepEqual(buttonSpot(box, view, taken([message, expand, send, attach])), { top: 584 + 4, left: 324 - 3 * BUTTON })
  // Everything taken around it: no button.
  const footer = { left: 0, top: 586, right: 375, bottom: 620 }
  assert.equal(buttonSpot(box, view, taken([message, expand, footer])), null)
  // A free corner still wins (the spots the audit settled on stay as they were).
  assert.deepEqual(buttonSpot(box, view, free), { top: 520 - 4 - BUTTON, left: 324 - BUTTON })
})

test("off screen or at the very top: the next spot, or none", () => {
  assert.equal(buttonSpot(rect(16, 700, 343, 44), view, free), null)
  // A field at the top of the view: no room above, the field fills the width, so below.
  assert.deepEqual(buttonSpot(rect(0, 10, 375, 44), view, free), { top: 58, left: 375 - 4 - BUTTON })
})

test("searches, codes, emails, phones and links get no button; ordinary fields do", () => {
  const { document } = parseHTML(`<body>
    <form role="search"><input id="a" type="text"></form>
    <input id="b" type="search"><input id="c" type="email"><input id="d" type="tel"><input id="e" type="url">
    <input id="f" type="text" autocomplete="one-time-code"><input id="g" type="text" inputmode="numeric">
    <input id="h" type="text" placeholder="Search Amazon"><input id="i" type="text" name="q"><input id="j" type="text" aria-label="Поиск">
    <div role="search"><div id="k" contenteditable="true"></div></div>
    <input id="m" type="text" placeholder="Your name"><textarea id="n"></textarea><div id="o" contenteditable="true"></div>
  </body>`)
  for (const id of "abcdefghijk") assert.equal(noButtonField(document.getElementById(id)!), true, id)
  for (const id of "mno") assert.equal(noButtonField(document.getElementById(id)!), false, id)
})
