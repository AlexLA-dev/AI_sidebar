// Read aloud, what was heard of each part (build 98, the owner on 97: «не вижу галочек… Возможно, она не появляется,
// если проматываю?»). Not the seconds played but the stretches of the part played: a seek forward leaves a stretch
// out, hearing a stretch again adds nothing, and listens in pieces add up: on the device exactly (each device keeps
// what it heard of a part over its listens), and over devices on the server (netlify/shared/heard.mts joins the
// part's tenths). The app has the same rules (SpeechText.swift HeardCoverage; tests/speech-parity checks they agree).

import { speechSeconds } from "./speech.ts"

/** A part's audio in tenths: bit i is [i/10, (i+1)/10) of it. */
export const SLOTS = 10
export const FULL = (1 << SLOTS) - 1
/** A tenth counts as heard when this much of it was played. Two listens that meet inside a tenth (a part heard in two
 *  pieces, here and on another device) always give one of them this much of it; a skip of most of a tenth leaves it out. */
const SLOT_SHARE = 0.4
/** Stretches closer than this join (the player's clock moves in ticks). */
const JOIN = 0.05
/** For the tenths: a gap this short between two stretches isn't a skip (coming back to about where it stopped). */
const CLOSE = 0.75

/** Stretches of one part heard, in its own seconds: sorted, none overlapping. */
export type Ranges = Array<[number, number]>

/** `ranges` with [from, to) heard too. */
export function addRange(ranges: Ranges, from: number, to: number): Ranges {
  if (!(to > from)) return ranges
  let start = from
  let end = to
  const out: Ranges = []
  for (const [a, b] of ranges) {
    if (b < start - JOIN || a > end + JOIN) out.push([a, b])
    else {
      start = Math.min(start, a)
      end = Math.max(end, b)
    }
  }
  out.push([start, end])
  return out.sort((x, y) => x[0] - y[0])
}

/** Two lists of stretches as one (what a device heard of a part over its listens). */
export function mergeRanges(a: Ranges, b: Ranges): Ranges {
  return b.reduce((out, [from, to]) => addRange(out, from, to), a)
}

/** Seconds of the part heard (each stretch once). */
export function coveredSeconds(ranges: Ranges): number {
  return Math.round(ranges.reduce((n, [a, b]) => n + (b - a), 0) * 10) / 10
}

/** The part's tenths heard, as bits (`length`: its audio in seconds). */
export function slotMask(ranges: Ranges, length: number): number {
  if (!(length > 0)) return 0
  const width = length / SLOTS
  // Short gaps closed first: coming back to about where it stopped isn't skipping.
  const closed: Ranges = []
  for (const [a, b] of ranges) {
    const last = closed.at(-1)
    if (last && a - last[1] < CLOSE) last[1] = Math.max(last[1], b)
    else closed.push([a, b])
  }
  let mask = 0
  for (let slot = 0; slot < SLOTS; slot++) {
    const from = slot * width
    const to = from + width
    let heard = 0
    for (const [a, b] of closed) heard += Math.max(0, Math.min(b, to) - Math.max(a, from))
    if (heard >= SLOT_SHARE * width - 1e-9) mask |= 1 << slot
  }
  return mask
}

/**
 * The stretch [from, to) of the whole text's clock, laid on its parts: `starts[i]` is where part i starts, `end` where
 * the audio in hand ends. Each part gets the piece of it that falls in its own seconds.
 */
export function spread(from: number, to: number, starts: number[], end: number): Array<{ part: number; from: number; to: number }> {
  const out: Array<{ part: number; from: number; to: number }> = []
  for (let part = 0; part < starts.length; part++) {
    const start = starts[part]
    const stop = part + 1 < starts.length ? starts[part + 1] : end
    const a = Math.max(from, start)
    const b = Math.min(to, stop)
    if (b > a) out.push({ part, from: a - start, to: b - start })
  }
  return out
}

/**
 * The whole text's length while it's being made (build 98, the owner: «показывает длительность минуту… и добавляется
 * ещё 17 секунд»): the audio made so far as it is, the rest from its words at the pace this voice has had on this text
 * so far (the estimate alone before any audio), and what's still to be written for the ear at the length the writing
 * has had so far.
 *
 * `parts`: the parts known, `audio[i]` the seconds made of a whole part (undefined: not yet), `unwritten` the source text
 * not yet written for the ear, `written` the source text written so far (both empty for a text spoken as it is),
 * `pace`: the voice's pace this device saw last time in this language (before any of this text's audio is in).
 */
export function listenTotal({ parts, audio, unwritten = "", written = "", pace: before = 1 }: { parts: string[]; audio: Array<number | undefined>; unwritten?: string; written?: string; pace?: number }): number {
  const { made, pace: seen } = madeAndPace(parts, audio)
  // The voice's pace on this text once a few seconds of it are in; until then the one seen last time.
  const pace = seen ?? bounded(before)
  let total = made
  for (let i = 0; i < parts.length; i++) if (audio[i] === undefined) total += guess(parts[i]) * pace
  if (unwritten) {
    // Written for the ear comes out longer or shorter than its source: as much as it has so far.
    const sourceGuess = guess(written)
    const writtenGuess = parts.reduce((n, p) => n + guess(p), 0)
    const stretch = sourceGuess >= 4 ? Math.min(4, Math.max(0.5, writtenGuess / sourceGuess)) : 1
    total += guess(unwritten) * stretch * pace
  }
  return Math.round(total * 10) / 10
}

/** The voice's pace on this text so far (audio made against its words), once a few seconds of it are in: kept by the
 *  device per language for the next text's length at its start (null: too little yet). */
export function listenPace(parts: string[], audio: Array<number | undefined>): number | null {
  return madeAndPace(parts, audio).pace
}

function madeAndPace(parts: string[], audio: Array<number | undefined>): { made: number; pace: number | null } {
  let made = 0
  let madeGuess = 0
  for (let i = 0; i < parts.length; i++) {
    const seconds = audio[i]
    if (seconds === undefined) continue
    made += seconds
    madeGuess += guess(parts[i])
  }
  // A short part says little about the pace: bounded, and only from a few seconds on.
  return { made, pace: madeGuess >= 4 ? bounded(made / madeGuess) : null }
}

const bounded = (pace: number) => (Number.isFinite(pace) ? Math.min(1.8, Math.max(0.6, pace)) : 1)

/** A part's seconds from its words (src/shared/speech.ts speechSeconds, unrounded for sums): 0 for nothing to say. */
function guess(text: string): number {
  return /[\p{L}\p{N}]/u.test(text) ? speechSeconds(text, false) : 0
}
