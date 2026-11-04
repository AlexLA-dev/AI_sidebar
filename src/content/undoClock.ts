/**
 * How long the "… · Undo" bars stay (UndoBar.tsx; the app's ChatsView keeps the same numbers, UndoClock in
 * OrganizeViews.swift).
 *
 * After a delete, the bar stays its 8 s whatever the person does next with the chat (2.5: a scroll used to take the
 * Undo away). The bar after a move ("Moved to “Trips” · Undo · Open") is shorter. The chat stays open, and people
 * read on. It also goes once the person goes on with the chat: a scroll, a swipe (a question or a note takes either
 * bar at once). That only counts after its first 2 s, so the Undo is never gone before there was time to tap it.
 * A pointer resting on a bar holds it there; it goes a moment after the pointer leaves.
 */
export const UNDO_BAR_MS = 8_000
export const MOVE_BAR_MS = 5_000
export const MOVE_BAR_GRACE_MS = 2_000
export const BAR_AFTER_HOLD_MS = 1_500

export type BarKind = "undo" | "move"

/** When a bar shown at `shownAt` goes by itself. */
export function barDeadline(kind: BarKind, shownAt: number): number {
  return shownAt + (kind === "move" ? MOVE_BAR_MS : UNDO_BAR_MS)
}

/** The pointer left the bar at `now`: when it goes now (never sooner than it would have). */
export function deadlineAfterHold(deadline: number, now: number): number {
  return Math.max(deadline, now + BAR_AFTER_HOLD_MS)
}

/** The person went on with the chat at `now` (a scroll, a swipe): does the bar go? */
export function goesOnWork(kind: BarKind, shownAt: number, now: number): boolean {
  return kind === "move" && now - shownAt >= MOVE_BAR_GRACE_MS
}
