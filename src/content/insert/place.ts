// Where quick insert's windows go: beside the field when there's room, else under the caret (kept on screen), or
// as a sheet over the bottom of what's visible (above the keyboard when it's up).

import { panelRoot } from "../root"
import type { Field } from "./field"
import { besideSpot } from "./spot"
import { caretRect, pageRect, viewport } from "./watch"

/** Our panel's box while it's open beside the page. */
function panelBox(): DOMRect | null {
  return panelRoot()?.querySelector(".cf-panel")?.getBoundingClientRect() ?? null
}

/** Beside the field (besideSpot): placed and true, or false with nothing changed but the height cap. */
export function placeBeside(el: HTMLElement, field: Field | null, touch: boolean, width: number, maxHeight: number): boolean {
  if (!field || !field.el.isConnected) return false
  const vp = viewport(touch)
  el.style.maxHeight = `${Math.min(maxHeight, vp.height - 16)}px`
  const spot = besideSpot(pageRect(field.el), vp, width, el.offsetHeight, panelBox())
  if (!spot) return false
  el.style.width = `${spot.width}px`
  el.style.top = `${spot.top + vp.dy}px`
  el.style.left = `${spot.left + vp.dx}px`
  return true
}

export function placeByCaret(el: HTMLElement, field: Field | null, touch: boolean, width: number): void {
  const vp = viewport(touch)
  const caret = field && field.el.isConnected ? caretRect(field) : null
  const h = el.offsetHeight
  const w = Math.min(width, vp.width - 16)
  let top = caret ? caret.bottom + 6 : vp.height / 3
  if (caret && top + h > vp.height - 8 && caret.top - 6 - h >= 8) top = caret.top - 6 - h
  top = Math.max(8, Math.min(top, vp.height - h - 8))
  const left = Math.max(8, Math.min(caret ? caret.left - 12 : (vp.width - w) / 2, vp.width - w - 8))
  el.style.width = `${w}px`
  el.style.top = `${top + vp.dy}px`
  el.style.left = `${left + vp.dx}px`
}

export function placeSheet(el: HTMLElement, touch: boolean, maxHeight = 620): void {
  const vp = viewport(touch)
  // A wide window gets a card in the middle rather than a strip across it.
  const w = Math.min(vp.width - 16, touch ? 640 : 460)
  el.style.left = `${vp.dx + (vp.width - w) / 2}px`
  el.style.width = `${w}px`
  el.style.maxHeight = `${Math.min(maxHeight, vp.height - 16)}px`
  el.style.top = touch ? `${vp.dy + vp.height - 8 - el.offsetHeight}px` : `${vp.dy + Math.max(8, (vp.height - el.offsetHeight) / 3)}px`
}

/** Re-places `el` while the keyboard comes and goes or its content grows; returns the cleanup. */
export function follow(el: HTMLElement, place: () => void): () => void {
  place()
  const vv = window.visualViewport
  vv?.addEventListener("resize", place)
  vv?.addEventListener("scroll", place)
  const resized = new ResizeObserver(place)
  resized.observe(el)
  return () => {
    vv?.removeEventListener("resize", place)
    vv?.removeEventListener("scroll", place)
    resized.disconnect()
  }
}
