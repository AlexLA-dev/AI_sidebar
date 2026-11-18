// 2.7, the owner on an iPad mini in portrait (Gmail, zoomed to read): the ring around the selection sat a quarter of the
// screen above it, and the selection buttons under the system menu. Safari counts a page's rects from the visible part
// of the page and places `position: fixed` elements from the layout viewport; they part once the page is zoomed or the
// keyboard is up. The shift is measured on a fixed element of ours at 0,0.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// The module makes DOMRects: a plain stand-in is enough here.
;(globalThis as unknown as { DOMRect: unknown }).DOMRect ??= class {
  x: number
  y: number
  width: number
  height: number
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x
    this.y = y
    this.width = width
    this.height = height
  }
  get left() { return this.x }
  get top() { return this.y }
  get right() { return this.x + this.width }
  get bottom() { return this.y + this.height }
}

const { besideMenu, fixedShift, setFixedProbe, toFixed } = await import("../src/content/fixedPlace.ts")
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const rect = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h)

test("a still page: rects and fixed coordinates are the same, and the rect comes back as it is", () => {
  setFixedProbe({ isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0 }) })
  const r = rect(112, 682, 498, 120)
  assert.deepEqual(fixedShift(), { dx: 0, dy: 0 })
  assert.equal(toFixed(r), r)
})

test("Safari on a zoomed page: the visible part starts 255 pt down the layout viewport, and the rect moves that far", () => {
  // Our fixed point at 0,0 is 255 pt above the visible part's top: its rect says so.
  setFixedProbe({ isConnected: true, getBoundingClientRect: () => ({ left: -3, top: -255 }) })
  assert.deepEqual(fixedShift(), { dx: 3, dy: 255 })
  const placed = toFixed(rect(112, 682, 498, 120))
  assert.deepEqual([placed.left, placed.top, placed.width, placed.height], [115, 937, 498, 120])
})

test("without the panel's point (not mounted, or gone) nothing moves", () => {
  setFixedProbe(null)
  assert.deepEqual(fixedShift(), { dx: 0, dy: 0 })
  setFixedProbe({ isConnected: false, getBoundingClientRect: () => ({ left: -3, top: -255 }) })
  assert.deepEqual(fixedShift(), { dx: 0, dy: 0 })
})

test("the selection's rect, its ring and the round button's dodge are all in fixed coordinates", () => {
  assert.match(read("../src/content/page.ts"), /rect = toFixed\(box\(\)\)/)
  const app = read("../src/content/App.tsx")
  assert.match(app, /const r = toFixed\(range\.getBoundingClientRect\(\)\)/)
  assert.match(app, /onPlace\?\.\(toFixed\(el\.getBoundingClientRect\(\)\), rect\)/)
  assert.match(app, /fabHome\.current = toFixed\(fab\.getBoundingClientRect\(\)\)/)
  assert.match(app, /<i class="cf-origin" aria-hidden="true" ref=\{setFixedProbe\} \/>/)
  assert.match(read("../src/content/styles.css"), /\.cf-origin \{ position: fixed; left: 0; top: 0; width: 0; height: 0;/)
})

test("no room below or above for the buttons and the system menu: beside the menu on a wide screen, the usual rule elsewhere", () => {
  const word = { left: 320, right: 356, top: 148, bottom: 172 }
  // iPad mini in landscape, the keyboard up: 230 pt of page (86…316), 1133 wide. The menu spans about 78…598.
  const landscape = { left: 0, top: 86, right: 1133, bottom: 316 }
  assert.deepEqual(besideMenu(word, 375, 125, landscape, 88), { left: 606, top: 140 })
  // The selection at the right edge: the menu is pushed left, and the buttons go to its left.
  assert.deepEqual(besideMenu({ left: 1040, right: 1100, top: 148, bottom: 172 }, 375, 125, landscape, 88), { left: 222, top: 140 })
  // Portrait (744 wide) and iPhone (402): no place beside the menu.
  assert.equal(besideMenu(word, 375, 125, { left: 0, top: 86, right: 744, bottom: 316 }, 88), null)
  assert.equal(besideMenu({ left: 100, right: 140, top: 148, bottom: 172 }, 300, 125, { left: 0, top: 60, right: 402, bottom: 300 }, 88), null)
  // Room below (no keyboard): nothing changes.
  assert.equal(besideMenu(word, 375, 125, { left: 0, top: 86, right: 1133, bottom: 744 }, 88), null)
  // A selection that reaches under that place stays uncovered.
  assert.equal(besideMenu({ left: 100, right: 900, top: 148, bottom: 172 }, 375, 125, landscape, 88), null)
  // A zoomed or moved page: the visible part starts elsewhere, and the place moves with it.
  assert.deepEqual(besideMenu({ left: 520, right: 556, top: 448, bottom: 472 }, 375, 125, { left: 200, top: 386, right: 1333, bottom: 616 }, 88), { left: 806, top: 440 })
  const app = read("../src/content/App.tsx")
  assert.match(app, /const side = touch\n\s+\? besideMenu\(rect, el\.offsetWidth, el\.offsetHeight,/)
  assert.match(app, /el\.style\.top = `\$\{side \? side\.top : bubbleTop\(rect, touch, el\.offsetHeight, up\)\}px`/)
})
