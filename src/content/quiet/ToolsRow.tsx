// The buttons under a message, on one line in every language (2.7 after build 107, the owner's decision 3: «Кнопки под
// сообщением: один ряд»). The row never wraps. When its words don't fit the panel, first the buttons sit closer, then
// the words give way to the icons one button at a time, in the order their labels name (data-give, the lowest first).
// Each button keeps its name for VoiceOver and as a tooltip. Measured before the paint, when the row's content (`sig`)
// or its width changes, with the Mac's hover buttons counted in (they take the «…»'s place under the pointer).
//
// 2.7 (109), the owner on 108: «на iPad Pro под ответом помещается to collections, и потом она же дублируется в меню
// <…>. А на телефоне и iPad mini без to collections и tag под ответом, хотя в том же iPad mini оно влазит вполне». The
// director's rule: an action lives in one place, in the row when it fits, otherwise in «…», never both; what fits is
// decided by the width there is, not by the device. So a button with data-drop (To collection 1, Tag 2) can leave the
// row: after its own words gave way it goes, the lowest first, before the words of Copy, Share, Listen and Insert do.
// What left is handed to the row's content (`children(dropped)`): the «…» lists exactly that.
//
// 110, the owner on 109 (iPad mini, a note's row past the panel's left edge): the row is as wide as its message's
// column (quiet.css), so what it measures is the room there is. If even the icons don't fit, it wraps (data-wrap)
// rather than cut a button off.

import type { ComponentChildren, VNode } from "preact"
import { useLayoutEffect, useRef, useState } from "preact/hooks"

import { giveWay, type Step } from "./giveWay"

/** The width the row's buttons take side by side (its menu, when open, hangs under it and doesn't count). */
function needed(el: HTMLElement): number {
  const parts = Array.from(el.children).filter((c) => !c.classList.contains("cf-msg-menu")) as HTMLElement[]
  const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0
  return parts.reduce((sum, c) => sum + c.offsetWidth, 0) + gap * Math.max(0, parts.filter((c) => c.offsetWidth > 0).length - 1)
}

/** The row with the first `n` steps taken; returns the buttons out of it. */
function apply(el: HTMLElement, steps: Step[], n: number): Set<string> {
  const taken = steps.slice(0, n)
  const off = new Set(taken.flatMap((s) => ("give" in s ? [s.give] : [])))
  const out = new Set(taken.flatMap((s) => ("drop" in s ? [s.drop] : [])))
  el.dataset.tight = taken.length > 0 ? "1" : "0"
  for (const label of el.querySelectorAll<HTMLElement>("[data-give]")) label.toggleAttribute("data-off", off.has(Number(label.dataset.give)))
  for (const button of el.querySelectorAll<HTMLElement>("[data-drop]")) button.hidden = out.has(button.dataset.drop ?? "")
  return out
}

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))

export function ToolsRow({ cls, sig, children }: { cls: string; sig: string; children: (dropped: ReadonlySet<string>) => ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set())
  const droppedRef = useRef(dropped)
  droppedRef.current = dropped
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const buttons = Array.from(el.children).filter((c) => !c.classList.contains("cf-msg-menu")) as HTMLElement[]
      const steps = giveWay(buttons.flatMap((b) => {
        const label = b.querySelector<HTMLElement>("[data-give]")
        const give = label ? Number(label.dataset.give) : null
        const drop = b.dataset.drop ? b.dataset.drop : null
        return give === null && drop === null ? [] : [{ give, drop, order: drop ? Number(b.dataset.dropOrder ?? 0) : null }]
      }))
      el.dataset.measure = "1"
      delete el.dataset.wrap
      let n = 0
      let out = apply(el, steps, n)
      while (n < steps.length && needed(el) > el.clientWidth + 1) out = apply(el, steps, ++n)
      if (needed(el) > el.clientWidth + 1) el.dataset.wrap = "1"
      delete el.dataset.measure
      if (!same(out, droppedRef.current)) setDropped(out)
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [sig])
  return <div ref={ref} class={cls}>{children(dropped)}</div>
}
