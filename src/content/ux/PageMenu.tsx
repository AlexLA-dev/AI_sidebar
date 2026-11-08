// The panel header's "…" (2.5, the director's layout): where Settings was. 2.5 (77), the director's split of
// reminders and watching (two words, two icons, never one list): "Remind me about this page…" (the bell; time
// only), "Watch this page…" (the eye; the whole page, where watching works), "Reminders · N" (the bell),
// "Watching · N" (the eye; where watching works) and Settings. 2.5 (78), the owner's note: Tips (the app's Tips,
// tips/TipsSheet) before Settings. 2.6, the owner's note: "Show the intro again" (the guided first request,
// Guide.tsx), last.

import type { VNode } from "preact"
import { useEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import { listenAround } from "../around"
import * as Icon from "../icons"
import { SimilarIcon } from "../similar/Similar"
import { tipsLabel, TipsIcon } from "../tips/TipsSheet"
import { Bell } from "./MessageUx"

export function PageMenu({ reminders, watches, onLater, onWatchPage, onSimilar, similarLocked, onReminders, onWatching, onTips, onSettings, onIntro, onClose }: {
  reminders: number
  // null: no watching here (not Safari).
  watches: number | null
  onLater: () => void
  // Absent: no watching here.
  onWatchPage?: () => void
  // "Find similar…" (2.6, Ultra); absent: no page to find alternatives to. `similarLocked`: not in their plan (a badge).
  onSimilar?: () => void
  similarLocked?: boolean
  onReminders: () => void
  onWatching: () => void
  // Absent (or a build without Tips): no Tips item.
  onTips?: () => void
  onSettings: () => void
  // Absent: no page to summarize here, so no guide.
  onIntro?: () => void
  onClose: () => void
}): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (_: Event, path: EventTarget[]) => {
      // Its own "…" toggles it.
      if (!path.includes(ref.current as EventTarget) && !path.some((el) => (el as Element).classList?.contains("cf-page-more"))) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    let stop = () => {}
    // After this click is done.
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
  const tips = onTips && tipsLabel()
  return (
    <div ref={ref} class="cf-msg-menu cf-page-menu" role="menu">
      <button type="button" role="menuitem" onClick={onLater}><Bell size={16} /> {t("uxLater")}</button>
      {onWatchPage && <button type="button" role="menuitem" onClick={onWatchPage}><Icon.Eye size={16} /> {t("uxWatchPage")}</button>}
      {onSimilar && (
        <button type="button" role="menuitem" class="cf-page-similar" onClick={onSimilar}>
          <SimilarIcon size={16} /> {t("uxSimilar")}{similarLocked && <span class="cf-ultra-badge">Ultra</span>}
        </button>
      )}
      <button type="button" role="menuitem" onClick={onReminders}><Bell size={16} /> {reminders > 0 ? t("uxRemindersN", reminders) : t("uxReminders")}</button>
      {watches !== null && (
        <button type="button" role="menuitem" onClick={onWatching}><Icon.Eye size={16} /> {watches > 0 ? t("uxWatchingN", watches) : t("uxWatching")}</button>
      )}
      {tips && <button type="button" role="menuitem" onClick={onTips}><TipsIcon size={16} /> {tips}</button>}
      <button type="button" role="menuitem" onClick={onSettings}><Icon.Gear /> {t("settings")}</button>
      {onIntro && <button type="button" role="menuitem" class="cf-page-intro" onClick={onIntro}><Icon.Sparkle size={15} /> {t("uxShowIntro")}</button>}
    </div>
  )
}
