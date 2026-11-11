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
  // Build 98: which tenths of the part were heard (bit i: [i/10, (i+1)/10) of its audio, at least 70% of it), as the
  // device worked it out from what it played; seeking past a stretch leaves its tenths out. With `d`, the part's
  // length there (seconds). Devices before 98 send `s` alone.
  c?: number
  d?: number
}

/** Tenths of a part (build 98): heard coverage is kept per tenth, so listens add up and nothing counts twice. */
export const SLOTS = 10
export const FULL_SLOTS = (1 << SLOTS) - 1

const otidOf = (access: Access) => access.entitlement?.originalTransactionId ?? "none"
export const partMadeSubject = (access: Access, key: string) => `speakpart:${otidOf(access)}:${key}`
export const partHeardSubject = (access: Access, key: string) => `speakheard:${otidOf(access)}:${key}`
export const partSlotSubject = (access: Access, key: string, slot: number) => `speakslot:${otidOf(access)}:${key}:${slot}`

/** The reports as they came (anything else left out): at most MAX_ITEMS parts, each 0–600 s; one line per part. */
export function heardItems(raw: unknown): HeardItem[] {
  const out = new Map<string, HeardItem>()
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : []) {
    if (!item || typeof item !== "object") continue
    const { key, s, c, d } = item as { key?: unknown; s?: unknown; c?: unknown; d?: unknown }
    if (typeof key !== "string" || !KEY.test(key) || typeof s !== "number" || !Number.isFinite(s) || s <= 0) continue
    const was = out.get(key)
    const next: HeardItem = { key, s: Math.max(was?.s ?? 0, Math.min(600, s)) }
    const slots = (Number.isInteger(c) && (c as number) > 0 && (c as number) <= FULL_SLOTS ? (c as number) : 0) | (was?.c ?? 0)
    if (slots) next.c = slots
    const length = typeof d === "number" && Number.isFinite(d) && d > 0 ? Math.min(600, d) : was?.d
    if (length) next.d = length
    out.set(key, next)
  }
  return [...out.values()]
}

const slotCount = (mask: number) => {
  let n = 0
  for (let i = 0; i < SLOTS; i++) if (mask & (1 << i)) n++
  return n
}

/** Counts the reported seconds not counted before into the week's minutes (speak:tx); returns how many it added. */
export async function applyHeard(access: Access, raw: unknown): Promise<number> {
  const items = heardItems(raw)
  if (!items.length) return 0
  const ever = (subject: string): EverCounter => ({ subject, period: "ever", limit: null })
  const subjects = items.flatMap((i): EverCounter[] => [
    ever(partMadeSubject(access, i.key)),
    ever(partHeardSubject(access, i.key)),
    ...(i.c ? Array.from({ length: SLOTS }, (_, slot) => ever(partSlotSubject(access, i.key, slot))) : [])
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
    const length = made || Math.min(PART_MAX_S, Math.ceil(item.d ?? PART_MAX_S))
    let heard: number
    if (item.c) {
      // Build 98: the tenths heard on every listen and device so far, with this one's (a tenth is its own counter, set
      // once: two reports at once can't undo each other). The part counts as heard as far as they cover it; all ten
      // is the whole part, so listens in pieces add up to it, while a stretch skipped over never counts.
      let have = 0
      for (let slot = 0; slot < SLOTS; slot++) {
        if (n(partSlotSubject(access, item.key, slot)) > 0) have |= 1 << slot
        else if (item.c & (1 << slot)) writes.push({ ...ever(partSlotSubject(access, item.key, slot)), amount: 1 })
      }
      const slots = slotCount(have | item.c)
      // Not all ten: kept at least 2 s short of the part, so it isn't taken as heard to its end (that allowance of a
      // second is for the clocks of devices before 98); the rest counts when the stretch missing is heard.
      heard = slots === SLOTS ? length : Math.max(0, Math.min(Math.floor((slots * length) / SLOTS), length - 2))
    } else {
      heard = Math.round(Math.min(item.s, length))
    }
    const delta = Math.max(0, Math.min(heard, length) - counted)
    if (!delta) continue
    writes.push({ subject: partHeardSubject(access, item.key), period: "ever", limit: null, amount: delta })
    added += delta
  }
  if (!writes.length) return 0
  if (added) writes.push({ subject: `speak:tx:${otidOf(access)}`, period: "week", limit: null, amount: added })
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

/**
 * Build 98 release (the owner: «после генерации аудио… сразу ставить такую галочку, а не только после прослушки»): a
 * text whose every part has been made here is "already voiced" even before it's all been heard, and the devices say
 * what a replay costs. Minutes still count what's heard (2026-11-09), so a replay of such a text charges only the
 * stretches never heard: `left`, in seconds. The text's made and heard seconds are kept by its id too, so a device
 * that can't work out its parts (written for the ear on another device) still answers; both only ever grow.
 */
export const textMadeSubject = (access: Access, id: string) => `speakmadetext:${otidOf(access)}:${id}`
export const textHeardSubject = (access: Access, id: string) => `speakheardtext:${otidOf(access)}:${id}`

export interface TextStates {
  // Every part heard: a replay is free.
  voiced: string[]
  // Every part made, not all of it heard: a replay charges `left` seconds, no more.
  made: Array<{ id: string; left: number }>
}

/** Which of `texts` are voiced or made for this subscription; what's found by their parts is kept by their ids. */
export async function textStates(access: Access, texts: HeardText[]): Promise<TextStates> {
  if (!texts.length) return { voiced: [], made: [] }
  const ever = (subject: string): EverCounter => ({ subject, period: "ever", limit: null })
  const keys = [...new Set(texts.flatMap((t) => t.keys))]
  const states = await peek([
    ...texts.flatMap((t) => [ever(textVoicedSubject(access, t.id)), ever(textMadeSubject(access, t.id)), ever(textHeardSubject(access, t.id))]),
    ...keys.flatMap((key) => [ever(partMadeSubject(access, key)), ever(partHeardSubject(access, key))])
  ])
  const n = (subject: string) => states.find((c) => c.subject === subject)?.n ?? 0
  const out: TextStates = { voiced: [], made: [] }
  const kept: EverCounter[] = []
  const grow = (subject: string, value: number) => {
    const more = Math.round(value) - n(subject)
    if (more > 0) kept.push({ ...ever(subject), amount: more })
  }
  for (const text of texts) {
    if (n(textVoicedSubject(access, text.id)) > 0) {
      out.voiced.push(text.id)
      continue
    }
    if (!text.keys.length) {
      // Asked by its id alone: as it was when last asked with its parts.
      const made = n(textMadeSubject(access, text.id))
      if (made > 0) out.made.push({ id: text.id, left: Math.max(1, made - n(textHeardSubject(access, text.id))) })
      continue
    }
    // Every part made here (a part made before build 92 isn't on record: not made).
    const parts = text.keys.map((key) => ({ made: n(partMadeSubject(access, key)), counted: n(partHeardSubject(access, key)) }))
    if (!parts.every((p) => p.made > 0)) continue
    // Heard to within a second of its length (as applyHeard counts it): the part is whole.
    const whole = (p: { made: number; counted: number }) => p.counted > 0 && p.counted >= p.made - 1
    if (parts.every(whole)) {
      out.voiced.push(text.id)
      kept.push({ ...ever(textVoicedSubject(access, text.id)), amount: 1 })
      continue
    }
    const made = parts.reduce((sum, p) => sum + p.made, 0)
    const heard = parts.reduce((sum, p) => sum + (whole(p) ? p.made : Math.min(p.counted, p.made)), 0)
    out.made.push({ id: text.id, left: made - heard })
    grow(textMadeSubject(access, text.id), made)
    grow(textHeardSubject(access, text.id), heard)
  }
  if (kept.length) await consume(kept)
  return out
}

/** Which of `texts` are voiced for this subscription (every part heard). */
export async function voicedTexts(access: Access, texts: HeardText[]): Promise<string[]> {
  return (await textStates(access, texts)).voiced
}
