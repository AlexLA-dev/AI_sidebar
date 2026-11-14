// Page hints in the first days (2.7, plan section 6, the owner's scenario of 12 November): when there's something to
// offer on a page, a line by the ✦ circle («Найти похожее дешевле?», «Пересказать?», «Следить за ценой?»); a tap opens
// the panel with a short how-to in the chat and that feature's button glowing until it's used. They lead to Pro, Ultra
// and to using up the free answers:
// - Free: what spends answers (a summary), and Pro's and Ultra's features with their offer (the owner: Free has no Find
//   similar now; its line offers Ultra);
// - Pro: Ultra's features (Find similar, Listen);
// - Ultra: what they haven't used yet.
// A page in another language gets the translate pill instead (src/content/translate), never a line.
//
// The rules of showing: only features not used yet; one line a page and one a day; the first 10 days or 5 lines, then
// none; two ✕ in a row turn them off (and Settings has the switch); not while typing, not right as the page opens.
// Pure, for tests (tests/page-hints.test.mts).

import type { PageKind } from "./detect"

export type HintId = "similar" | "watch" | "summary" | "listen" | "video" | "templates" | "remind" | "calendar"

/** What a hint's tap points at in the panel: the button that glows until it's used. */
export type GlowTarget = "summarize" | "similar" | "menu" | "composer"

export interface HintSpec {
  bubble: string
  title: string
  // The how-to: for someone who has the feature, and for someone it's offered to (a plan they don't have).
  body: string
  bodyUp?: string
  glow: GlowTarget
  // The plan it takes (none: everyone has it).
  needs?: "pro" | "ultra"
}

export const HINTS: Record<HintId, HintSpec> = {
  similar: { bubble: "phSimilar", title: "phSimilarTitle", body: "phSimilarBody", bodyUp: "phSimilarBodyUp", glow: "similar", needs: "ultra" },
  watch: { bubble: "phWatch", title: "phWatchTitle", body: "phWatchBody", glow: "menu" },
  summary: { bubble: "phSummary", title: "phSummaryTitle", body: "phSummaryBody", glow: "summarize" },
  listen: { bubble: "phListen", title: "phListenTitle", body: "phListenBody", bodyUp: "phListenBodyUp", glow: "menu", needs: "ultra" },
  video: { bubble: "phVideo", title: "phVideoTitle", body: "phVideoBody", bodyUp: "phVideoBodyUp", glow: "composer", needs: "pro" },
  templates: { bubble: "phTemplates", title: "phTemplatesTitle", body: "phTemplatesBody", glow: "menu" },
  remind: { bubble: "phRemind", title: "phRemindTitle", body: "phRemindBody", glow: "composer" },
  calendar: { bubble: "phCalendar", title: "phCalendarTitle", body: "phCalendarBody", glow: "composer" }
}

export type Plan = "free" | "byok" | "pro" | "ultra"

/** The hints a page could get, best first, by plan: Free toward spending answers and the paid features, Pro toward
 *  Ultra's, Ultra toward what it hasn't tried. */
export function candidates(kind: PageKind, plan: Plan): HintId[] {
  const ultra = plan === "ultra"
  switch (kind) {
    case "product":
      return ["similar", "watch"]
    case "article":
      return plan === "pro" || ultra ? ["listen", "summary"] : ["summary", "listen"]
    case "video":
      return ["video"]
    case "form":
      return ["templates"]
    case "event":
      return ["calendar", "remind"]
    case "stay":
      return ["remind", "calendar"]
  }
}

export interface HintsState {
  // When the hints first ran (ms): they stop 10 days later.
  start: number
  // Lines shown in all, and each hint's.
  shown: number
  shownIds: Partial<Record<HintId, number>>
  // The day (UTC, "2026-11-14") of the last line: one a day.
  lastDay: string
  // Features used (any way): never offered again.
  used: HintId[]
  // ✕ in a row (a tap resets it): two turn the lines off.
  closes: number
  // Off: by two ✕ in a row, or by the switch in Settings.
  off: boolean
  // Earlier use read from what's kept on the device (chats with Find similar or reminders, watches, templates, Listen).
  seeded: boolean
}

export const MAX_DAYS = 10
export const MAX_LINES = 5
export const MAX_CLOSES = 2
// A hint shown this often and never used isn't offered again.
export const MAX_EACH = 2

export const freshState = (now: number): HintsState => ({ start: now, shown: 0, shownIds: {}, lastDay: "", used: [], closes: 0, off: false, seeded: false })

export const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** Whether any line may show today at all. */
export function mayShow(state: HintsState, now: number): boolean {
  if (state.off || state.shown >= MAX_LINES) return false
  if (now - state.start > MAX_DAYS * 86_400_000) return false
  return state.lastDay !== dayOf(now)
}

/** The hint for this page, or null: the first candidate not used and not shown too often. */
export function pickHint(kind: PageKind | null, plan: Plan, state: HintsState, now: number): HintId | null {
  if (!kind || !mayShow(state, now)) return null
  return candidates(kind, plan).find((id) => !state.used.includes(id) && (state.shownIds[id] ?? 0) < MAX_EACH) ?? null
}

/** Whether the person's plan has the feature (or it's offered to them). */
export function hasFeature(id: HintId, plan: Plan): boolean {
  const needs = HINTS[id].needs
  if (needs === "ultra") return plan === "ultra"
  if (needs === "pro") return plan === "pro" || plan === "ultra"
  return true
}

export const afterShown = (s: HintsState, id: HintId, now: number): HintsState =>
  ({ ...s, shown: s.shown + 1, lastDay: dayOf(now), shownIds: { ...s.shownIds, [id]: (s.shownIds[id] ?? 0) + 1 } })
export const afterTap = (s: HintsState): HintsState => ({ ...s, closes: 0 })
export const afterClose = (s: HintsState): HintsState => {
  const closes = s.closes + 1
  return { ...s, closes, off: s.off || closes >= MAX_CLOSES }
}
export const afterUsed = (s: HintsState, id: HintId): HintsState => (s.used.includes(id) ? s : { ...s, used: [...s.used, id] })
