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

/** True the first time only: the tip shows now and is marked seen at once (a second bubble doesn't repeat it). */
function useFirstTime(): boolean {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if ((await chrome.storage.local.get(SEEN))[SEEN]) return
        if (!alive) return
        setShow(true)
        await chrome.storage.local.set({ [SEEN]: true })
      } catch {
        // No storage (the extension reloaded under the page): no tip.
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return show
}

/** `watching`: the eye exists here (Safari), so its line shows too, even before a price is selected. */
export function SelIconsTip({ watching }: { watching: boolean }): VNode | null {
  const show = useFirstTime()
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
