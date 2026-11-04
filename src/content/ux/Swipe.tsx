// Swipe a row (an answer, a note, a chat in the list) left to delete it and right to pin it, as in Mail
// and Messages on iPhone. Touch only: on a Mac the same actions are buttons on hover and in the menu.
//
// What the swipe leaves alone:
// - a touch that starts near the screen's edge: that's Safari's own Back and Forward;
// - a touch on something that scrolls sideways (code, tables) or a control;
// - a mostly vertical move: the list scrolls as usual (`touch-action: pan-y` keeps vertical scrolling
//   with the browser and gives us the sideways moves);
// - a touch while text is selected in the panel (the user is adjusting the selection).
//
// 2.5 (75), the owner's notes: the row follows the finger without re-rendering (the gesture lives in this
// closure and moves the row's style directly), so a render in the middle of a swipe can't drop it and leave the
// row stuck half-way; the icon sits in the part of the row on screen (a long answer's middle can be off it).

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useRef } from "preact/hooks"

import { listenAround } from "../around"
import { BUTTON_WIDTH, COMMIT_SHARE, DECIDE, EDGE_GUARD, SHORT, swipeEnd, swipeOffset, visibleSlice } from "./swipeMath"

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
  const startRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // The actions as of the last render, read when the gesture ends (the row may re-render meanwhile).
  const actions = useRef({ left, right })
  actions.current = { left, right }
  // Puts the row back in place (a button tapped).
  const shut = useRef<() => void>(() => {})

  useEffect(() => {
    const row = rowRef.current
    if (!row || !enabled) return
    let start: { x: number; y: number; id: number; base: number } | null = null
    let decided = false
    // Where the row is (px), and the button left out: -1 delete, 1 pin.
    let at = 0
    let open: -1 | 0 | 1 = 0
    let stopAround: (() => void) | null = null
    const scroller = () => row.closest<HTMLElement>(".cf-messages, .cf-threads, .cf-list")
    const sides = () => ({ left: Boolean(actions.current.left), right: Boolean(actions.current.right) })

    const place = (dx: number) => {
      at = dx
      const body = bodyRef.current
      if (body) body.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : ""
      const under = dx < 0 ? endRef.current : dx > 0 ? startRef.current : null
      for (const u of [startRef.current, endRef.current]) {
        if (!u) continue
        u.style.width = u === under ? `${Math.abs(dx)}px` : "0px"
        u.toggleAttribute("data-full", u === under && Math.abs(dx) >= row.clientWidth * COMMIT_SHARE)
      }
      row.toggleAttribute("data-moved", dx !== 0)
    }
    // The icon where the row is on screen: a long answer's middle may be above or below it.
    const fit = () => {
      const view = scroller()?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
      const slice = visibleSlice(row.getBoundingClientRect(), view)
      for (const u of [startRef.current, endRef.current]) {
        const button = u?.firstElementChild as HTMLElement | null
        if (!button) continue
        button.style.top = `${slice.top}px`
        button.style.height = `${slice.height}px`
      }
      row.toggleAttribute("data-short", slice.height < SHORT)
    }
    const onScroll = () => setOpen(0)
    const setOpen = (side: -1 | 0 | 1) => {
      open = side
      place(side * BUTTON_WIDTH)
      stopAround?.()
      stopAround = null
      scroller()?.removeEventListener("scroll", onScroll)
      if (!side) return
      // A tap elsewhere, or scrolling the list, puts it back.
      stopAround = listenAround(row, "pointerdown", (_, path) => {
        if (!path.includes(row)) setOpen(0)
      })
      scroller()?.addEventListener("scroll", onScroll, { passive: true })
    }
    shut.current = () => setOpen(0)

    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || start) return
      const width = window.visualViewport?.width ?? window.innerWidth
      if (e.clientX < EDGE_GUARD || e.clientX > width - EDGE_GUARD) return
      if (ownsSideways(e.target as Element, row)) return
      const sel = document.getSelection()
      if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, base: open * BUTTON_WIDTH }
      decided = false
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
        decided = true
        fit()
        row.setAttribute("data-dragging", "")
        try { row.setPointerCapture(e.pointerId) } catch { /* the pointer is gone */ }
      }
      place(swipeOffset(start.base, mx, row.clientWidth, sides()))
    }
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!start || e.pointerId !== start.id) return
      const wasSwipe = decided
      start = null
      decided = false
      row.removeAttribute("data-dragging")
      if (!wasSwipe) return
      if (cancelled) {
        setOpen(open)
        return
      }
      const outcome = swipeEnd(at, row.clientWidth, sides())
      if (outcome === "left" || outcome === "right") {
        setOpen(0)
        actions.current[outcome]?.run()
      } else {
        setOpen(outcome)
      }
    }
    const up = (e: PointerEvent) => end(e, false)
    const cancel = (e: PointerEvent) => end(e, true)
    // Only the row's own capture: taking it from the text under the finger (a touch's implicit capture) fires a
    // lostpointercapture there that bubbles up here, and that one is the swipe starting, not ending.
    const lost = (e: PointerEvent) => {
      if (e.target === row) end(e, true)
    }
    row.addEventListener("pointerdown", down)
    row.addEventListener("pointermove", move)
    row.addEventListener("pointerup", up)
    row.addEventListener("pointercancel", cancel)
    // The capture lost without an up or a cancel (the row re-mounted, the page took the touch): as a cancel.
    row.addEventListener("lostpointercapture", lost)
    return () => {
      row.removeEventListener("pointerdown", down)
      row.removeEventListener("pointermove", move)
      row.removeEventListener("pointerup", up)
      row.removeEventListener("pointercancel", cancel)
      row.removeEventListener("lostpointercapture", lost)
      stopAround?.()
      scroller()?.removeEventListener("scroll", onScroll)
      row.removeAttribute("data-dragging")
      place(0)
      shut.current = () => {}
    }
  }, [enabled])

  const under = (action: SwipeAction, edge: "start" | "end", ref: typeof startRef) => (
    <div ref={ref} class={`cf-swipe-under ${action.tone} ${edge}`}>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          shut.current()
          ;(edge === "end" ? actions.current.left : actions.current.right)?.run()
        }}
      >
        {action.icon}
        <span>{action.label}</span>
      </button>
    </div>
  )
  return (
    <div ref={rowRef} class={`cf-swipe ${cls}`}>
      {enabled && right && under(right, "start", startRef)}
      {enabled && left && under(left, "end", endRef)}
      <div ref={bodyRef} class="cf-swipe-body">
        {children}
      </div>
    </div>
  )
}
