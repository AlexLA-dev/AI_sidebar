// Dragging the ✦ circle and the panel to either side (2.7, plan section 9). The circle follows the finger or the cursor
// in any direction and, let go, glides to the nearer edge at that height. On iPad and Mac the panel is dragged by its
// header the same way. A glow shows on the edge it will land on while dragging. The two share one side (the circle's
// setting): move one, and the other opens on the same side.
//
// Both move their element's style directly while dragged (the panel is a big tree: a render for every pointer move
// would stutter); the app renders only when the drag starts, when the edge it would land on changes, and when it ends.

import { useEffect, useLayoutEffect, useRef, useState, type MutableRef } from "preact/hooks"

import { fabLeftAt, fabLeftFor, HEADER_CONTROLS, heightPercent, isDrag, nearestSide, panelSideFor, type Side } from "./snap"

const SETTLE_MS = 260

interface FabDragOptions {
  fab: MutableRef<HTMLElement | null>
  // Let go after a drag: the side and the height (% of the screen) it lands at.
  onDrop: (side: Side, heightPct: number) => void
  // A press without a drag.
  onTap: () => void
  // The circle held down without moving (build 107): the page's translation by hand, on any page.
  onHold?: () => void
}

/** How long the circle is held, still, before it counts as a hold and not a tap. */
export const HOLD_MS = 550

export interface DragState {
  // The edge the circle or the panel would land on now, while dragged; null otherwise.
  glow: Side | null
  dragging: boolean
}

/** The circle: pointer handlers for it, and what's being dragged. */
export function useFabDrag({ fab, onDrop, onTap, onHold }: FabDragOptions) {
  const [state, setState] = useState<DragState>({ glow: null, dragging: false })
  const press = useRef<{ x: number; y: number; moved: boolean; held: boolean; glow: Side | null } | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdRef = useRef(onHold)
  holdRef.current = onHold
  const noHold = () => {
    if (hold.current) clearTimeout(hold.current)
    hold.current = null
  }
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current)
    noHold()
  }, [])

  const clearInline = (el: HTMLElement) => {
    for (const p of ["left", "right", "transition"]) el.style.removeProperty(p)
  }

  return {
    state,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        const p = { x: e.clientX, y: e.clientY, moved: false, held: false, glow: null as Side | null }
        press.current = p
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        noHold()
        if (holdRef.current) {
          hold.current = setTimeout(() => {
            hold.current = null
            // Still down and still in place: a hold. Letting go then isn't a tap.
            if (press.current !== p || p.moved) return
            p.held = true
            holdRef.current?.()
          }, HOLD_MS)
        }
      },
      onPointerMove: (e: PointerEvent) => {
        const p = press.current
        const el = fab.current
        if (!p || !el) return
        if (!p.moved && !isDrag(e.clientX - p.x, e.clientY - p.y)) return
        e.preventDefault()
        if (!p.moved) {
          p.moved = true
          noHold()
          if (settle.current) clearTimeout(settle.current)
          setState({ glow: nearestSide(e.clientX, window.innerWidth), dragging: true })
        }
        // Follows the finger in any direction.
        el.style.transition = "none"
        el.style.right = "auto"
        el.style.left = `${fabLeftFor(e.clientX, window.innerWidth)}px`
        el.style.top = `${heightPercent(e.clientY, window.innerHeight)}%`
        const glow = nearestSide(e.clientX, window.innerWidth)
        if (glow !== p.glow) {
          p.glow = glow
          setState({ glow, dragging: true })
        }
      },
      onPointerUp: (e: PointerEvent) => {
        const p = press.current
        press.current = null
        const el = fab.current
        noHold()
        if (!p) return
        if (!p.moved || !el) {
          if (!p.held) onTap()
          return
        }
        const side = nearestSide(e.clientX, window.innerWidth)
        const height = heightPercent(e.clientY, window.innerHeight)
        // Glides to the edge, then its side's own place takes over (the same spot).
        el.style.transition = "left 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.22s ease"
        el.style.left = `${fabLeftAt(side, window.innerWidth)}px`
        el.style.top = `${height}%`
        onDrop(side, Math.round(height))
        setState({ glow: null, dragging: false })
        settle.current = setTimeout(() => clearInline(el), SETTLE_MS)
      },
      onPointerCancel: () => {
        noHold()
        press.current = null
        const el = fab.current
        if (el) clearInline(el)
        setState({ glow: null, dragging: false })
      }
    }
  }
}

interface PanelDragOptions {
  panel: MutableRef<HTMLElement | null>
  side: Side
  // Only the side panel (iPad, Mac) moves: on iPhone it's a sheet at the bottom.
  enabled: boolean
  onSide: (side: Side) => void
}

/** The panel, dragged by its header: pointer handlers for the header, and the edge it would land on. */
export function usePanelDrag({ panel, side, enabled, onSide }: PanelDragOptions) {
  const [glow, setGlow] = useState<Side | null>(null)
  const press = useRef<{ x: number; y: number; moved: boolean; glow: Side | null } | null>(null)
  // Its place when let go on the other side: it glides from there to its new side's place.
  const flip = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = panel.current
    const from = flip.current
    flip.current = null
    if (!el || from === null) return
    el.style.transition = "none"
    el.style.transform = "none"
    const to = el.getBoundingClientRect().left
    el.style.transform = `translateX(${from - to}px)`
    void el.offsetWidth
    el.style.removeProperty("transition")
    el.style.removeProperty("transform")
  }, [side])

  const reset = (el: HTMLElement | null) => {
    if (!el) return
    el.classList.remove("dragging")
    el.style.removeProperty("transition")
    el.style.removeProperty("transform")
  }

  return {
    glow,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (!enabled || e.button > 0 || (e.target as Element | null)?.closest?.(HEADER_CONTROLS)) return
        press.current = { x: e.clientX, y: e.clientY, moved: false, glow: null }
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      },
      onPointerMove: (e: PointerEvent) => {
        const p = press.current
        const el = panel.current
        if (!p || !el) return
        const dx = e.clientX - p.x
        if (!p.moved && !isDrag(dx, e.clientY - p.y)) return
        e.preventDefault()
        if (!p.moved) {
          p.moved = true
          el.classList.add("dragging")
        }
        // Follows across; the panel keeps its height.
        el.style.transition = "none"
        el.style.transform = `translateX(${dx}px)`
        const next = panelSideFor(el.getBoundingClientRect(), window.innerWidth)
        if (next !== p.glow) {
          p.glow = next
          setGlow(next)
        }
      },
      onPointerUp: () => {
        const p = press.current
        press.current = null
        const el = panel.current
        if (!p?.moved || !el) return
        const rect = el.getBoundingClientRect()
        const target = panelSideFor(rect, window.innerWidth)
        setGlow(null)
        el.classList.remove("dragging")
        if (target !== side) {
          flip.current = rect.left
          onSide(target)
        } else {
          // Back to its place, gliding (the panel's own transition).
          el.style.removeProperty("transition")
          el.style.removeProperty("transform")
        }
      },
      onPointerCancel: () => {
        press.current = null
        setGlow(null)
        reset(panel.current)
      }
    }
  }
}
