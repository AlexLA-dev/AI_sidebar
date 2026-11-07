// Page watch (2.5): did the watched value change, and is that what the person asked for? Most conditions are
// decided here, without the AI ("when it changes", "below 100", "back in stock"); the AI is asked only for the
// person's own words ("when size 42 shows up"), and only after the value changed.

import { isOutOfStock } from "./detect.ts"
import { parseNumber } from "./extract.ts"
import type { WatchKind, WatchRule } from "./types.ts"

const fold = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()

/** Two reads say the same: prices by their number, stock by in or out, anything else by its words. */
export function sameValue(what: WatchKind, a: string, b: string): boolean {
  if (what === "price") {
    const x = parseNumber(a)
    const y = parseNumber(b)
    if (x !== null && y !== null) return x === y
  }
  if (what === "stock" && isOutOfStock(a) !== isOutOfStock(b)) return false
  return fold(a) === fold(b)
}

export type Verdict = "met" | "not-met" | "ask"

/** After a change: met, not met, or the AI decides (the person's own words). */
export function verdict(rule: WatchRule, what: WatchKind, before: string, now: string): Verdict {
  switch (rule.kind) {
    case "change":
      return "met"
    case "below":
    case "above": {
      const n = parseNumber(now)
      if (n === null || rule.n === undefined) return "ask"
      return (rule.kind === "below" ? n < rule.n : n > rule.n) ? "met" : "not-met"
    }
    case "in-stock":
      return isOutOfStock(now) ? "not-met" : "met"
    case "contains":
    case "gone": {
      const words = (rule.words ?? []).map(fold).filter(Boolean)
      if (!words.length) return "ask"
      const has = words.some((w) => fold(now).includes(w))
      return (rule.kind === "contains" ? has : !has) ? "met" : "not-met"
    }
    default:
      return what === "page" || rule.kind === "ask" ? "ask" : "met"
  }
}

/** A rule from the condition without the AI (when it isn't reachable): the plain cases only. */
export function fallbackRule(what: WatchKind, value: string, condition: string): WatchRule {
  const c = condition.toLowerCase()
  const n = parseNumber(c)
  if (what === "price" && n !== null) {
    if (/(below|under|less|cheaper|ниже|меньше|дешевле|нижче|менше|unter|weniger|moins|sous|menos|debajo|meno|sotto|abaixo|以下|未満|이하|미만|低于|以下|低於|أقل|أدنى|تحت|dưới|thấp hơn|rẻ hơn|ít hơn)/.test(c)) return { kind: "below", n }
    if (/(above|over|more|выше|больше|вище|більше|über|mehr|plus|más|più|acima|以上|이상|高于|高於|أعلى|أكثر|فوق|cao hơn|nhiều hơn|trên)/.test(c)) return { kind: "above", n }
  }
  if (what === "stock" && isOutOfStock(value)) return { kind: "in-stock" }
  return { kind: "change" }
}

/**
 * A value as a person reads it, for the notification and the list: a price from a page's markup ("34.50 EUR")
 * in their language's currency format, schema.org stock in words; text as the page wrote it.
 */
export function shownValue(value: string, lang: string, words: { inStock: string; outOfStock: string }): string {
  const v = value.trim()
  const money = /^(\d+(?:\.\d+)?)\s([A-Z]{3})$/.exec(v)
  if (money) {
    try {
      return new Intl.NumberFormat(lang, { style: "currency", currency: money[2] }).format(Number(money[1]))
    } catch {
      return v
    }
  }
  if (/^(InStock|OutOfStock|SoldOut|PreOrder|BackOrder|Discontinued|LimitedAvailability|InStoreOnly|OnlineOnly)$/i.test(v)) {
    return isOutOfStock(v) ? words.outOfStock : words.inStock
  }
  return v
}

