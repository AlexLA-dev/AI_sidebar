// The buttons under a message, on one line in every language (2.7 after build 107, the owner's decision 3: «Кнопки под
// сообщением: один ряд»). The row never wraps. When its words don't fit the panel, they go in two steps and the icons
// stay: first the words of Share, Listen and the rest (.cf-tl), then Copy's and Insert's too (.cf-tk). Each button
// keeps its name for VoiceOver and as a tooltip. Measured before the paint, when the row's content (`sig`) or its
// width changes, with the Mac's hover buttons counted in (they take the «…»'s place under the pointer).

import type { ComponentChildren, VNode } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"

/** The width the row's buttons take side by side (its menu, when open, hangs under it and doesn't count). */
function needed(el: HTMLElement): number {
  const parts = Array.from(el.children).filter((c) => !c.classList.contains("cf-msg-menu")) as HTMLElement[]
  const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0
  return parts.reduce((sum, c) => sum + c.offsetWidth, 0) + gap * Math.max(0, parts.filter((c) => c.offsetWidth > 0).length - 1)
}

export function ToolsRow({ cls, sig, children }: { cls: string; sig: string; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.dataset.measure = "1"
      let level = 0
      el.dataset.tight = "0"
      while (level < 2 && needed(el) > el.clientWidth + 1) el.dataset.tight = String(++level)
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
