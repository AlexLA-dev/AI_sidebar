// Page watch (2.5): the messages between the panel or the page and the background, and the counters.

import type { Structured } from "./extract.ts"
import type { Watch, WatchKind, WatchRule, WatchSite, WatchSource } from "./types.ts"

/** What the panel knows when someone asks to be told about a change: read from the live page. */
export interface WatchDraft {
  url: string
  title: string
  // The selection ("" for the whole page) and what the detector made of it.
  selection: string
  what: WatchKind
  condition: string
  // Up to 1 500 characters of the page's text around the selection, for the plan.
  around: string
  before?: string
  after?: string
  // Prices and stock the live page states in its markup.
  candidates: Structured
  // The value as the live page shows it now (the digest for the whole page).
  value: string
  // The live page's text, for "page" watches (kept on this device to show the AI what changed).
  text?: string
}

/** Ready to save: the plan, and whether the background could read the page itself. */
export interface WatchPrepared {
  ok: true
  what: WatchKind
  source: WatchSource
  rule: WatchRule
  label: string
  site: WatchSite
  // The background read the same value without the person (a fetch from this device).
  readable: boolean
  // The plan came from the device's own rules (the AI wasn't reachable).
  local: boolean
}

export type WatchRequest =
  | { type: "watchPrepare"; draft: WatchDraft; how: WatchHow }
  | { type: "watchSave"; draft: WatchDraft; prepared: WatchPrepared; how: WatchHow; live: boolean }
  | { type: "watchList" }
  | { type: "watchCancel"; id: string; via: "panel" | "list" }
  // New words for what a watch waits for, from the list: the rule is planned again; what's read stays.
  | { type: "watchEdit"; id: string; condition: string }
  // The page the person has open: which watches it has, then the values read from it.
  | { type: "watchForUrl"; url: string }
  | { type: "watchLive"; url: string; values: Record<string, string | null>; text?: string }

/** Where a watch was made: the eye by a selection, or "Come back later…". */
export type WatchHow = "bubble" | "later"

/**
 * A page watch step for the counters: the "use" kind with f "watch", in the analytics registry's words
 * (src/shared/usage.ts on claude/usage-events, feature-map.md §1.5). No address, no text, no value.
 */
export interface WatchStep {
  a: "create" | "alert" | "stop" | "error" | "daily"
  via?: WatchHow | "panel" | "app" | "notif" | "list" | "auto"
  what?: WatchKind
  site?: WatchSite
  mode?: "bg" | "live"
  reason?: "blocked" | "login" | "gone"
  checks?: number
  active?: number
}

/** How many watches can check at once: the owner's limit, Free and paid. */
export const WATCH_LIMIT = { free: 5, paid: 20 } as const

/** The watches of one page, for the live read: where each value sits. */
export type WatchSpec = Pick<Watch, "id" | "what" | "source" | "before" | "after">

/** The site's kind from its address alone, before the AI says (and when it can't): for the counters. */
export function siteOf(host: string): WatchSite {
  const h = host.toLowerCase()
  if (/greenhouse|lever\.co|workday|myworkdayjobs|smartrecruiters|ashbyhq|jobs?\.|careers?\.|indeed|linkedin|hh\.ru|stepstone/.test(h)) return "jobs"
  if (/\.gov(\.|$)|\.gouv\.|\.gob\.|\.gov\.uk$|\.bund\.de$|gosuslugi|\.mil$|uscis|europa\.eu/.test(h)) return "gov"
  if (/ticket|eventbrite|livenation|eventim|concert|festival|marathon|kassir|afisha/.test(h)) return "tickets"
  if (/news|\.edu(\.|$)|\.ac\.|univ|blog|times|post|herald|bbc|cnn|reuters/.test(h)) return "news"
  if (/shop|store|amazon|ebay|walmart|target|bestbuy|ikea|zara|hm\.com|nike|adidas|zalando|otto|mediamarkt|aliexpress|etsy|coupang|rakuten|apple\.com|myshopify|ozon|wildberries|market/.test(h)) return "shop"
  return "other"
}
