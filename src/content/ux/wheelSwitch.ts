// Two fingers on a trackpad over the send button (2.7.1, the owner on build 121, iPad with a Magic Keyboard: «Свайп
// на тачпаде не работает вверх, как для заметок, чтобы включить Do»). A finger's swipe on the button is up for a
// note and down for Do (touch); a trackpad (or a mouse wheel) gives wheel events instead, which only ever flipped the
// note. Now they read the fingers' way as the touch swipe does: up = Note, down = Do, once per gesture.
//
// A gesture: wheel events with no gap over WHEEL_IDLE between them (nothing marks the lift). It switches once its
// travel along y passes SWITCH_AT (and is more up/down than sideways). After that the rest of it is ignored: the
// fingers still moving, then the scroll that goes on by itself after they lift (momentum), each step no bigger than
// the one before (wheelLifted). Only a gap, or the fingers moving again after the lift (wheelAgain), starts the next.

import { type Lift, wheelAgain, WHEEL_IDLE, wheelLifted, wheelStep } from "./swipeMath.ts"

// The travel (px, the fingers' way) that switches: small, so a short flick does it; two notches of a mouse wheel.
export const SWITCH_AT = 8
// Never two switches closer than this (ms), whatever the deltas look like.
export const SWITCH_GAP = 300

export type WheelDir = "up" | "down"

export interface WheelSwitch {
  // When the last wheel event came (ms).
  at: number
  // This gesture's travel so far, the fingers' way (y down is +).
  x: number
  y: number
  // "track": adding up; "done": switched (or sideways), the fingers still on; "coast": lifted, the scroll going on.
  phase: "track" | "done" | "coast"
  lift: Lift
  // In "coast": the last step (signed), to tell the fingers moving again.
  last: number
  // When it last switched (ms).
  switchedAt: number
}

export function wheelSwitch(): WheelSwitch {
  return { at: -Infinity, x: 0, y: 0, phase: "track", lift: { peak: 0, slow: 0, prev: 0 }, last: 0, switchedAt: -Infinity }
}

export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  // Safari's webkitDirectionInvertedFromDevice (true with natural scrolling); undefined elsewhere.
  inverted?: boolean
  // ms (the event's timeStamp or Date.now()).
  at: number
}

/**
 * One wheel event's move, the fingers' way (y down is +). On iPhone and iPad as the chat rows read it (swipeMath
 * wheelStep, checked by the owner on an iPad in 2.5 (82)); a Mac's deltas go the content's way with natural scrolling
 * (Safari says so: webkitDirectionInvertedFromDevice), so its fingers are the other way round, unless that's off.
 */
export function fingers(e: Omit<WheelInput, "at">, mac: boolean): { x: number; y: number } {
  const step = wheelStep({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, inverted: e.inverted }, 32)
  if (!mac) return step
  const sign = e.inverted === false ? 1 : -1
  return { x: sign * e.deltaX * (e.deltaMode === 1 ? 16 : 1), y: sign * e.deltaY * (e.deltaMode === 1 ? 16 : 1) }
}

/** Feeds one wheel event in; returns the switch it makes ("up" for the note, "down" for Do), or null. */
export function wheelSwitchStep(s: WheelSwitch, e: WheelInput, mac: boolean): WheelDir | null {
  const step = fingers(e, mac)
  const fresh = e.at - s.at > WHEEL_IDLE
  s.at = e.at
  if (fresh) restart(s)
  const along = Math.abs(step.y) >= Math.abs(step.x) ? step.y : 0
  if (s.phase === "done") {
    // Still the same fingers, until they lift.
    if (wheelLifted(s.lift, along || step.x)) {
      s.phase = "coast"
      s.last = along
    }
    return null
  }
  if (s.phase === "coast") {
    if (!wheelAgain(s.last, along)) {
      if (along) s.last = along
      return null
    }
    // The fingers again, during the glide: a new gesture from this step.
    restart(s)
  }
  s.x += step.x
  s.y += step.y
  if (Math.abs(s.x) >= SWITCH_AT && Math.abs(s.x) > Math.abs(s.y)) {
    // Sideways: not a switch; the rest of this gesture is let be.
    s.phase = "done"
    return null
  }
  if (Math.abs(s.y) < SWITCH_AT) return null
  s.phase = "done"
  wheelLifted(s.lift, along)
  if (e.at - s.switchedAt < SWITCH_GAP) return null
  s.switchedAt = e.at
  return s.y < 0 ? "up" : "down"
}

function restart(s: WheelSwitch): void {
  s.x = 0
  s.y = 0
  s.phase = "track"
  s.lift = { peak: 0, slow: 0, prev: 0 }
  s.last = 0
}
