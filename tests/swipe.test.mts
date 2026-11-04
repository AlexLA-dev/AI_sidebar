// Swipes on a chat in the list and on a message (2.5 (75), the owner's notes): they followed the finger badly and got
// stuck, since a render in the middle of a swipe re-attached the row's listeners and dropped the gesture; and a long
// answer's icon was off screen. The numbers, then the real Swipe in a DOM, re-rendered mid-swipe.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { BUTTON_WIDTH, COMMIT_SHARE, OPEN_AT, swipeEnd, swipeOffset, visibleSlice } from "../src/content/ux/swipeMath.ts"

const both = { left: true, right: true }

test("the row follows the finger only to the sides with an action, and resists past three quarters", () => {
  assert.equal(swipeOffset(0, -40, 300, both), -40)
  assert.equal(swipeOffset(0, 40, 300, { left: true, right: false }), 0)
  assert.equal(swipeOffset(-BUTTON_WIDTH, 30, 300, both), -BUTTON_WIDTH + 30)
  assert.equal(swipeOffset(0, -325, 300, both), -(225 + 100 * 0.25))
})

test("letting go: the action past the share, the button past OPEN_AT, else back", () => {
  assert.equal(swipeEnd(-300 * COMMIT_SHARE, 300, both), "left")
  assert.equal(swipeEnd(300 * COMMIT_SHARE, 300, both), "right")
  assert.equal(swipeEnd(-OPEN_AT, 300, both), -1)
  assert.equal(swipeEnd(OPEN_AT, 300, both), 1)
  assert.equal(swipeEnd(OPEN_AT - 1, 300, both), 0)
  assert.equal(swipeEnd(-300, 300, { left: false, right: true }), 0)
})

test("the icon goes where the row is on screen: a long answer's middle can be above or below it", () => {
  // An answer from 500 above the list's top to 300 below its bottom: the icon in the list's 600.
  assert.deepEqual(visibleSlice({ top: -500, bottom: 900 }, { top: 0, bottom: 600 }), { top: 500, height: 600 })
  // A row inside the list: all of it.
  assert.deepEqual(visibleSlice({ top: 100, bottom: 160 }, { top: 0, bottom: 600 }), { top: 0, height: 60 })
  // A row starting below the list's top, running off its bottom.
  assert.deepEqual(visibleSlice({ top: 400, bottom: 1400 }, { top: 0, bottom: 600 }), { top: 0, height: 200 })
})

// ------------------------------------------------------------ the real Swipe, in a DOM

let harness: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div class=\"cf-messages\"><div id=\"root\"></div></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, ShadowRoot: dom.window.ShadowRoot, Node: dom.window.Node, Element: dom.window.Element })
  dom.window.innerWidth = 375
  dom.document.getSelection = () => null
  const dir = mkdtempSync(join(tmpdir(), "cf-swipe-"))
  const swipe = new URL("../src/content/ux/Swipe.tsx", import.meta.url).pathname
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { useState } from "preact/hooks"
    import { Swipe } from ${JSON.stringify(swipe)}
    export function mount(container: Element, calls: string[]) {
      let bump = () => {}
      function Parent() {
        const [n, setN] = useState(0)
        bump = () => setN((x) => x + 1)
        // New action objects on every render, as the chat list and the chat pass them.
        return h(Swipe, {
          left: { label: "Delete", icon: h("i", null), tone: "delete", run: () => calls.push("delete") },
          right: { label: "Pin", icon: h("i", null), tone: "pin", run: () => calls.push("pin") }
        }, h("p", { class: "text" }, "An answer, render " + n))
      }
      render(h(Parent, null), container)
      return { bump: () => bump() }
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname]
  })
  harness = await import(pathToFileURL(out).href)
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pointer = (el: Element, type: string, x: number, y = 50) => {
  const e = new dom.window.Event(type, { bubbles: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, pointerType: "touch" })
  el.dispatchEvent(e)
}

async function mounted() {
  const root = dom.document.getElementById("root")
  root.innerHTML = ""
  const calls: string[] = []
  const app = harness.mount(root, calls)
  await wait(150) // the effects (Preact runs them after a frame; here, a timeout)
  const row = root.querySelector(".cf-swipe")
  Object.defineProperty(row, "clientWidth", { value: 300, configurable: true })
  row.getBoundingClientRect = () => ({ top: -500, bottom: 900, left: 0, right: 300, width: 300, height: 1400 })
  dom.document.querySelector(".cf-messages").getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 300, width: 300, height: 600 })
  return { row, text: root.querySelector(".text"), body: root.querySelector(".cf-swipe-body"), calls, app }
}

test("a render in the middle of a swipe doesn't drop it: letting go past the share still deletes", async () => {
  const { row, text, body, calls, app } = await mounted()
  pointer(text, "pointerdown", 200)
  pointer(text, "pointermove", 180)
  app.bump()
  await wait(150) // long enough for any effect to run again
  pointer(row, "pointermove", 60)
  assert.match(body.style.transform, /translate3d\(-140px/)
  assert.equal(row.querySelector(".cf-swipe-under.end").style.width, "140px")
  assert.ok(row.hasAttribute("data-dragging"))
  pointer(row, "pointerup", 60)
  assert.deepEqual(calls, ["delete"])
  assert.equal(body.style.transform, "")
  assert.ok(!row.hasAttribute("data-dragging"))
})

test("taking the touch from the text under the finger (iOS: a lostpointercapture bubbling up) doesn't end the swipe", async () => {
  // On iPhone the swipe stopped dead: the text's lost capture, bubbling to the row, was taken for the row's.
  const { row, text, body, calls } = await mounted()
  pointer(text, "pointerdown", 200)
  pointer(text, "pointermove", 180)
  pointer(text, "lostpointercapture", 180)
  pointer(row, "pointermove", 100)
  assert.match(body.style.transform, /translate3d\(-100px/)
  // The row's own capture lost (the page took the touch): back in place.
  pointer(row, "lostpointercapture", 100)
  assert.equal(body.style.transform, "")
  assert.deepEqual(calls, [])
})

test("a short swipe leaves the button out; a scroll taking the touch puts the row back, never half-way", async () => {
  const { row, text, body, calls, app } = await mounted()
  pointer(text, "pointerdown", 100)
  pointer(text, "pointermove", 120)
  pointer(row, "pointermove", 190)
  app.bump()
  await wait(150)
  pointer(row, "pointerup", 190)
  assert.deepEqual(calls, [])
  assert.match(body.style.transform, new RegExp(`translate3d\\(${BUTTON_WIDTH}px`))
  // The next swipe starts from the button; the browser takes it for a scroll.
  pointer(text, "pointerdown", 150)
  pointer(text, "pointermove", 130)
  pointer(row, "pointercancel", 130)
  assert.match(body.style.transform, new RegExp(`translate3d\\(${BUTTON_WIDTH}px`))
  assert.ok(!row.hasAttribute("data-dragging"))
})

test("the icon of a long answer sits in the part on screen", async () => {
  const { row, text } = await mounted()
  pointer(text, "pointerdown", 200)
  pointer(text, "pointermove", 150)
  const button = row.querySelector(".cf-swipe-under.end button")
  assert.equal(button.style.top, "500px")
  assert.equal(button.style.height, "600px")
  pointer(row, "pointercancel", 150)
})

test("the styles: the colour as tall as the row, and a moved row never scrolls the list sideways", () => {
  const css = readFileSync(new URL("../src/content/ux/ux.css", import.meta.url), "utf8")
  assert.match(css, /\.cf-swipe-under \{[^}]*top: 0; bottom: 0;/)
  assert.match(css, /\.cf-messages, \.cf-threads \{ overflow-x: hidden; \}/)
})
