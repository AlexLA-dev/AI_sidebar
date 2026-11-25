// The bell and the eye in the selection bubble, said once (2.5 (77), the director: one tip for both icons, the
// first time the bubble shows them: the bell reminds at a time you pick, the eye says when something changes).
// Under the bubble, or over it near the screen's bottom; it never changes the bubble's size, so the bubble stays
// where it was put (clear of the system's edit menu). Seen once, gone for good (on this device).

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import { Bell } from "./MessageUx"

const SEEN = "cf:selIconsTip"

/** True while it hasn't been seen on this device (2.8.1: marked seen only once it is on screen, below). */
function useNotSeen(): boolean {
  const [unseen, setUnseen] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if ((await chrome.storage.local.get(SEEN))[SEEN]) return
        if (alive) setUnseen(true)
      } catch {
        // No storage (the extension reloaded under the page): no tip.
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return unseen
}

/**
 * `watching`: the eye exists here (Safari), so its line shows too, even before a price is selected. 2.8.1, the hint
 * coordinator: it says it would show (`onWant`) and shows only when let (`allowed`); seen once it was on screen.
 */
export function SelIconsTip({ watching, allowed = true, onWant }: { watching: boolean; allowed?: boolean; onWant?: (on: boolean) => void }): VNode | null {
  const unseen = useNotSeen()
  const wantRef = useRef(onWant)
  wantRef.current = onWant
  useEffect(() => wantRef.current?.(unseen), [unseen])
  useEffect(() => () => wantRef.current?.(false), [])
  const show = unseen && allowed
  useEffect(() => {
    if (show) void chrome.storage.local.set({ [SEEN]: true }).catch(() => undefined)
  }, [show])
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const bubble = el?.closest(".cf-bubble")
    if (!el || !bubble) return
    const vv = window.visualViewport
    const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight)
    el.classList.toggle("up", bubble.getBoundingClientRect().bottom + el.offsetHeight + 12 > bottom)
  }, [show])
  if (!show) return null
  return (
    <div ref={ref} class="cf-sel-tip cf-snack" role="note">
      <span><Bell size={14} /> {t("watchTipBell")}</span>
      {watching && <span><Icon.Eye size={14} /> {t("watchTipWatch")}</span>}
    </div>
  )
}
