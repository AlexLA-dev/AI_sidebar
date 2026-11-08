import assert from "node:assert/strict"
import { test } from "node:test"

const { Stretcher, speedLabel } = await import("../src/shared/stretch.ts")

const RATE = 24_000
function tone(seconds: number, hz: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE)
  return out
}
function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** Zero crossings a second over the middle of the signal: twice the pitch of a tone. */
function crossings(signal: Float32Array): number {
  const from = Math.floor(signal.length * 0.2)
  const to = Math.floor(signal.length * 0.8)
  let n = 0
  for (let i = from + 1; i < to; i++) if ((signal[i - 1] < 0) !== (signal[i] < 0)) n++
  return n / ((to - from) / RATE)
}

test("stretch: 1× gives the samples back as they are", () => {
  const s = new Stretcher(1)
  const input = tone(0.5, 220)
  assert.deepEqual(s.push(input), input)
  assert.equal(s.end().length, 0)
  assert.equal(s.position, input.length)
})

for (const speed of [1.2, 1.5, 2]) {
  test(`stretch: ${speed}× is ${speed} times shorter at the same pitch`, () => {
    const s = new Stretcher(speed)
    const input = tone(3, 220)
    const out = join([s.push(input), s.end()])
    const expected = input.length / speed
    assert.ok(Math.abs(out.length - expected) < 2 * 960, `${out.length} vs ${expected}`)
    assert.ok(Math.abs(crossings(out) - 440) < 12, `pitch: ${crossings(out)} crossings a second`)
    // No clicks: no jump between neighbouring samples beyond what the tone itself has.
    let jump = 0
    for (let i = 1; i < out.length - 960; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]))
    assert.ok(jump < 0.06, `largest step ${jump}`)
    assert.equal(s.position, input.length)
  })
}

test("stretch: pieces as they stream in give the same audio as all at once", () => {
  const input = tone(2, 180)
  const whole = new Stretcher(1.5)
  const once = join([whole.push(input), whole.end()])
  const streamed = new Stretcher(1.5)
  const pieces: Float32Array[] = []
  for (let at = 0, n = 1; at < input.length; at += n, n = (n * 7 + 311) % 4800 + 1) pieces.push(streamed.push(input.subarray(at, Math.min(input.length, at + n))))
  pieces.push(streamed.end())
  assert.deepEqual(join(pieces), once)
})

test("stretch: starts from a given source sample (a speed change mid-text)", () => {
  const s = new Stretcher(2, 48_000)
  assert.equal(s.position, 48_000)
  s.push(tone(1, 220))
  assert.ok(s.position > 48_000 && s.position <= 48_000 + 24_000)
})

test("speedLabel: the reader's own decimal mark", () => {
  assert.equal(speedLabel(1.2, "en"), "1.2×")
  assert.equal(speedLabel(1.5, "ru"), "1,5×")
  assert.equal(speedLabel(2, "de"), "2×")
})

test("syncKey: the same as the app's SpeechSync.key (sha256 of speech|v1|voice|language|text, the language's first part)", async () => {
  const { syncKey } = await import("../src/shared/speech.ts")
  const { createHash } = await import("node:crypto")
  const expected = createHash("sha256").update("speech|v1|Kore|en|Hello there.").digest("hex")
  assert.equal(await syncKey("Kore", "en-US", "Hello there."), expected)
  assert.equal(await syncKey("Kore", "EN", "Hello there."), expected)
  // The app's DEBUG self-check (-CFDebugSpeechSync YES) logs its key for the same input: it must be this one.
  assert.equal(expected, "113db5a013838f507ae6065abc4e53dea5287a7dd0387c991e397bdc9f56b7ef")
})
