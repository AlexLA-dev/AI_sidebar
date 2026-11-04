// What the eye and the bell are, said once each (the owner's notes on build 75: "it isn't obvious that I can, what
// the eye means and how to use it, and the same with the bell"). The eye's tip shows by the eye the first time it
// appears in the selection bubble; the bell's line shows the first time "Come back later…" opens, where the two
// stand together. Seen once, gone for good (on this device).

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { Bell } from "../ux/MessageUx"
import { Eye } from "./icons"

const SEEN = "cf:watchTips"
type Tip = "eye" | "later"

async function seen(): Promise<Partial<Record<Tip, boolean>>> {
  try {
    return ((await chrome.storage.local.get(SEEN))[SEEN] as Partial<Record<Tip, boolean>> | undefined) ?? {}
  } catch {
    return { eye: true, later: true }
  }
}

/** True the first time only: the tip shows now and is marked seen at once (a second bubble doesn't repeat it). */
function useOnce(tip: Tip): boolean {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let alive = true
    void seen().then((s) => {
      if (!alive || s[tip]) return
      setShow(true)
      void chrome.storage.local.set({ [SEEN]: { ...s, [tip]: true } }).catch(() => undefined)
    })
    return () => {
      alive = false
    }
  }, [])
  return show
}

/** By the eye in the bubble: what it does and that a tap sets it. Below the bubble, or above when there's no room. */
export function EyeTip(): VNode | null {
  const show = useOnce("eye")
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const bubble = el?.closest(".cf-bubble")
    if (!el || !bubble) return
    const vv = window.visualViewport
    const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight)
    el.classList.toggle("up", bubble.getBoundingClientRect().bottom + el.offsetHeight + 12 > bottom)
  }, [show])
  if (!show) return null
  return <span ref={ref} class="cf-watch-tip cf-snack" role="note">{t("watchTipEye")}</span>
}

/** In "Come back later…", between Remind and watching: the bell and the eye in one line each. */
export function LaterTip(): VNode | null {
  if (!useOnce("later")) return null
  return (
    <p class="cf-watch-later-tip" role="note">
      <span><Bell size={14} /> {t("watchTipBell")}</span>
      <span><Eye size={14} /> {t("watchTipWatch")}</span>
    </p>
  )
}
