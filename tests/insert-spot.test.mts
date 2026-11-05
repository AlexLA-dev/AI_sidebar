// Where the button by a field goes: outside the field, never over the site's own buttons, none on searches.
import assert from "node:assert/strict"
import { test } from "node:test"

import { parseHTML } from "linkedom"

import { BUTTON, buttonPlace, buttonSpot, cornerSpot, multiLineField, noButtonField } from "../src/content/insert/spot.ts"

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

test("no room around a chat's reply box: inside its bottom-right corner, never over its text or caret", () => {
  // The director's decision on 2.5 (77) (LinkedIn's messages): the last message above, Send beside, the keyboard below.
  const box = rect(24, 300, 300, 80)
  const message = { left: 0, top: 250, right: 375, bottom: 299 }
  const send = { left: 326, top: 300, right: 371, bottom: 340 }
  const keyboard = { left: 0, top: 384, right: 375, bottom: 667 }
  assert.equal(buttonSpot(box, view, taken([message, send, keyboard])), null, "nothing free outside")
  const corner = cornerSpot(box, view, free, [])
  assert.deepEqual(corner, { top: 380 - 4 - BUTTON, left: 324 - 4 - BUTTON }, "inside, 4 pt from its bottom and right edges")
  assert.ok(corner!.top >= box.top && corner!.left + BUTTON <= box.right && corner!.top + BUTTON <= box.bottom, "within the field")
  // Text on the first line only: the corner is clear.
  const firstLine = { left: 36, top: 308, right: 300, bottom: 328 }
  assert.deepEqual(cornerSpot(box, view, free, [firstLine]), corner)
  // The text (or the caret at the end of it) comes down to the corner: no button there; "/" still works.
  const lastLine = { left: 36, top: 352, right: 296, bottom: 372 }
  assert.equal(cornerSpot(box, view, free, [firstLine, lastLine]), null)
  const caret = { left: 296, top: 352, right: 297, bottom: 372 }
  assert.equal(cornerSpot(box, view, free, [caret]), null)
  // The site's own button in the field's corner (an emoji button over the editor): taken.
  assert.equal(cornerSpot(box, view, taken([{ left: 280, top: 336, right: 320, bottom: 376 }]), []), null)
  // Only the part in view counts: a tall editor running under the keyboard gets its visible corner.
  const tall = rect(24, 100, 300, 600)
  assert.deepEqual(cornerSpot(tall, { width: 375, height: 380 }, free, []), { top: 380 - 4 - 4 - BUTTON, left: 324 - 4 - BUTTON })
  // A reply box one line tall: in the middle of its height; a field shorter than the button and its gaps: none.
  assert.deepEqual(cornerSpot(rect(24, 300, 300, 36), view, free, []), { top: 336 - 3 - BUTTON, left: 324 - 4 - BUTTON })
  assert.equal(cornerSpot(rect(24, 300, 300, 32), view, free, []), null)
})

test("only multi-line fields get the button inside: a textarea, an editor; never a one-line input", () => {
  const { document } = parseHTML(`<body><textarea id="t"></textarea><div id="e" contenteditable="true"></div>
    <div id="s" contenteditable="true" aria-multiline="false"></div><input id="i" type="text"></body>`)
  assert.equal(multiLineField(document.getElementById("t")!), true)
  assert.equal(multiLineField(document.getElementById("e")!), true)
  assert.equal(multiLineField(document.getElementById("s")!), false)
  assert.equal(multiLineField(document.getElementById("i")!), false)
})

test("the order: the corners outside, then along the edges, and only then inside a multi-line field's corner", () => {
  // The reply box, "expand" beside it; the last message along its whole top, the footer along its whole bottom.
  const box = rect(24, 520, 300, 64)
  const expand = { left: 326, top: 520, right: 358, bottom: 552 }
  const message = { left: 0, top: 470, right: 375, bottom: 516 }
  const footer = { left: 0, top: 586, right: 375, bottom: 620 }
  const inside = { free, text: () => [] }
  // Corners and edges all taken: inside its corner.
  assert.deepEqual(buttonPlace(box, view, taken([message, expand, footer]), inside), { top: 584 - 4 - BUTTON, left: 324 - 4 - BUTTON, inside: true })
  // One spot left along the bottom edge (left of Send): there, outside, never inside.
  const send = { left: 270, top: 588, right: 350, bottom: 616 }
  const attach = { left: 24, top: 588, right: 160, bottom: 616 }
  assert.deepEqual(buttonPlace(box, view, taken([message, expand, send, attach]), inside), { top: 584 + 4, left: 324 - 3 * BUTTON, inside: false })
  // A free corner outside: there, as the audit settled.
  assert.deepEqual(buttonPlace(box, view, free, inside), { top: 520 - 4 - BUTTON, left: 324 - BUTTON, inside: false })
  // A one-line input (no inside), everything taken: no button.
  assert.equal(buttonPlace(box, view, taken([message, expand, footer]), null), null)
  // Inside, the text reaches the corner: no button; the text isn't measured while a spot outside is free.
  let measured = 0
  const busy = { free, text: () => { measured++; return [{ left: 36, top: 556, right: 300, bottom: 576 }] } }
  assert.equal(buttonPlace(box, view, taken([message, expand, footer]), busy), null)
  assert.equal(buttonPlace(box, view, free, busy)?.inside, false)
  assert.equal(measured, 1)
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
