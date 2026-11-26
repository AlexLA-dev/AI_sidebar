// «Start as a new user» (2.7): a row in the app's Settings in TestFlight and debug builds only (Setup.swift
// NewUserPreview; the App Store's app never shows it, so never sends the stamp). The owner couldn't see the changed
// first run as a new user: deleting the app and installing it again brought his chats and settings back. When he
// starts it, the app's side hands the panel a stamp (with the settings), and the panel's own first run starts over
// once for that stamp: the guided first request and the tour, the hints, the consent, and since 2.8.1 a new install's
// place in the hint coordinator and the first-open test. Chats, notes, collections, spaces, settings, templates and the
// plan stay as they are.

import { COACH_KEY, freshCoach } from "../content/coach/rules.ts"
import { INDEX_KEY as OPENINGS_KEY, recordKey as openingKey } from "../content/openings.ts"
import { DROPPED_KEY } from "./droppedAsks.ts"
import { INSERT_STORAGE } from "./insert.ts"
import { STORAGE } from "./types.ts"

/** What a new install hasn't seen or decided yet (the page hints' state is src/content/pagehints/store.ts's key). */
export const FIRST_RUN_KEYS: readonly string[] = [
  STORAGE.tourSeen, STORAGE.consent, STORAGE.noteHint, STORAGE.selHint, "cf:pageHints", INSERT_STORAGE.tipSeen, INSERT_STORAGE.rewriteHintSeen,
  // How many × of the translate offer were told where it went (content/translate/hiddenSites.ts TOLD_KEY).
  "cf:trHideTold",
  // 2.8: the hint coordinator's state (src/content/coach/state.ts COACH_KEY): its day 1 and rungs start over too.
  COACH_KEY,
  // 2.8.1 (F7): the earlier prompts' answers: the organize cards (consent, the messy list, tags), the translate pill's ×
  // on sites (content/translate/hiddenSites.ts) and the «translate this site always?» question (autoSites.ts). The sites
  // set to translate always (cf:trAuto) are a setting and stay.
  STORAGE.orgCards, "cf:trHidden", "cf:trAutoAsked",
  // The day the ✦ was last reported (App.tsx FAB_SHOWN_KEY): a new install's first `fab.shown` goes out again.
  "cf:fabShownDay",
  // The director's review of #268 (point 5): the selection icons' tip (content/ux/SelTip.tsx), the Pro offer card's
  // count for those who ran out before (STORAGE.offerCard), a rating moment waiting from the first day
  // (background/sync.ts REVIEW_WAITING), the questions given up on (droppedAsks.ts) and the panel's stored openings
  // (content/openings.ts: the list here, each record below): a new install has none of them.
  "cf:selIconsTip", STORAGE.offerCard, "cf:reviewWaiting", DROPPED_KEY, OPENINGS_KEY
]

/** The last stamp the panel's first run started over for (ms). */
export const FIRST_RUN_STAMP = "cf:firstRunReset"

export interface KeyStore {
  get(key: string): Promise<Record<string, unknown>>
  remove(keys: string[]): Promise<void>
  set(items: Record<string, unknown>): Promise<void>
}

/**
 * Starts the panel's first run over for a stamp not seen before; true when it did. 2.8.1 (F7, the director): as a new
 * install, whatever stays — the coordinator's state is written fresh and marked new (`armed`, already seeded), so chats or
 * sites kept from before don't make the tester someone updated from 2.7 (never in an arm, never on day 1). The install's
 * id stays, so its arm (the id's last digit, src/shared/variant.ts) is the one it had.
 */
export async function firstRunAgain(stamp: unknown, store: KeyStore, now = Date.now()): Promise<boolean> {
  if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) return false
  const done = Number((await store.get(FIRST_RUN_STAMP))[FIRST_RUN_STAMP] ?? 0)
  if (stamp <= done) return false
  const openings = (await store.get(OPENINGS_KEY))[OPENINGS_KEY]
  const records = openings && typeof openings === "object" ? Object.keys(openings).map(openingKey) : []
  await store.remove([...FIRST_RUN_KEYS, ...records])
  // As a new install has it (background/index.ts markNewSeen): no «New in 2.7» card, the other hints not shown yet.
  await store.set({ [STORAGE.hintsSeen]: ["new27"], [COACH_KEY]: { ...freshCoach(now), seeded: true, armed: true }, [FIRST_RUN_STAMP]: stamp })
  return true
}
