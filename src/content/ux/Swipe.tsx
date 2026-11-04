// Swipe a row (an answer, a note, a chat in the list) left to delete it and right to pin it, as in Mail
// and Messages on iPhone. Touch only: on a Mac the same actions are buttons on hover and in the menu.
//
// What the swipe leaves alone:
// - a touch that starts near the screen's edge: that's Safari's own Back and Forward;
// - a touch on something that scrolls sideways (code, tables) or a control;
// - a mostly vertical move: the list scrolls as usual (`touch-action: pan-y` keeps vertical scrolling
//   with the browser and gives us the sideways moves);
// - a touch while text is selected in the panel (the user is adjusting the selection).

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { onTapAway } from "./away"

// Safari's Back and Forward from the screen's edge start within ~20 pt of it.
export const EDGE_GUARD = 28
// The move that decides: sideways when it's this far and clearly more sideways than down.
const DECIDE = 10
// Let go past this share of the row: the action happens; past OPEN_AT: the button stays out to tap.
const COMMIT_SHARE = 0.42
const OPEN_AT = 64
const BUTTON_WIDTH = 76

export interface SwipeAction {
  label: string
  icon: VNode
  tone: "delete" | "pin"
  run: () => void
}

/** Whether `target` is inside something that scrolls sideways, or a control the touch belongs to. */
export function ownsSideways(target: Element | null, stop: Element | null): boolean {
  for (let el = target; el && el !== stop; el = el.parentElement) {
    if (el.matches("input, textarea, select, button, a, [contenteditable], [data-no-swipe]")) return true
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX
      if (overflow === "auto" || overflow === "scroll") return true
    }
  }
  return false
}

export function Swipe({ left, right, enabled = true, children, class: cls = "" }: {
  // Swiping left shows `left` (delete) on the right edge; swiping right shows `right` (pin) on the left.
  left?: SwipeAction
  right?: SwipeAction
  enabled?: boolean
  children: ComponentChildren
  class?: string
}): VNode {
  const rowRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Revealed and left open: -1 the delete button, 1 the pin button.
  const [open, setOpen] = useState<-1 | 0 | 1>(0)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const row = rowRef.current
    if (!row || !enabled) return
    let start: { x: number; y: number; id: number; base: number } | null = null
    let decided: "x" | "y" | null = null
    let moved = 0

    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || start) return
      const width = window.visualViewport?.width ?? window.innerWidth
      if (e.clientX < EDGE_GUARD || e.clientX > width - EDGE_GUARD) return
      if (ownsSideways(e.target as Element, row)) return
      const sel = document.getSelection()
      if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, base: open === -1 ? -BUTTON_WIDTH : open === 1 ? BUTTON_WIDTH : 0 }
      decided = null
      moved = start.base
    }
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const mx = e.clientX - start.x
      const my = e.clientY - start.y
      if (!decided) {
        if (Math.abs(my) > DECIDE && Math.abs(my) >= Math.abs(mx)) {
          start = null
          return
        }
        if (Math.abs(mx) < DECIDE || Math.abs(mx) < Math.abs(my) * 1.5) return
        decided = "x"
        setDragging(true)
        try { row.setPointerCapture(e.pointerId) } catch { /* the pointer is gone */ }
      }
      let next = start.base + mx
      // Only the sides that have an action; past the row's width it resists.
      if (!left && next < 0) next = 0
      if (!right && next > 0) next = 0
      const limit = row.clientWidth
      if (Math.abs(next) > limit * 0.75) next = Math.sign(next) * (limit * 0.75 + (Math.abs(next) - limit * 0.75) * 0.25)
      moved = next
      setDx(next)
    }
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const wasSwipe = decided === "x"
      start = null
      decided = null
      setDragging(false)
      if (!wasSwipe) return
      const width = row.clientWidth
      if (moved <= -width * COMMIT_SHARE && left) {
        setDx(0)
        setOpen(0)
        left.run()
      } else if (moved >= width * COMMIT_SHARE && right) {
        setDx(0)
        setOpen(0)
        right.run()
      } else if (moved <= -OPEN_AT && left) {
        setOpen(-1)
        setDx(-BUTTON_WIDTH)
      } else if (moved >= OPEN_AT && right) {
        setOpen(1)
        setDx(BUTTON_WIDTH)
      } else {
        setOpen(0)
        setDx(0)
      }
    }
    const cancel = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      start = null
      decided = null
      setDragging(false)
      setDx(open === -1 ? -BUTTON_WIDTH : open === 1 ? BUTTON_WIDTH : 0)
    }
    row.addEventListener("pointerdown", down)
    row.addEventListener("pointermove", move)
    row.addEventListener("pointerup", up)
    row.addEventListener("pointercancel", cancel)
    return () => {
      row.removeEventListener("pointerdown", down)
      row.removeEventListener("pointermove", move)
      row.removeEventListener("pointerup", up)
      row.removeEventListener("pointercancel", cancel)
    }
  }, [enabled, left, right, open])

  // A tap elsewhere, or scrolling the list, closes a revealed button.
  useEffect(() => {
    if (!open) return
    const row = rowRef.current
    if (!row) return
    const scroller = row.closest(".cf-messages, .cf-threads, .cf-list")
    const shut = () => {
      setOpen(0)
      setDx(0)
    }
    const off = onTapAway(row, (path) => path.includes(row), shut)
    scroller?.addEventListener("scroll", shut, { passive: true })
    return () => {
      off()
      scroller?.removeEventListener("scroll", shut)
    }
  }, [open])

  const side = dx < 0 ? left : dx > 0 ? right : null
  const full = rowRef.current ? Math.abs(dx) >= rowRef.current.clientWidth * COMMIT_SHARE : false
  return (
    <div ref={rowRef} class={`cf-swipe ${cls} ${dragging ? "dragging" : ""} ${dx ? "moved" : ""}`}>
      {side && (
        <div class={`cf-swipe-under ${side.tone} ${dx < 0 ? "end" : "start"} ${full ? "full" : ""}`} style={{ width: `${Math.abs(dx)}px` }}>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => {
              setOpen(0)
              setDx(0)
              side.run()
            }}
          >
            {side.icon}
            <span>{side.label}</span>
          </button>
        </div>
      )}
      <div ref={bodyRef} class="cf-swipe-body" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        {children}
      </div>
    </div>
  )
}
