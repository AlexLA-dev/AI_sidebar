import { consume, peek, type Counter, type EverCounter } from "./db.mts"
import type { Access } from "./plan.mts"

/**
 * Read aloud's minutes count what's heard (build 92, the owner: «За 30 секунд аудио должно списываться 30 сек, а не 43.
 * Остальное это наша экономика.»). The devices report, per part, how many seconds of it were heard (the part's key is
 * sha256 of "v1|<language>|<text>", the same in the panel, the app and here). A part counts once per subscription, the
 * first time its seconds are heard, on any device: heard again (this device's copy, iCloud, another device) it adds
 * nothing. A report can't count more than the part's audio (as made here; a part made before this was recorded counts
 * at most PART_MAX_S), and a report sent twice changes nothing.
 */
const KEY = /^[0-9a-f]{64}$/
export const PART_MAX_S = 60
const MAX_ITEMS = 80

export interface HeardItem {
  key: string
  s: number
}

const otidOf = (access: Access) => access.entitlement?.originalTransactionId ?? "none"
export const partMadeSubject = (access: Access, key: string) => `speakpart:${otidOf(access)}:${key}`
export const partHeardSubject = (access: Access, key: string) => `speakheard:${otidOf(access)}:${key}`

/** The reports as they came (anything else left out): at most MAX_ITEMS parts, each 0–600 s; one line per part. */
export function heardItems(raw: unknown): HeardItem[] {
  const out = new Map<string, number>()
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : []) {
    if (!item || typeof item !== "object") continue
    const { key, s } = item as { key?: unknown; s?: unknown }
    if (typeof key !== "string" || !KEY.test(key) || typeof s !== "number" || !Number.isFinite(s) || s <= 0) continue
    out.set(key, Math.max(out.get(key) ?? 0, Math.min(600, s)))
  }
  return [...out].map(([key, s]) => ({ key, s }))
}

/** Counts the reported seconds not counted before into the week's minutes (speak:tx); returns how many it added. */
export async function applyHeard(access: Access, raw: unknown): Promise<number> {
  const items = heardItems(raw)
  if (!items.length) return 0
  const subjects = items.flatMap((i): EverCounter[] => [
    { subject: partMadeSubject(access, i.key), period: "ever", limit: null },
    { subject: partHeardSubject(access, i.key), period: "ever", limit: null }
  ])
  const states = await peek(subjects)
  const n = (subject: string) => states.find((c) => c.subject === subject)?.n ?? 0
  const writes: Array<Counter | EverCounter> = []
  let added = 0
  for (const item of items) {
    const made = n(partMadeSubject(access, item.key))
    const counted = n(partHeardSubject(access, item.key))
    // Heard to its end before, give or take a second (build 94): hearing it again adds nothing. A device's clock and
    // rounding can make a replay report a little more than the first time; Listen says a replay is free, so it is.
    if (made && counted > 0 && counted >= made - 1) continue
    const delta = Math.max(0, Math.round(Math.min(item.s, made || PART_MAX_S)) - counted)
    if (!delta) continue
    writes.push({ subject: partHeardSubject(access, item.key), period: "ever", limit: null, amount: delta })
    added += delta
  }
  if (!added) return 0
  writes.push({ subject: `speak:tx:${otidOf(access)}`, period: "week", limit: null, amount: added })
  await consume(writes)
  return added
}

/** A part's audio as made here, so its heard seconds can't be reported higher than it is. */
export async function recordPartMade(access: Access, key: string, seconds: number): Promise<void> {
  if (!KEY.test(key) || seconds <= 0) return
  const subject = partMadeSubject(access, key)
  const [state] = await peek([{ subject, period: "ever", limit: null }])
  const more = Math.ceil(seconds) - (state?.n ?? 0)
  if (more > 0) await consume([{ subject, period: "ever", limit: null, amount: more }])
}
