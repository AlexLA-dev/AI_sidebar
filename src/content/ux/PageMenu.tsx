// The panel header's "…" (2.5, the director's layout): where Settings was. 2.5 (77), the director's split of
// reminders and watching (two words, two icons, never one list): "Remind me about this page…" (the bell; time
// only), "Watch this page…" (the eye; the whole page, where watching works), "Reminders · N" (the bell),
// "Watching · N" (the eye; where watching works) and Settings. 2.5 (78), the owner's note: Tips (the app's Tips,
// tips/TipsSheet) before Settings. 2.6, the owner's note: "Show the intro again" (93: "Replay the basics tour") (the guided first request,
// Guide.tsx), last. 2.6 (91), the owner: «разрослось и его нужно структурировать»: each pair together (Remind me /
// Reminders, Watch this page / Watching), then Ultra's two (Find similar, Listen), and the rest (Settings, Tips,
// What's in Pro/Ultra, Show the intro again) under "Other…", folded until it's tapped. Build 94, the owner: «в меню
// чатов тоже нужно добавить кнопку <…> где будут подходящие функции, хотя бы watch list, settings, tips, все про
// онбординг»: the chats list has this menu too, without what's about the page (Remind me about this page, Watch this
// page, Find similar, Name by topic, Listen), with Recently Deleted after the lists. 2.6 (100): "Rate in App Store" last
// under Other… (the App Store's "Write a Review", only when tapped: Apple's own request comes by itself in the app).

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { listenAround } from "../around"
import * as Icon from "../icons"
import { SimilarIcon } from "../similar/Similar"
import { tipsLabel, TipsIcon } from "../tips/TipsSheet"
import { Bell, More } from "./MessageUx"
import { SpeakerIcon } from "../listen/useListen"

export function PageMenu({ reminders, watches, trash = 0, onLater, onWatchPage, onSimilar, similarLocked, onNameChat, onReminders, onWatching, onTips, onSettings, onIntro, planTour, onListen, ultra, onTrash, onRate, onClose }: {
  reminders: number
  // null: no watching here (not Safari).
  watches: number | null
  // Recently Deleted (the chats list's menu, build 94): how many chats are there; absent, no item.
  trash?: number
  onTrash?: () => void
  // Absent: not about a page (the chats list).
  onLater?: () => void
  // Absent: no watching here.
  onWatchPage?: () => void
  // "Find similar…" (2.6, Ultra); absent: no page to find alternatives to. `similarLocked`: not in their plan (a badge).
  onSimilar?: () => void
  similarLocked?: boolean
  // "Name by topic" (2.6, with suggestions on): absent outside a chat with messages, or while it's being named.
  onNameChat?: () => void
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
  // 2.6 (100): the App Store's "Write a Review" (Safari only; absent elsewhere).
  onRate?: () => void
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
  // 2.6 (92), the owner: with Other… open on an iPhone its last items were below the screen, and a swipe moved the page.
  // The menu is as tall as there's room from it to the panel's (and the screen's) bottom and scrolls inside itself;
  // opening Other… brings its items into view.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const panel = menu.closest(".cf-panel")?.getBoundingClientRect?.()
    const vv = window.visualViewport
    const bottom = Math.min(panel?.bottom ?? Infinity, vv ? vv.offsetTop + vv.height : window.innerHeight)
    const top = menu.getBoundingClientRect?.().top
    if (top !== undefined && Number.isFinite(bottom)) menu.style.maxHeight = `${Math.max(160, Math.floor(bottom - top - 8))}px`
    if (more) (menu.querySelector(".cf-page-more-group") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" })
  }, [more])
  return (
    <div ref={ref} class="cf-msg-menu cf-page-menu" role="menu">
      {onLater && <button type="button" role="menuitem" class="cf-page-later" onClick={onLater}><Bell size={16} /> {t("uxLater")}</button>}
      <button type="button" role="menuitem" class="cf-page-reminders" onClick={onReminders}><Bell size={16} /> {reminders > 0 ? t("uxRemindersN", reminders) : t("uxReminders")}</button>
      {onWatchPage && <button type="button" role="menuitem" class="cf-page-watch" onClick={onWatchPage}><Icon.Eye size={16} /> {t("uxWatchPage")}</button>}
      {watches !== null && (
        <button type="button" role="menuitem" class="cf-page-watching" onClick={onWatching}><Icon.Eye size={16} /> {watches > 0 ? t("uxWatchingN", watches) : t("uxWatching")}</button>
      )}
      {onTrash && trash > 0 && <button type="button" role="menuitem" class="cf-page-trash" onClick={onTrash}><Icon.Trash /> {t("trashRow", trash)}</button>}
      {onSimilar && (
        <button type="button" role="menuitem" class="cf-page-similar" onClick={onSimilar}>
          <SimilarIcon size={16} /> {t("uxSimilar")}{similarLocked && <span class="cf-ultra-badge">Ultra</span>}
        </button>
      )}
      {onNameChat && <button type="button" role="menuitem" class="cf-page-name" onClick={onNameChat}><Icon.Sparkle size={15} /> {t("orgNameChat")}</button>}
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
          {onRate && <button type="button" role="menuitem" class="cf-page-rate" onClick={onRate}><Icon.Star size={16} /> {t("uxRate")}</button>}
        </div>
      )}
    </div>
  )
}
