// What a watch waits for, in one line for the lists (the panel's Reminders and the app's): the owner on build 75,
// "I can't even see what price I set". The person's own words with the value as it is now; the words the panel
// started from ("when the price changes (now 40 €)") come back with today's value instead of the one at the start.

import { t, uiLanguage, type MessageKey } from "../i18n"
import { shownValue } from "./compare"
import type { Watch } from "./types"

const STARTED: Partial<Record<Watch["what"], MessageKey>> = {
  price: "watchCondPrice", stock: "watchCondStock", date: "watchCondDate", status: "watchCondStatus"
}

/** The value as a person reads it ("34.50 EUR", "In stock"), in the panel's language. */
export const shown = (value: string, lang?: string): string =>
  shownValue(value, lang ?? uiLanguage(), { inStock: t("watchInStock"), outOfStock: t("watchOutOfStock") })

/** "when the price drops below 35 € · now 40 €", or "when the price changes (now 40 €)". */
export function conditionLine(w: Pick<Watch, "what" | "condition" | "value" | "label">, lang?: string): string {
  const condition = w.condition.trim() || w.label
  if (w.what === "page") return condition
  const now = w.value ? shown(w.value, lang) : ""
  // Any of the starting words (the plan may have read the value as another kind than the panel started with).
  for (const key of Object.values(STARTED)) {
    const [pre, post] = t(key, "\u0001").split("\u0001")
    if (pre !== undefined && post !== undefined && condition.startsWith(pre) && condition.endsWith(post) && condition.length > pre.length + post.length) {
      return now ? t(key, now) : condition
    }
  }
  return now ? `${condition} · ${t("watchRowNow", now)}` : condition
}
