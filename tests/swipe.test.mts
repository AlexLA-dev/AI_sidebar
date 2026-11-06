// Swipes on a chat in the list and on a message (2.5 (75), the owner's notes): they followed the finger badly and got
// stuck, since a render in the middle of a swipe re-attached the row's listeners and dropped the gesture; and a long
// answer's icon was off screen. The numbers, then the real Swipe in a DOM, re-rendered mid-swipe. 2.5 (78): two
// fingers on an iPad's trackpad (wheel events) swipe too, and the colour stops a gap short of the row's card.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { fakeClock, fakeTimers } from "./fake-clock.mts"
import { BUTTON_WIDTH, COMMIT_SHARE, GAP, LIFT_STEPS, OPEN_AT, openOffset, swipeEnd, swipeOffset, underWidth, visibleSlice, wheelAgain, WHEEL_GAIN, WHEEL_IDLE, wheelLifted, WHEEL_STEP_MAX, wheelStep } from "../src/content/ux/swipeMath.ts"

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

test("the colour stops a gap short of the card; with the button out, all of the button shows", () => {
  // A chat's row (its card is the row): the gap only.
  assert.equal(underWidth(-140, 0), 140 - GAP)
  assert.equal(underWidth(5, 0), 0)
  // A message: its card reaches 12 px past the text, then the gap.
  assert.equal(underWidth(100, 12), 100 - 12 - GAP)
  assert.equal(underWidth(openOffset(12), 12), BUTTON_WIDTH)
  assert.equal(underWidth(openOffset(0), 0), BUTTON_WIDTH)
})

test("a trackpad's scroll as a finger: the row follows the fingers", () => {
  // 2.5 (82), the owner: read as a Mac reads them, the row went against the fingers on an iPad. Now a deltaX the
  // fingers' way moves the row that way; with natural scrolling reported off, the other way round.
  assert.deepEqual(wheelStep({ deltaX: -12, deltaY: 0, deltaMode: 0, inverted: true }, 300), { x: -12, y: 0 })
  assert.deepEqual(wheelStep({ deltaX: -12, deltaY: 0, deltaMode: 0 }, 300), { x: -12, y: 0 })
  assert.deepEqual(wheelStep({ deltaX: 12, deltaY: 3, deltaMode: 0, inverted: false }, 300), { x: -12, y: -3 })
  // Lines and pages.
  assert.equal(wheelStep({ deltaX: 2, deltaY: 0, deltaMode: 1 }, 300).x, 32)
})

test("the fingers lifted: the scroll only shrinking step by step after them; moving again: a bigger step, or back", () => {
  const lift = { peak: 0, slow: 0, prev: 0 }
  // Small steps at the start (the fingers setting off) and steady ones aren't a lift.
  for (const s of [1, 2, 3, 20, 20, 20]) assert.equal(wheelLifted(lift, s), false)
  // Slowing to aim at a spot, unevenly, then going on: not a lift (2.5 (83): the row stopped listening).
  for (const s of [6, 4, 5, 3, 4, 18]) assert.equal(wheelLifted(lift, s), false)
  // The momentum running out, each step no bigger than the one before: lifted on the LIFT_STEPS-th under the share.
  const tail = [12, 8, 5, 5, 3, 2]
  const at = tail.findIndex((s) => wheelLifted(lift, -s))
  assert.equal(at, 2 + LIFT_STEPS - 1)
  // A slow gesture all the way (never fast): only the events stopping lets it go.
  const slow = { peak: 0, slow: 0, prev: 0 }
  for (const s of [2, 3, 1, 1, 1, 1]) assert.equal(wheelLifted(slow, s), false)
  // After the lift: the scroll running out isn't the fingers; a bigger step or one back the other way is.
  assert.equal(wheelAgain(-3, -2), false)
  assert.equal(wheelAgain(-3, -3), false)
  assert.equal(wheelAgain(-3, -5), true)
  assert.equal(wheelAgain(-3, 2), true, "back the other way")
  assert.equal(wheelAgain(-3, 1), false, "jitter")
})

test("a flick's burst counts as WHEEL_STEP_MAX at most", () => {
  assert.equal(wheelStep({ deltaX: -120, deltaY: 0, deltaMode: 0 }, 300).x, -WHEEL_STEP_MAX)
  assert.equal(wheelStep({ deltaX: 3, deltaY: 0, deltaMode: 1 }, 300).x, WHEEL_STEP_MAX)
})

// ------------------------------------------------------------ the real Swipe, in a DOM

let harness: any
let dom: any
// The component's timers (a trackpad's swipe let go when its events stop, Preact's effects) on a fake clock: a
// test moves it on (`wait`), so a busy machine can't change what the test sees.
const clock = fakeClock()
;(globalThis as any).__swipeClock = clock
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
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname],
    define: fakeTimers("__swipeClock")
  })
  harness = await import(pathToFileURL(out).href)
})

/** The component's time moves on `ms` (the fake clock): its timers due by then fire, in order. */
const wait = (ms: number) => clock.advance(ms)
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
  assert.equal(row.querySelector(".cf-swipe-under.end").style.width, `${140 - GAP}px`)
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
  assert.match(body.style.transform, new RegExp(`translate3d\\(${openOffset(0)}px`))
  assert.equal(row.querySelector(".cf-swipe-under.start").style.width, `${BUTTON_WIDTH}px`)
  // The next swipe starts from the button; the browser takes it for a scroll.
  pointer(text, "pointerdown", 150)
  pointer(text, "pointermove", 130)
  pointer(row, "pointercancel", 130)
  assert.match(body.style.transform, new RegExp(`translate3d\\(${openOffset(0)}px`))
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

/** Two fingers on a trackpad: wheel events (deltaX/deltaY), and whether the row took them from the page. */
const wheel = (el: Element, deltaX: number, deltaY = 0) => {
  const e = new dom.window.Event("wheel", { bubbles: true, cancelable: true })
  let prevented = false
  Object.assign(e, { deltaX, deltaY, deltaMode: 0, ctrlKey: false, preventDefault: () => { prevented = true } })
  el.dispatchEvent(e)
  return prevented
}

test("two fingers on a trackpad swipe as a finger: past the share it deletes, short of it the button stays out", async () => {
  const { row, text, body, calls } = await mounted()
  // Fingers to the left, 20 px a step, the row following at half their pace (WHEEL_GAIN).
  for (let i = 0; i < 4; i++) assert.ok(wheel(text, -20), "a sideways scroll is the row's, not Safari's Back")
  assert.match(body.style.transform, new RegExp(`translate3d\\(${-80 * WHEEL_GAIN}px`))
  assert.ok(row.hasAttribute("data-dragging"))
  for (let i = 0; i < 10; i++) wheel(text, -20)
  // Nothing marks the fingers lifting: the row is let go when the events stop.
  await wait(WHEEL_IDLE + 60)
  assert.deepEqual(calls, ["delete"], `past ${COMMIT_SHARE} of the row`)
  assert.equal(body.style.transform, "")
  assert.ok(!row.hasAttribute("data-dragging"))
  // To the right, short of the share: the pin button stays out, then a tap elsewhere would put it back.
  for (let i = 0; i < 8; i++) wheel(text, 20)
  await wait(WHEEL_IDLE + 60)
  assert.deepEqual(calls, ["delete"])
  assert.match(body.style.transform, new RegExp(`translate3d\\(${openOffset(0)}px`))
  // Scrolling the list puts it back.
  dom.document.querySelector(".cf-messages").dispatchEvent(new dom.window.Event("scroll"))
  assert.equal(body.style.transform, "")
})

test("a trackpad's vertical scroll stays the list's, to its end, even if it drifts sideways", async () => {
  const { text, body, calls } = await mounted()
  assert.equal(wheel(text, 0, 30), false, "not taken from the list")
  // The same gesture drifting sideways later on: still the list's.
  wheel(text, -15, 2)
  wheel(text, -25, 0)
  assert.ok(!body.style.transform, "the row didn't move")
  await wait(WHEEL_IDLE + 60)
  // A new gesture, sideways: the row's.
  for (let i = 0; i < 3; i++) wheel(text, -20)
  assert.match(body.style.transform, new RegExp(`translate3d\\(${-60 * WHEEL_GAIN}px`))
  await wait(WHEEL_IDLE + 60)
  assert.deepEqual(calls, [])
})

test("the fingers lift mid-swipe: the row settles on its button at once, and the scroll left after them is swallowed", async () => {
  const { row, text, body, calls } = await mounted()
  // Fast to the left (2.5 (82), the owner: the row drifted on with the scroll after the fingers and never settled).
  for (let i = 0; i < 5; i++) wheel(text, -30)
  for (const s of [-20, -12, -8, -5]) wheel(text, s)
  assert.ok(row.hasAttribute("data-dragging"), "still the fingers")
  wheel(text, -3)
  // Lifted: the delete button out, no waiting for the scroll to run out.
  assert.ok(!row.hasAttribute("data-dragging"))
  assert.match(body.style.transform, new RegExp(`translate3d\\(${-openOffset(0)}px`))
  for (const s of [-2, -2, -1, -1]) assert.ok(wheel(text, s), "the rest of the scroll isn't Safari's Back")
  assert.match(body.style.transform, new RegExp(`translate3d\\(${-openOffset(0)}px`), "and doesn't move the row")
  await wait(WHEEL_IDLE + 60)
  assert.deepEqual(calls, [])
  assert.match(body.style.transform, new RegExp(`translate3d\\(${-openOffset(0)}px`))
  // A short flick to the right from there: back in place.
  for (const s of [10, 25, 25, 12, 6, 3, 2]) wheel(text, s)
  assert.equal(body.style.transform, "")
  await wait(WHEEL_IDLE + 60)
  assert.deepEqual(calls, [])
})

test("a message's card: the colour starts past its margin and the gap; the button out shows whole", async () => {
  const { row, text, body } = await mounted()
  // The body reaches 12 px past the text on each side (ux.css, .cf-msg > .cf-swipe.on > .cf-swipe-body).
  Object.defineProperty(body, "offsetLeft", { value: -12, configurable: true })
  pointer(text, "pointerdown", 100)
  pointer(text, "pointermove", 120)
  pointer(row, "pointermove", 200)
  assert.equal(row.querySelector(".cf-swipe-under.start").style.width, `${100 - 12 - GAP}px`)
  pointer(row, "pointerup", 200)
  assert.match(body.style.transform, new RegExp(`translate3d\\(${openOffset(12)}px`))
  assert.equal(row.querySelector(".cf-swipe-under.start").style.width, `${BUTTON_WIDTH}px`)
})

test("the styles: the colour as tall as the row, rounded; a message's card; a moved row never scrolls the list sideways", () => {
  const css = readFileSync(new URL("../src/content/ux/ux.css", import.meta.url), "utf8")
  assert.match(css, /\.cf-swipe-under \{[^}]*top: 0; bottom: 0;[^}]*border-radius: 14px;/)
  assert.match(css, /\.cf-msg > \.cf-swipe\.on > \.cf-swipe-body \{ margin: 0 -12px; padding: 0 12px;/)
  assert.match(css, /\.cf-swipe > \.cf-swipe-body \{[^}]*background: var\(--bg\);/)
  assert.match(css, /\.cf-messages, \.cf-threads \{ overflow-x: hidden; \}/)
  // A moved chat: its row's highlight (the current chat) doesn't show in the gap.
  assert.match(css, /\.cf-thread:has\(\.cf-swipe\[data-moved\]\) \{ background: var\(--bg\); \}/)
})
