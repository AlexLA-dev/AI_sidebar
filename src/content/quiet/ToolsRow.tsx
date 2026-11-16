// The buttons under a message, on one line in every language (2.7 after build 107, the owner's decision 3: «Кнопки под
// сообщением: один ряд»). The row never wraps. When its words don't fit the panel, first the buttons sit closer, then
// the words give way to the icons one button at a time, in the order their labels name (data-give, the lowest first):
// To collection, Tag, Share, Listen, Copy, and Insert into field last (the owner: it was well visible, keep it). Each
// button keeps its name for VoiceOver and as a tooltip. Measured before the paint, when the row's content (`sig`) or
// its width changes, with the Mac's hover buttons counted in (they take the «…»'s place under the pointer).

import type { ComponentChildren, VNode } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"

/** The width the row's buttons take side by side (its menu, when open, hangs under it and doesn't count). */
function needed(el: HTMLElement): number {
  const parts = Array.from(el.children).filter((c) => !c.classList.contains("cf-msg-menu")) as HTMLElement[]
  const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0
  return parts.reduce((sum, c) => sum + c.offsetWidth, 0) + gap * Math.max(0, parts.filter((c) => c.offsetWidth > 0).length - 1)
}

/** The row at `step`: 0 as written; 1 the buttons closer; from 2 on, the words whose data-give is under `step` are off. */
function setStep(el: HTMLElement, labels: HTMLElement[], step: number): void {
  el.dataset.tight = step > 0 ? "1" : "0"
  for (const label of labels) label.toggleAttribute("data-off", Number(label.dataset.give) < step)
}

export function ToolsRow({ cls, sig, children }: { cls: string; sig: string; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const labels = Array.from(el.querySelectorAll<HTMLElement>("[data-give]"))
      const last = 1 + Math.max(0, ...labels.map((l) => Number(l.dataset.give)))
      el.dataset.measure = "1"
      let step = 0
      setStep(el, labels, step)
      while (step < last && needed(el) > el.clientWidth + 1) setStep(el, labels, ++step)
      delete el.dataset.measure
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
  return <div ref={ref} class={cls}>{children}</div>
}
