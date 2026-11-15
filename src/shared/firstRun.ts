// «Start as a new user» (2.7): a row in the app's Settings in TestFlight and debug builds only (Setup.swift
// NewUserPreview; the App Store's app never shows it, so never sends the stamp). The owner couldn't see the changed
// first run as a new user: deleting the app and installing it again brought his chats and settings back. When he
// starts it, the app's side hands the panel a stamp (with the settings), and the panel's own first run starts over
// once for that stamp: the guided first request and the tour, the hints, the consent. Chats, notes, collections,
// spaces, settings, templates and the plan stay as they are.

import { INSERT_STORAGE } from "./insert.ts"
import { STORAGE } from "./types.ts"

/** What a new install hasn't seen or decided yet (the page hints' state is src/content/pagehints/store.ts's key). */
export const FIRST_RUN_KEYS: readonly string[] = [
  STORAGE.tourSeen, STORAGE.consent, STORAGE.noteHint, STORAGE.selHint, "cf:pageHints", INSERT_STORAGE.tipSeen, INSERT_STORAGE.rewriteHintSeen
]

/** The last stamp the panel's first run started over for (ms). */
export const FIRST_RUN_STAMP = "cf:firstRunReset"

export interface KeyStore {
  get(key: string): Promise<Record<string, unknown>>
  remove(keys: string[]): Promise<void>
  set(items: Record<string, unknown>): Promise<void>
}

/** Starts the panel's first run over for a stamp not seen before; true when it did. */
export async function firstRunAgain(stamp: unknown, store: KeyStore): Promise<boolean> {
  if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) return false
  const done = Number((await store.get(FIRST_RUN_STAMP))[FIRST_RUN_STAMP] ?? 0)
  if (stamp <= done) return false
  await store.remove([...FIRST_RUN_KEYS])
  // As a new install has it (background/index.ts markNewSeen): no «New in 2.7» card, the other hints not shown yet.
  await store.set({ [STORAGE.hintsSeen]: ["new27"], [FIRST_RUN_STAMP]: stamp })
  return true
}
