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

const { fixedShift, setFixedProbe, toFixed } = await import("../src/content/fixedPlace.ts")
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
