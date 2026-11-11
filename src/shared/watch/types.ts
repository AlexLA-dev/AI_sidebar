// Page watch (2.5): one watch, as kept in the extension's storage on the device that checks it (no iCloud:
// the checks run in this Safari). The eye in the bubble and "Notify me when it changes" make one.

import type { WatchWhat } from "./detect.ts"

export type WatchKind = WatchWhat | "page"

/** Where the value is read on each check (the AI picks it once, when the watch is made). */
export type WatchSource = "ld-price" | "ld-stock" | "meta-price" | "meta-stock" | "text" | "page"

/** When a change counts: decided once; only "ask" calls the AI again, and only when the value changed. */
export interface WatchRule {
  kind: "change" | "below" | "above" | "in-stock" | "contains" | "gone" | "ask"
  n?: number
  words?: string[]
}

/** A watch's site, for the counters (never the address). */
export type WatchSite = "shop" | "jobs" | "news" | "gov" | "tickets" | "other"

export interface Watch {
  id: string
  url: string
  host: string
  title: string
  what: WatchKind
  // What is watched, a few words for the list ("Size 42", "Price of the mug").
  label: string
  // The person's own words: "when size 42 is back".
  condition: string
  // 2.6 (97), the owner: «мне некуда приписать себе заметку, что именно я хочу проверить». Their own note to
  // themselves, optional ("check it fits the desk"): the AI never reads it; the notification says it.
  note?: string
  source: WatchSource
  // Text right before and after the value on the page (source "text").
  before?: string
  after?: string
  // The last value seen (for "page", a digest of the page's text).
  value: string
  rule: WatchRule
  // "bg": the background can read the page; "live": only when the person has it open.
  mode: "bg" | "live"
  site: WatchSite
  createdAt: number
  checkedAt: number
  checks: number
  failures: number
  // When the condition came true: the notification went out and the checks stop.
  metAt?: number
  metValue?: string
}

export const WATCH_STORAGE = {
  watches: "cf:watches",
  // The text of "page" watches, to show the AI what changed.
  texts: "cf:watchTexts",
  // Checks since the last daily count (for the counters: how many, never what).
  tally: "cf:watchTally"
} as const

declare const __WATCH_EVERY_S__: number | undefined

/** A page is checked at most this often: 15 minutes (a test build sets less, CF_WATCH_EVERY_S). */
export const WATCH_EVERY_MS = (typeof __WATCH_EVERY_S__ === "number" ? __WATCH_EVERY_S__ : 900) * 1000
/** The background lives about 30 s after it wakes; a round stops well before. */
export const WATCH_ROUND_MS = 22_000
/** After this many reads that found nothing, the background gives the page to the live path. */
export const WATCH_FAILS_TO_LIVE = 3
