// Build 98 (the owner on 97): what's heard of a part is the stretches played, so seeking forward over a stretch never
// counts it, hearing it again adds nothing, and pieces add up; and the text's length is right from the start rather
// than growing near the end.
import assert from "node:assert/strict"
import { test } from "node:test"

import { addRange, coveredSeconds, FULL, listenTotal, type Ranges, slotMask, spread } from "../src/shared/coverage.ts"

/** A listen: the position moving by 0.25 s ticks from `from` to `to` (as the panel's clock does while it plays). */
function play(ranges: Ranges, from: number, to: number): Ranges {
  let at = from
  while (at < to) {
    const next = Math.min(to, at + 0.25)
    ranges = addRange(ranges, at, next)
    at = next
  }
  return ranges
}

test("a part played through in ticks is one stretch, all of its tenths", () => {
  const heard = play([], 0, 20)
  assert.deepEqual(heard, [[0, 20]])
  assert.equal(coveredSeconds(heard), 20)
  assert.equal(slotMask(heard, 20), FULL)
})

test("seeking forward over a stretch leaves it out: those tenths aren't heard", () => {
  // 0–6 s heard, a seek to 12 s, then to the end: 6–12 s skipped (tenths 3, 4 and 5 of a 20 s part).
  const heard = play(play([], 0, 6), 12, 20)
  assert.equal(coveredSeconds(heard), 14)
  const mask = slotMask(heard, 20)
  assert.notEqual(mask, FULL)
  assert.deepEqual([3, 4, 5].map((slot) => Boolean(mask & (1 << slot))), [false, false, false])
  assert.ok(mask & (1 << 2) && mask & (1 << 6))
})

test("hearing a stretch again adds nothing; going back for what was skipped makes the part whole", () => {
  let heard = play(play([], 0, 6), 12, 20)
  // Back to 4 s and on to 14 s: 4–6 and 12–14 again, 6–12 for the first time.
  heard = play(heard, 4, 14)
  assert.deepEqual(heard, [[0, 20]])
  assert.equal(coveredSeconds(heard), 20)
  assert.equal(slotMask(heard, 20), FULL)
})

test("the same stretch heard twice counts once", () => {
  const heard = play(play([], 0, 10), 0, 10)
  assert.equal(coveredSeconds(heard), 10)
  assert.equal(slotMask(heard, 20), 0b11111)
})

test("pieces from separate listens join to the whole (their tenths, as the server joins them)", () => {
  const first = slotMask(play([], 0, 9), 20)
  const second = slotMask(play([], 9, 20), 20)
  assert.notEqual(first, FULL)
  assert.notEqual(second, FULL)
  assert.equal(first | second, FULL)
})

test("a tick's rounding at a tenth's edge isn't a gap; a skip of most of a tenth is", () => {
  // A 3 s part: tenths of 0.3 s. Played to 2.95 s (the last tick a little short of the end): still whole.
  assert.equal(slotMask(play([], 0, 2.95), 3), FULL)
  // 1 s skipped in a 10 s part: tenth 4 (4–5 s) is out.
  const mask = slotMask(play(play([], 0, 4), 5, 10), 10)
  assert.equal(mask & (1 << 4), 0)
})

test("a stretch of the text's clock lands on the parts it crosses, each in its own seconds", () => {
  // Parts start at 0, 8 and 15 s; 6.5–9 s crosses from the first into the second.
  assert.deepEqual(spread(6.5, 9, [0, 8, 15], 30), [{ part: 0, from: 6.5, to: 8 }, { part: 1, from: 0, to: 1 }])
  // The last part runs to the end of what's in hand.
  assert.deepEqual(spread(16, 20, [0, 8, 15], 30), [{ part: 2, from: 1, to: 5 }])
})

test("the length: from the words before any audio, then the voice's pace on this text for the rest", () => {
  // Four parts of 140 characters: about 10 s each by the words alone.
  const parts = Array.from({ length: 4 }, (_, i) => `${"Word ".repeat(27)}end${i}.`)
  const before = listenTotal({ parts, audio: [] })
  assert.ok(Math.abs(before - 40) < 1.5, String(before))
  // The voice is slower on this text: the first part took 13 s. The rest follows at that pace at once.
  const after = listenTotal({ parts, audio: [13] })
  assert.ok(Math.abs(after - 52) < 2, String(after))
  // All made: the length is exactly the audio.
  assert.equal(listenTotal({ parts, audio: [13, 12.6, 13.4, 13] }), 52)
})

test("written for the ear: the rest still to be written counts at the length the writing has had so far", () => {
  // A list of 10 rows (source); its first half written out as 2 parts twice as long as its source.
  const row = "Item, 12 dollars, red."
  const source = Array.from({ length: 10 }, () => row)
  const written = source.slice(0, 5).join("\n")
  const unwritten = source.slice(5).join("\n")
  const parts = ["Item costs 12 dollars and comes in red. ".repeat(2.5 * 2), "Item costs 12 dollars and comes in red. ".repeat(2.5 * 2)]
  const total = listenTotal({ parts, audio: [], unwritten, written })
  const partsGuess = listenTotal({ parts, audio: [] })
  // The unwritten half counts as long as the written half did.
  assert.ok(Math.abs(total - 2 * partsGuess) < 2, `${total} vs ${partsGuess}`)
})

test("the length shown settles early and doesn't grow at the end (a voice 28% slower than the words say)", () => {
  // The owner's case: about a minute by the words, 77 s of audio. Each part made in turn; the length shown at each
  // step, then the audio at the end.
  const parts = Array.from({ length: 6 }, (_, i) => `${"Sentence with several words in it. ".repeat(4)}Part ${i}.`)
  const real = parts.map((p) => listenTotal({ parts: [p], audio: [] }) * 1.28)
  const shown: number[] = []
  for (let made = 0; made <= parts.length; made++) shown.push(listenTotal({ parts, audio: real.slice(0, made) }))
  const end = shown.at(-1)!
  assert.ok(Math.abs(end - real.reduce((a, b) => a + b, 0)) < 0.2)
  // From the first part on, within 3% of the end; never a jump of more than that after it.
  for (const value of shown.slice(1)) assert.ok(Math.abs(value - end) / end < 0.03, `${value} vs ${end}`)
})
