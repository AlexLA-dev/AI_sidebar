// The row of chips, one line that scrolls sideways, and what says so (2.7 after build 107, the owner on the quiet
// panel's frames: «надо как-то пользователю обозначить, что чипы свайпаются как карусель»):
// - the row fades out at an edge that has more chips behind it (data-more), and only there;
// - with a finger, it peeks a little way along and comes back, once per page, until the person has swiped it
//   themselves (kept on the device), as the selection buttons' chips do since 2.6;
// - with a mouse (which can't swipe), a small arrow at that edge moves the row along.
// The chips themselves never change places: the row's order is set as the panel opens (chips.ts).

import type { ComponentChildren, VNode } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"

import { moreAt } from "./chips"

const SWIPED_KEY = "cf:chipsSwiped"
// When the row peeks (after the panel has slid in) and how long it takes (quiet.css: cf-peek).
const PEEK_AFTER_MS = 900
const PEEK_MS = 900

let swiped: boolean | null = null
let peeked = false

function loadSwiped(): void {
  if (swiped !== null) return
  swiped = false
  try {
    chrome.storage.local.get(SWIPED_KEY, (r) => {
      void chrome.runtime.lastError
      if (r?.[SWIPED_KEY] === true) swiped = true
    })
  } catch {
    // no storage: the row peeks once per page
  }
}

function markSwiped(): void {
  if (swiped) return
  swiped = true
  try {
    void chrome.storage.local.set({ [SWIPED_KEY]: true })
  } catch {
    // kept for this page only
  }
}

const Arrow = ({ side, onClick }: { side: "left" | "right"; onClick: () => void }): VNode => (
  // Not for the keyboard or VoiceOver: every chip is reachable there, and the row follows the focus.
  <button type="button" class={`cf-chips-arrow ${side}`} tabIndex={-1} aria-hidden="true" onClick={onClick}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d={side === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} /></svg>
  </button>
)

/**
 * `cls`: the row's own classes ("cf-actions", "cf-actions follow"); `sig`: what the row holds (its chips' ids), so the
 * edges are looked at again when it changes; `arrows`: a pointer is there.
 */
export function ChipsRow({ cls, sig, arrows, children }: { cls: string; sig: string; arrows: boolean; children: ComponentChildren }): VNode {
  const wrap = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = row.current
    const box = wrap.current
    if (!el || !box) return
    loadSwiped()
    const look = () => {
      const chips = Array.from(el.children).map((c) => c.getBoundingClientRect())
      box.dataset.more = el.scrollWidth > el.clientWidth + 1 ? moreAt(el.getBoundingClientRect(), chips) : ""
    }
    look()
    const onScroll = () => {
      look()
      if (Math.abs(el.scrollLeft) > 12) markSwiped()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(look)
    observer?.observe(el)
    // The peek: with a finger, once per page, while the person hasn't swiped the row yet. The chips slide a little way
    // and come back by themselves (a CSS animation: the row's own scroll isn't touched, so it can't be left moved).
    let timers: Array<ReturnType<typeof setTimeout>> = []
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!arrows && !peeked && !still) {
      timers.push(setTimeout(() => {
        if (swiped || peeked || el.scrollWidth <= el.clientWidth + 1 || el.scrollLeft !== 0) return
        peeked = true
        el.classList.add("cf-peek")
        timers.push(setTimeout(() => el.classList.remove("cf-peek"), PEEK_MS + 100))
      }, PEEK_AFTER_MS))
    }
    return () => {
      el.removeEventListener("scroll", onScroll)
      observer?.disconnect()
      timers.forEach(clearTimeout)
      timers = []
      el.classList.remove("cf-peek")
    }
  }, [sig, arrows])
  const move = (side: "left" | "right") => {
    const el = row.current
    if (!el) return
    markSwiped()
    el.scrollBy({ left: (side === "left" ? -1 : 1) * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" })
  }
  return (
    <div ref={wrap} class="cf-chips">
      <div ref={row} class={cls}>{children}</div>
      {arrows && <Arrow side="left" onClick={() => move("left")} />}
      {arrows && <Arrow side="right" onClick={() => move("right")} />}
    </div>
  )
}
