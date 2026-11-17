// A selection made by one tap in a field (2.7 (107), C2, the owner on an iPad mini: «тап по слову… выделяет слово, и
// сверху системное меню и наша панель»). iPadOS selects a word it marks as misspelled on a single tap, to offer its
// replacement; an iPhone leaves the caret there. Someone tapping such a word wants iOS's replacement, not Ask AI, so the
// selection's buttons skip a selection that comes right after one short tap inside an editable field. One made on
// purpose still gets them: a double tap, a long press, the handles dragged, Select All from the menu (each comes later
// than a tap's moment, or isn't one tap). Text on the page, an iPhone's selections and a pointer's are untouched.

import { listenAround } from "./around.ts"

// A tap: the finger up this soon after it went down, not dragged further than TAP_SLOP.
export const TAP_MS = 350
export const TAP_SLOP = 12
// A second tap this soon after the first one, near it: a double tap.
export const TWO_TAPS_MS = 450
// A selection this soon after a tap ended is the tap's own.
export const AFTER_TAP_MS = 700

export interface Press {
  downAt: number
  x: number
  y: number
  upAt: number | null
  // Dragged past TAP_SLOP, or taken by the system (a long press, a scroll).
  moved: boolean
  // 1 for a single tap, 2 for the second of a double tap, and so on.
  count: number
  inField: boolean
}

/** A finger down: a new press, counted on from the one before when that was a tap just now and near. */
export function pressDown(prev: Press | null, at: number, x: number, y: number, inField: boolean): Press {
  const again =
    prev !== null && prev.upAt !== null && !prev.moved && prev.upAt - prev.downAt <= TAP_MS &&
    at - prev.upAt <= TWO_TAPS_MS && Math.hypot(x - prev.x, y - prev.y) <= TAP_SLOP * 3
  return { downAt: at, x, y, upAt: null, moved: false, count: again ? prev.count + 1 : 1, inField }
}

/** Whether a selection showing up at `now` was made by one short tap in a field (`press` the latest finger down). */
export function byOneTap(press: Press | null, now: number): boolean {
  if (!press || !press.inField || press.moved || press.count !== 1) return false
  // The selection may come before the finger is up, at a tap's pace.
  if (press.upAt === null) return now - press.downAt <= TAP_MS
  return press.upAt - press.downAt <= TAP_MS && now - press.upAt <= AFTER_TAP_MS
}

/** An editable field on the event's path: a text input, a textarea or editable content. */
function fieldOnPath(path: EventTarget[]): boolean {
  for (const n of path) {
    if (!(n instanceof HTMLElement)) continue
    if (n.isContentEditable || n.tagName === "TEXTAREA") return true
    if (n.tagName === "INPUT") return true
  }
  return false
}

let press: Press | null = null

/** Follows the finger's presses on the page (touch and pen only; a pointer's selections are left as they are). */
export function trackPresses(doc: Document = document): () => void {
  const stops = [
    listenAround(doc, "pointerdown", (e, path) => {
      if (e.pointerType === "mouse") {
        press = null
        return
      }
      press = pressDown(press, e.timeStamp, e.clientX, e.clientY, fieldOnPath(path))
    }, doc),
    listenAround(doc, "pointermove", (e) => {
      if (press && press.upAt === null && e.pointerType !== "mouse" && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) press.moved = true
    }, doc),
    listenAround(doc, "pointerup", (e) => {
      if (press && press.upAt === null && e.pointerType !== "mouse") press.upAt = e.timeStamp
    }, doc),
    listenAround(doc, "pointercancel", () => {
      if (press && press.upAt === null) press.moved = true
    }, doc)
  ]
  return () => stops.forEach((stop) => stop())
}

/** Whether the selection showing up now came from one tap in a field (event time: performance.now()). */
export function selectionByOneTap(): boolean {
  return byOneTap(press, performance.now())
}
