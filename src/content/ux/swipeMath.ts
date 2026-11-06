// The numbers of a swipe (Swipe.tsx), kept apart so they can be tested without a page.

// Safari's Back and Forward from the screen's edge start within ~20 pt of it.
export const EDGE_GUARD = 28
// The move that decides: sideways when it's this far and clearly more sideways than down.
export const DECIDE = 10
// Let go past this share of the row: the action happens; past OPEN_AT: the button stays out to tap.
export const COMMIT_SHARE = 0.42
export const OPEN_AT = 64
export const BUTTON_WIDTH = 76
// Between the colour under the row and the row's edge (2.5 (78), the owner: the colour stood right against the text).
export const GAP = 8
// Two fingers on a trackpad: the gesture is over when wheel events stop coming this long (nothing marks the lift).
export const WHEEL_IDLE = 150
// The row moves this share of the fingers' scroll (2.5 (82), the owner: one to one, it ran far ahead of them).
export const WHEEL_GAIN = 0.5
// One step of the fingers counts this much at most (px, before WHEEL_GAIN): a burst of a quick flick doesn't
// throw the row across (2.5 (83), the owner: "now hyper, now not listening").
export const WHEEL_STEP_MAX = 36
// The fingers lifted: the scroll goes on by itself, each step no bigger than the one before, and the row would drift
// on with it instead of settling. Lifted after LIFT_STEPS such steps in a row under LIFT_SHARE of the gesture's
// fastest step, once that one was LIFT_PEAK at least. Fingers slowing down while they still move don't shrink step
// by step like that. After it, a step bigger than the last one, or back the other way, is the fingers again.
export const LIFT_PEAK = 4
export const LIFT_SHARE = 0.35
export const LIFT_STEPS = 3
// Shorter than this on screen: the icon and its word side by side.
export const SHORT = 52

export interface Sides {
  left: boolean
  right: boolean
}

/**
 * Where the row goes for a finger `mx` from where it started (`base`: 0, or ±BUTTON_WIDTH when a button was out):
 * only the sides with an action, and past three quarters of the row it resists.
 */
export function swipeOffset(base: number, mx: number, width: number, sides: Sides): number {
  let next = base + mx
  if (!sides.left && next < 0) next = 0
  if (!sides.right && next > 0) next = 0
  const limit = width * 0.75
  if (Math.abs(next) > limit) next = Math.sign(next) * (limit + (Math.abs(next) - limit) * 0.25)
  return next
}

/** What letting go at `moved` does: the action on that side, a button left out (-1, 1), or back in place (0). */
export function swipeEnd(moved: number, width: number, sides: Sides): "left" | "right" | -1 | 1 | 0 {
  if (moved <= -width * COMMIT_SHARE && sides.left) return "left"
  if (moved >= width * COMMIT_SHARE && sides.right) return "right"
  if (moved <= -OPEN_AT && sides.left) return -1
  if (moved >= OPEN_AT && sides.right) return 1
  return 0
}

/** The part of a row (`row`, as on screen) that's inside the list (`view`), in the row's own coordinates. */
export function visibleSlice(row: { top: number; bottom: number }, view: { top: number; bottom: number }): { top: number; height: number } {
  const top = Math.max(0, Math.max(row.top, view.top) - row.top)
  const bottom = Math.min(row.bottom, view.bottom) - row.top
  return { top, height: Math.max(0, bottom - top) }
}

/**
 * How wide the colour under the row is when the row has moved `dx`: `edge` is how far the row's card reaches past
 * the row on that side (a message's panel-coloured margin around its text), then a gap.
 */
export function underWidth(dx: number, edge: number): number {
  return Math.max(0, Math.abs(dx) - edge - GAP)
}

/** Where the row stays with its button out: the button's full width shows between the gap and the edge. */
export function openOffset(edge: number): number {
  return BUTTON_WIDTH + edge + GAP
}

/**
 * A trackpad's sideways scroll as a finger's move: the row follows the fingers. Read as a Mac reads them (the
 * deltas the content's way, unless natural scrolling is off), the row went against the fingers on an iPad
 * (2.5 (82), the owner), so they're read the other way round; the swipe runs on iPhone and iPad only.
 */
export function wheelStep(e: { deltaX: number; deltaY: number; deltaMode: number; inverted?: boolean }, width: number): { x: number; y: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? width : 1
  const sign = e.inverted === false ? -1 : 1
  const cap = (v: number) => Math.max(-WHEEL_STEP_MAX, Math.min(WHEEL_STEP_MAX, v))
  return { x: cap(sign * e.deltaX * unit), y: cap(sign * e.deltaY * unit) }
}

export interface Lift {
  peak: number
  slow: number
  // The step before (its size).
  prev: number
}

/** Whether the fingers have lifted, as of this step (px, either way): see LIFT_PEAK. */
export function wheelLifted(lift: Lift, step: number): boolean {
  const s = Math.abs(step)
  lift.peak = Math.max(lift.peak, s)
  const shrinking = s <= lift.prev
  lift.slow = lift.peak >= LIFT_PEAK && s < lift.peak * LIFT_SHARE && shrinking ? lift.slow + 1 : 0
  lift.prev = s
  return lift.slow >= LIFT_STEPS
}

/** After the row settled on a lift (`last`: the step then, signed): whether this step is the fingers moving again. */
export function wheelAgain(last: number, step: number): boolean {
  if (Math.abs(step) > Math.abs(last) + 1) return true
  return Math.abs(step) >= 2 && Math.sign(step) !== Math.sign(last) && last !== 0
}
