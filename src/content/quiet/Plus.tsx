// «+» by the question field (2.7 after build 107, the owner's decision 6): Note (the same as swiping the send button,
// «свайп неочевиден и может забыться»), the page snapshot, the Whole chat switch and the answers left. On the compact
// chat the line under the field is gone and these are where its switch and its count went; the count also shows by the
// field, as a number, on Free and when few answers are left (leftBadge). Templates and Copied aren't here (decision 7).

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import { listenAround } from "../around"
import * as Icon from "../icons"
import { CameraIcon } from "../ux/ShotUi"

/** Few answers left: under a fifth of the allowance (and always the last three). */
export const LOW_SHARE = 0.2
export const LOW_COUNT = 3

/**
 * The count by the field, outside «+»: the answers left on Free, and on a paid plan once they run low, so nobody
 * meets the limit by surprise. Null when it isn't shown (their own key, a paid plan with plenty left, nothing known yet).
 */
export function leftBadge(usage: { used: number; limit: number } | null, plan: string, ownKey: boolean): { left: number; low: boolean } | null {
  if (ownKey || !usage || usage.limit <= 0) return null
  const left = Math.max(0, usage.limit - usage.used)
  const low = left <= LOW_COUNT || left / usage.limit < LOW_SHARE
  const free = plan !== "pro" && plan !== "ultra"
  return free || low ? { left, low } : null
}

export interface PlusProps {
  // Writing a note now (the send button saves it): Note is marked.
  noteMode: boolean
  onNote: () => void
  // The snapshot's switch (null: no notes here, as in "Ask your chats").
  shot: { on: boolean; onChange: (on: boolean) => void } | null
  // Whole chat (null: not in this chat). `locked`: Pro's, off for this plan.
  whole: { on: boolean; locked: boolean; onChange: (on: boolean) => void } | null
  // The answers left, in full, and what stands after it on Free (Get Pro, an offer).
  usage: string
  after?: ComponentChildren
  onClose: () => void
}

export function PlusMenu({ noteMode, onNote, shot, whole, usage, after, onClose }: PlusProps): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (_: Event, path: EventTarget[]) => {
      // Its own «+» toggles it.
      if (!path.includes(ref.current as EventTarget) && !path.some((el) => (el as Element).classList?.contains("cf-plus"))) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    let stop = () => {}
    const timer = setTimeout(() => {
      if (ref.current) stop = listenAround(ref.current, "pointerdown", away)
      document.addEventListener("keydown", esc, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      stop()
      document.removeEventListener("keydown", esc, true)
    }
  }, [onClose])
  return (
    <div class="cf-plus-anchor">
    <div ref={ref} class="cf-plus-menu" role="menu" aria-label={t("plusButton")}>
      <button type="button" role="menuitemcheckbox" aria-checked={noteMode} class={`cf-plus-item ${noteMode ? "on" : ""}`} onClick={onNote}>
        <Icon.Pencil /> <span class="cf-plus-l">{t("selNote")}</span>
        {noteMode && <span class="cf-plus-mark"><Icon.Check /></span>}
      </button>
      {shot && (
        <label class="cf-plus-item cf-plus-switch">
          <CameraIcon size={15} /> <span class="cf-plus-l">{t("shotSwitch")}</span>
          <input type="checkbox" role="switch" checked={shot.on} onChange={(e) => shot.onChange(e.currentTarget.checked)} />
          <span class="cf-switch" aria-hidden="true" />
        </label>
      )}
      {whole && (
        <label class="cf-plus-item cf-plus-switch cf-plus-whole" title={t("wholeChatHint")}>
          <Icon.Doc /> <span class="cf-plus-l">{t("wholeChat")}{whole.locked && <span class="cf-pro-badge">Pro</span>}</span>
          <input type="checkbox" role="switch" checked={whole.on} onChange={(e) => {
            if (whole.locked) e.currentTarget.checked = false
            whole.onChange(e.currentTarget.checked)
          }} />
          <span class="cf-switch" aria-hidden="true" />
        </label>
      )}
      {(usage || after) && (
        <div class="cf-plus-usage" role="status">
          <span class="cf-plus-left">{usage}</span>
          {after}
        </div>
      )}
    </div>
    </div>
  )
}
