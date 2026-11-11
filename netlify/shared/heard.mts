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

/**
 * "Already voiced" (build 95, the owner on 94: «Ничего такого не вижу»; promised on 93: «и так на любом вашем
 * устройстве»): a text is voiced for the subscription once every part of it has been counted here to within a second
 * of its length, heard on any device, in one go or over several. Hearing it again then adds nothing to the week's
 * minutes. The devices ask about the texts they show by the text's id (src/shared/voiced.ts) and, when they can work
 * them out, its parts' keys; a text found voiced is kept as such (speakvoiced), so its id alone answers from then on,
 * on every device.
 */
const TEXT_ID = /^[0-9a-f]{16}$/
const MAX_TEXTS = 40
const MAX_TEXT_KEYS = 80
const MAX_KEYS = 400

export interface HeardText {
  id: string
  keys: string[]
}

export const textVoicedSubject = (access: Access, id: string) => `speakvoiced:${otidOf(access)}:${id}`

/** The texts as they came (anything else left out): at most MAX_TEXTS, their keys at most MAX_TEXT_KEYS each and
 *  MAX_KEYS in all (a text past that is asked by its id alone). */
export function heardTexts(raw: unknown): HeardText[] {
  const out = new Map<string, string[]>()
  let total = 0
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_TEXTS) : []) {
    if (!item || typeof item !== "object") continue
    const { id, keys } = item as { id?: unknown; keys?: unknown }
    if (typeof id !== "string" || !TEXT_ID.test(id) || out.has(id)) continue
    let list = [...new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string" && KEY.test(k)) : [])]
    if (list.length > MAX_TEXT_KEYS || total + list.length > MAX_KEYS) list = []
    total += list.length
    out.set(id, list)
  }
  return [...out].map(([id, keys]) => ({ id, keys }))
}

/** Which of `texts` are voiced for this subscription; the ones found voiced by their parts are kept as voiced. */
export async function voicedTexts(access: Access, texts: HeardText[]): Promise<string[]> {
  if (!texts.length) return []
  const keys = [...new Set(texts.flatMap((t) => t.keys))]
  const states = await peek([
    ...texts.map((t): EverCounter => ({ subject: textVoicedSubject(access, t.id), period: "ever", limit: null })),
    ...keys.flatMap((key): EverCounter[] => [
      { subject: partMadeSubject(access, key), period: "ever", limit: null },
      { subject: partHeardSubject(access, key), period: "ever", limit: null }
    ])
  ])
  const n = (subject: string) => states.find((c) => c.subject === subject)?.n ?? 0
  const voiced: string[] = []
  const kept: EverCounter[] = []
  for (const text of texts) {
    if (n(textVoicedSubject(access, text.id)) > 0) {
      voiced.push(text.id)
      continue
    }
    // Every part made here and heard to within a second of its length (as applyHeard counts it).
    const whole = text.keys.length > 0 && text.keys.every((key) => {
      const made = n(partMadeSubject(access, key))
      const counted = n(partHeardSubject(access, key))
      return made > 0 && counted > 0 && counted >= made - 1
    })
    if (!whole) continue
    voiced.push(text.id)
    kept.push({ subject: textVoicedSubject(access, text.id), period: "ever", limit: null, amount: 1 })
  }
  if (kept.length) await consume(kept)
  return voiced
}
