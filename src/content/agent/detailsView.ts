// How «Мои данные» are shown (2.7.1), apart from the component so it can be tested without a page.
//
// The order they're shown in (2.7.1, the owner on build 121: they were listed in the order they were added —
// Last name, E-mail, City, Country…). The same everywhere: the saved rows and the add menu, in the panel and in the app
// (FormKeyName.keys in AgentApp.swift). Name, phone and e-mail; then the address from the street to the country; the
// birth date; then work and the website. A person's own details (facts: shoe size, gender…) last, by their names.
// Only how they're shown: the store and the agent's reading of it keep their own order.

import type { FormEntry, FormKey } from "../../shared/agent/formdata.ts"

export const FIELD_ORDER: FormKey[] = [
  "name.full", "name.given", "name.family", "name.latin", "name.phonetic",
  "phone", "email",
  "address.line", "address.apartment", "address.city", "address.region", "address.postal", "address.country",
  "birthDate",
  "company", "jobTitle", "website",
  "fact"
]

const rank = (key: string): number => {
  const at = FIELD_ORDER.indexOf(key as FormKey)
  return at < 0 ? FIELD_ORDER.length : at
}

/** The entries in that order; facts and any key not known here last, by their names (`lang`'s alphabet). */
export function orderedEntries<T extends Pick<FormEntry, "key" | "label" | "updatedAt">>(entries: T[], lang?: string): T[] {
  return [...entries].sort((a, b) => {
    const r = rank(a.key) - rank(b.key)
    if (r) return r
    if (rank(a.key) >= FIELD_ORDER.indexOf("fact")) {
      const byName = (a.label || a.key).localeCompare(b.label || b.key, lang, { sensitivity: "base" })
      if (byName) return byName
    }
    return a.updatedAt - b.updatedAt
  })
}

/**
 * The line under the iCloud switch (2.7.1, the owner on 121: the one question vanished unanswered and sync stayed off):
 * only on this device until the person turns it on (never by default), syncing while it's being turned on, then what
 * the last sync did — when it went through, or why it didn't. `when`: "now" within 90 s, else the time it went through.
 */
export type SyncLine = { line: "local" | "syncing" | "noAccount" | "failed" | "private" } | { line: "synced"; when: "now" | number }

export function syncState(d: { icloud?: boolean; syncedAt?: number; syncError?: string }, syncing: boolean, now = Date.now()): SyncLine {
  if (d.icloud !== true) return { line: "local" }
  if (syncing) return { line: "syncing" }
  if (d.syncError) return { line: d.syncError === "no_account" ? "noAccount" : "failed" }
  if (!d.syncedAt) return { line: "private" }
  return { line: "synced", when: now - d.syncedAt < 90_000 ? "now" : d.syncedAt }
}
