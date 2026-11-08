// The panel header's "…" (2.5, the director's layout): where Settings was. 2.5 (77), the director's split of
// reminders and watching (two words, two icons, never one list): "Remind me about this page…" (the bell; time
// only), "Watch this page…" (the eye; the whole page, where watching works), "Reminders · N" (the bell),
// "Watching · N" (the eye; where watching works) and Settings. 2.5 (78), the owner's note: Tips (the app's Tips,
// tips/TipsSheet) before Settings. 2.6, the owner's note: "Show the intro again" (the guided first request,
// Guide.tsx), last. 2.6 (91), the owner: «разрослось и его нужно структурировать»: each pair together (Remind me /
// Reminders, Watch this page / Watching), then Ultra's two (Find similar, Listen), and the rest (Settings, Tips,
// What's in Pro/Ultra, Show the intro again) under "Other…", folded until it's tapped.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { listenAround } from "../around"
import * as Icon from "../icons"
import { SimilarIcon } from "../similar/Similar"
import { tipsLabel, TipsIcon } from "../tips/TipsSheet"
import { Bell, More } from "./MessageUx"
import { SpeakerIcon } from "../listen/useListen"

export function PageMenu({ reminders, watches, onLater, onWatchPage, onSimilar, similarLocked, onReminders, onWatching, onTips, onSettings, onIntro, planTour, onListen, ultra, onClose }: {
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
  // 2.6: a Pro or Ultra subscriber's tour of the plan, again ("What's in Ultra").
  planTour?: { label: string; start: () => void }
  // 2.6: read the page aloud (Ultra; without it, the plans sheet). Absent: nothing to read here.
  onListen?: () => void
  ultra?: boolean
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
  // "Other…": folded each time the menu opens.
  const [more, setMore] = useState(false)
  return (
    <div ref={ref} class="cf-msg-menu cf-page-menu" role="menu">
      <button type="button" role="menuitem" class="cf-page-later" onClick={onLater}><Bell size={16} /> {t("uxLater")}</button>
      <button type="button" role="menuitem" class="cf-page-reminders" onClick={onReminders}><Bell size={16} /> {reminders > 0 ? t("uxRemindersN", reminders) : t("uxReminders")}</button>
      {onWatchPage && <button type="button" role="menuitem" class="cf-page-watch" onClick={onWatchPage}><Icon.Eye size={16} /> {t("uxWatchPage")}</button>}
      {watches !== null && (
        <button type="button" role="menuitem" class="cf-page-watching" onClick={onWatching}><Icon.Eye size={16} /> {watches > 0 ? t("uxWatchingN", watches) : t("uxWatching")}</button>
      )}
      {onSimilar && (
        <button type="button" role="menuitem" class="cf-page-similar" onClick={onSimilar}>
          <SimilarIcon size={16} /> {t("uxSimilar")}{similarLocked && <span class="cf-ultra-badge">Ultra</span>}
        </button>
      )}
      {onListen && <button type="button" role="menuitem" class="cf-page-listen" onClick={onListen}><SpeakerIcon size={16} /> {t("listenPage")}{!ultra && <span class="cf-ultra-badge">Ultra</span>}</button>}
      <button type="button" role="menuitem" class={`cf-page-other ${more ? "open" : ""}`} aria-expanded={more} onClick={() => setMore(!more)}>
        <More size={16} /> <span class="cf-page-other-l">{t("uxOther")}</span><svg class="cf-page-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      </button>
      {more && (
        <div class="cf-page-more-group" role="group" aria-label={t("uxOther")}>
          <button type="button" role="menuitem" class="cf-page-settings" onClick={onSettings}><Icon.Gear /> {t("settings")}</button>
          {tips && <button type="button" role="menuitem" class="cf-page-tips" onClick={onTips}><TipsIcon size={16} /> {tips}</button>}
          {planTour && <button type="button" role="menuitem" class="cf-page-plan-tour" onClick={planTour.start}><Icon.Sparkle size={15} /> {planTour.label}</button>}
          {onIntro && <button type="button" role="menuitem" class="cf-page-intro" onClick={onIntro}><Icon.Sparkle size={15} /> {t("uxShowIntro")}</button>}
        </div>
      )}
    </div>
  )
}
