// Pro's weekly tastes of Ultra (2.8, В7.4, the owner's idea): a few minutes of Listen and a full Find similar a week,
// numbers from the server (status.taste; a taste the server has off isn't there). One line wherever a taste shows: what's
// left this week, and «In Ultra: …» that opens the plans on that feature, no window of its own.

import type { VNode } from "preact"

import { t } from "../shared/i18n"
import { DEFAULT_PLAN_FACTS } from "../shared/plan"
import type { PlanFacts, StatusInfo, Usage } from "../shared/types"
import type { PlansFeature } from "./Plans"

/** The taste of `feature` this week, when this subscriber has one (Pro only: Ultra has the real thing). */
export function tasteOf(status: StatusInfo | null | undefined, feature: PlansFeature): Usage | null {
  if (status?.plan !== "pro") return null
  return (feature === "listen" ? status.taste?.speak : status.taste?.similar) ?? null
}

/** What's left of a taste: seconds of Listen, or full searches. */
export function tasteLeft(usage: Usage | null | undefined): number {
  return usage ? Math.max(0, usage.limit - usage.used) : 0
}

/** «In Ultra: 30 minutes a week» / «In Ultra: 10 full searches a week». */
export function ultraLine(feature: PlansFeature, facts: PlanFacts | undefined): string {
  const f = facts ?? DEFAULT_PLAN_FACTS
  return feature === "listen" ? t("tasteUltraListen", String(Math.round(f.speakWeeklySeconds / 60))) : t("tasteUltraSimilar", String(f.similarWeekly))
}

/** The counter: «Listen in Pro: 3 of 5 min left this week» / «Full search in Pro: 1 of 1 left this week». */
export function tasteCount(feature: PlansFeature, usage: Usage): string {
  const left = tasteLeft(usage)
  return feature === "listen"
    ? t("tasteListenLeft", String(Math.floor(left / 60)), String(Math.round(usage.limit / 60)))
    : t("tasteSimilarLeft", String(left), String(usage.limit))
}

/** The sheet's line on top when a taste is used up: what's used and the day it's back. */
export function tasteUsedLead(feature: PlansFeature, usage: Usage | null | undefined, lang: string): string {
  const day = usage?.resetsAt ? new Date(usage.resetsAt).toLocaleDateString(lang, { weekday: "long" }) : ""
  return feature === "listen"
    ? t("tasteListenUsed", String(Math.round((usage?.limit ?? 0) / 60)), day)
    : t("tasteSimilarUsed", day)
}

export function TasteLine({ feature, usage, facts, onUltra }: {
  feature: PlansFeature
  usage: Usage
  facts: PlanFacts | undefined
  onUltra: () => void
}): VNode {
  return (
    <p class="cf-taste" data-taste={feature}>
      <span>{tasteCount(feature, usage)}</span>
      <button type="button" class="cf-link" onClick={onUltra}>{ultraLine(feature, facts)} ›</button>
    </p>
  )
}
