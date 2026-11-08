// The guided first request (2.6, the owner: "not just show which buttons there are, but take the person through them,
// so they tap them and make their first request"). Where the first-open tour was: instead of seven cards to read,
// the person does it: Summarize, the consent card, the answer, then a selection on the page and Ask AI, and last
// where the chats and the "…" menu are. Each step lights up what to tap and lets only that be tapped (the rest of
// the panel is held under a clear cover); the card's Skip ends it any time. A tap on what's lit up takes the guide
// along (build 86, the owner: it stayed behind when he opened the chat list): the chat list gets its own step, and
// the "…" opened ends it with its menu showing.
//
// App drives it: which step is on comes from what happens in the panel (a question going out, the consent card, the
// answer coming in, the selection buttons showing). It ends by itself, quietly, when the consent is declined, the
// free answers run out or an answer fails: the panel's own card then says what happened. Steps and endings are
// counted ("use" f "tour", src/shared/usage.ts) for the guided funnel (cf_feature_funnels "guided").

import type { VNode } from "preact"
import { useEffect } from "preact/hooks"

import { t, type MessageKey } from "../shared/i18n"
import * as Icon from "./icons"
import { SpeakerIcon } from "./listen/useListen"
import { SimilarIcon } from "./similar/Similar"
import { ClipFrame } from "./tips/ClipFrame"
import { say, tipsData } from "./tips/data"
import { Blockers, cardPlace, chatsStep, holeAround, MENU_STEP, Shade, useBlurPanel, useParts } from "./Tour"
import { More } from "./ux/MessageUx"

/** The steps, in order. "pick" and "ask" are on the page (the panel closed), the rest in the panel. */
export const GUIDE_STEPS = [
  "summarize", "consent", "answer", "select", "pick", "ask", "askSel", "answer2", "chats", "chatList", "menu",
  // 2.6 (build 89, the owner): after buying Pro or Ultra, a tour of what the plan added, on the same engine.
  "pro_media", "pro_chats", "pro_askChats", "pro_sort", "pro_templates", "pro_watch", "ultra_listen", "ultra_similar", "ultra_watch"
] as const
export type GuideStep = (typeof GUIDE_STEPS)[number]

/** A plan's tour (2.6 (91), the owner: show it, and light up only the feature's own control, where it is). A feature
 * with a place in the panel is shown there: the tour opens the chat list for ✦ and "Ask your chats", Templates for
 * templates, the "…" menu for the watched pages; one without a place (videos and PDFs, sorting) is a card, with a
 * Tips clip where there is one. Pro's, Ultra's on top of Pro, and Ultra's with Pro's for someone coming from below. */
export const PLAN_STEPS: readonly GuideStep[] = ["pro_media", "pro_chats", "pro_askChats", "pro_sort", "pro_templates", "pro_watch", "ultra_listen", "ultra_similar", "ultra_watch"]
export const PRO_TOUR: GuideStep[] = ["pro_media", "pro_chats", "pro_askChats", "pro_sort", "pro_templates", "pro_watch"]
export const ULTRA_TOUR: GuideStep[] = ["ultra_listen", "ultra_similar", "ultra_watch"]
export const ULTRA_FULL_TOUR: GuideStep[] = ["ultra_listen", "ultra_similar", "pro_media", "pro_chats", "pro_askChats", "pro_sort", "pro_templates", "ultra_watch"]
/** Where a plan step is shown (the chat otherwise), and the steps shown in the open "…" menu. */
export const PLAN_VIEW: Partial<Record<GuideStep, "threads" | "templates">> = { pro_chats: "threads", pro_askChats: "threads", pro_templates: "templates" }
export const PLAN_MENU: readonly GuideStep[] = ["pro_watch", "ultra_watch"]

/** Steps shown on the page, with the panel closed. */
export const ON_PAGE: readonly GuideStep[] = ["pick", "ask"]
/** Steps where a question is on its way: no card (it would cover the answer coming in). */
export const WAITING: readonly GuideStep[] = ["answer", "answer2"]

interface Card {
  targets: string[][]
  icon: VNode
  title: MessageKey
  body: MessageKey
  // Button names in the text ({0}), in the person's language.
  args?: MessageKey[]
  // The card's own button, when the step goes on by it (not by tapping what's lit up).
  next?: MessageKey
  // Taps outside the lit-up part do nothing (a step that waits for that part to be tapped).
  holds: boolean
  // Just above the question box, nothing dimmed: the answer above it can be read and scrolled.
  foot?: true
  // No card: what's lit up says it all (the consent card, with its own "Not now").
  bare?: true
  // A Tips clip on the card (the feature at work), from the extension's own files like the Tips sheet's.
  clip?: string
}

function card(step: GuideStep, touch: boolean, sync: boolean): Card | null {
  switch (step) {
    case "summarize":
      return { targets: [[".cf-empty .cf-chip[data-action=summarize]", ".cf-actions .cf-chip[data-action=summarize]", ".cf-empty .cf-chip"]], icon: <Icon.Sparkle size={16} />, title: "guideSumTitle", body: "guideSumBody", args: ["actSummarize"], holds: true }
    case "consent":
      return { targets: [[".cf-messages .cf-card.consent"]], icon: <Icon.Check />, title: "guideConsentTitle", body: "guideConsentBody", holds: true, bare: true }
    case "answer":
      return { targets: [], icon: <Icon.Doc />, title: "guideAnswerTitle", body: "guideAnswerBody", next: "tourNext", holds: false, foot: true }
    case "select":
      return { targets: [], icon: <Icon.Cursor />, title: "guideSelectTitle", body: touch ? "guideSelectBodyTouch" : "guideSelectBodyMouse", args: ["selAsk"], next: "guideSelectGo", holds: true }
    case "askSel":
      return { targets: [[".cf-messages .cf-actions"], [".cf-input"]], icon: <Icon.Cursor />, title: "guideAskSelTitle", body: "guideAskSelBody", args: ["actExplain"], holds: false }
    case "chats": {
      const s = chatsStep(sync)
      return { ...s, next: "tourNext", holds: true }
    }
    // In the chat list (the chats button tapped): what it does, the list free to look through and tap.
    case "chatList":
      return { targets: [], icon: <Icon.Chats />, title: "hintChatsTitle", body: "hintChatsBody", next: "tourNext", holds: false, foot: true }
    case "menu":
      return { ...MENU_STEP, next: "tourDone", holds: true }
    // A plan's tour: what's lit up is the feature's own control and can be tapped (it takes the tour on); Next goes
    // without it. Nothing else is lit up.
    case "pro_media":
      return { targets: [], icon: <Icon.Doc />, title: "ptProMediaTitle", body: "ptProMediaBody", next: "tourNext", holds: false }
    case "pro_chats":
      return { targets: [[".cf-search-ai"]], icon: <Icon.Sparkle size={16} />, title: "ptProFindTitle", body: "ptProFindBody", next: "tourNext", holds: false }
    case "pro_askChats":
      return { targets: [[".cf-ask-history"]], icon: <Icon.Chats />, title: "ptProAskTitle", body: "ptProAskBody", args: ["askHistory"], next: "tourNext", holds: false }
    case "pro_sort":
      return { targets: [], icon: <Icon.Tag />, title: "ptProSortTitle", body: "ptProSortBody", next: "tourNext", holds: false, clip: "organize" }
    case "pro_templates":
      return { targets: [[".cf-qi-empty.big .cf-primary", ".cf-qi-body"]], icon: <Icon.Pencil />, title: "ptProTemplatesTitle", body: "ptProTemplatesBody", args: ["qiTemplateButton"], next: "tourNext", holds: false, clip: "fill" }
    case "pro_watch":
      return { targets: [[".cf-page-menu .cf-page-watch"], [".cf-page-menu .cf-page-watching"]], icon: <Icon.Eye size={16} />, title: "ptProWatchTitle", body: "ptProWatchBody", args: ["uxWatchPage"], next: "tourDone", holds: false }
    case "ultra_listen":
      return { targets: [[".cf-messages .cf-listen-btn.last"]], icon: <SpeakerIcon />, title: "ptUltraListenTitle", body: "ptUltraListenBody", args: ["listen", "listenPage"], next: "tourNext", holds: false, clip: "listen" }
    case "ultra_similar":
      return { targets: [[".cf-empty .cf-chip[data-action=similar]", ".cf-page-menu .cf-page-similar"]], icon: <SimilarIcon />, title: "similarTitle", body: "ptUltraSimilarBody", args: ["actSimilar", "selSimilar"], next: "tourNext", holds: false, clip: "similar" }
    case "ultra_watch":
      return { targets: [[".cf-page-menu .cf-page-watch"], [".cf-page-menu .cf-page-watching"]], icon: <Icon.Eye size={16} />, title: "ptUltraWatchTitle", body: "ptUltraWatchBody", args: ["uxWatchPage"], next: "tourDone", holds: false }
    default:
      return null
  }
}

/** The step's card in the panel (none on the page's steps or while an answer comes in). */
export function GuideCard({ panel, step, touch, sync, onNext, onSkip, onTap }: {
  panel: HTMLElement
  step: GuideStep
  touch: boolean
  sync: boolean
  onNext: () => void
  onSkip: () => void
  // A tap on what the step lights up (App takes the guide where that tap leads).
  onTap: (step: GuideStep) => void
}): VNode | null {
  const spec = card(step, touch, sync)
  const parts = useParts(panel, spec?.targets ?? [], step)
  useBlurPanel(panel)
  useEffect(() => {
    const selectors = (spec?.targets ?? []).flat()
    if (selectors.length === 0) return
    // Capture: before the tapped button's own handler changes the panel under it.
    const onClick = (e: Event) => {
      const el = e.target
      if (el instanceof Element && selectors.some((s) => el.closest(s) !== null)) onTap(step)
    }
    panel.addEventListener("click", onClick, true)
    return () => panel.removeEventListener("click", onClick, true)
  }, [panel, step])
  if (!spec) return null
  const hole = holeAround(parts)
  // Above the composer (the box the answer step points to), not over it.
  const composer = spec.foot ? panel.querySelector<HTMLElement>(".cf-composer") : null
  const footGap = composer ? Math.max(12, panel.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 8) : 12
  return (
    <div class={`cf-tour cf-guide ${hole || spec.foot ? "" : "dim"}`} role="dialog" aria-label={t(spec.title)}>
      <Shade hole={hole} parts={parts} />
      {spec.holds && hole && <Blockers hole={hole} />}
      {spec.holds && !hole && <div class="cf-tour-block" style={{ inset: 0 }} />}
      {!spec.bare && <div class="cf-tour-card" style={spec.foot ? { bottom: `${footGap}px` } : cardPlace(hole, panel.clientHeight)}>
        <div class="cf-tour-head">
          <span class="cf-tour-icon">{spec.icon}</span>
        </div>
        {spec.clip && <GuideClip name={spec.clip} />}
        <strong>{t(spec.title)}</strong>
        <p>{t(spec.body, ...(spec.args ?? []).map((k) => t(k)))}</p>
        <div class="cf-tour-actions">
          {spec.next !== "tourDone" && <button type="button" class="cf-link" onClick={onSkip}>{t("tourSkip")}</button>}
          {spec.next && <button type="button" class="cf-primary" onClick={onNext}>{t(spec.next)}</button>}
        </div>
      </div>}
    </div>
  )
}

/** On the page, until there's a selection: what to do, with Skip. Over the top of what's visible. */
export function GuidePill({ touch, onSkip }: { touch: boolean; onSkip: () => void }): VNode {
  const vv = window.visualViewport
  const top = (vv?.offsetTop ?? 0) + 12
  return (
    <div class="cf-guide-pill" role="status" style={{ top: `${top}px` }}>
      <Icon.Cursor />
      <span>{t(touch ? "guidePickTouch" : "guidePickMouse")}</span>
      <button type="button" onClick={onSkip}>{t("tourSkip")}</button>
    </div>
  )
}

/** A Tips clip on a tour card: the feature at work (the owner: show it, not only describe it). The app's clip, like
 * the Tips sheet's (ClipFrame); one still frame with Reduce Motion; a line instead before the app has shared it. */
function GuideClip({ name }: { name: string }): VNode | null {
  const data = tipsData()
  if (!data) return null
  const lang = say(data.clipLang) === "ru" ? "ru" : "en"
  let still = false
  try {
    still = matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    // No media queries: it plays.
  }
  return <div class="cf-guide-clip"><ClipFrame name={name} lang={lang} still={still} motion={!still} /></div>
}
