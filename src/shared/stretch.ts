// Faster speech at the same pitch, for the panel's player (build 90: 1.2×, 1.5×, 2×). Web Audio can only play faster
// by raising the pitch, so the samples are time-stretched before they're played: WSOLA (waveform-similarity
// overlap-add). Frames of 40 ms are taken from the source every `speed` × 20 ms and laid down every 20 ms, each one
// moved by up to ±10 ms to where it continues the last one best, so the voice stays smooth. It works as the audio
// streams in: push() gives back what can be played so far, end() the rest.

const FRAME = 960 // 40 ms at 24 kHz
const HOP = FRAME / 2 // output hop: 20 ms
const SEEK = 240 // ±10 ms
const STEP = 4 // the similarity is measured on every 4th sample (cheap, and enough for speech)

const WINDOW = (() => {
  const w = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  return w
})()

export class Stretcher {
  readonly speed: number
  // Source samples kept (from `base`, an absolute index), where the next frame should start (absolute, fractional),
  // where the last one started, and the second half of the last frame, waiting to be overlapped.
  private input = new Float32Array(0)
  private base = 0
  private ideal: number
  private last = -1
  private tail = new Float32Array(HOP)

  /** `start`: the source sample it starts from (absolute), for position(). */
  constructor(speed: number, start = 0) {
    this.speed = speed
    this.base = start
    this.ideal = start
  }

  /** The source sample the next output sample comes from (absolute): the player's clock in source time. */
  get position(): number {
    return this.ideal
  }

  /** More source samples; returns the output that's ready. */
  push(samples: Float32Array): Float32Array {
    if (this.speed === 1) {
      this.ideal += samples.length
      return samples
    }
    const joined = new Float32Array(this.input.length + samples.length)
    joined.set(this.input)
    joined.set(samples, this.input.length)
    this.input = joined
    return this.run(false)
  }

  /** The source has ended: what's left. */
  end(): Float32Array {
    if (this.speed === 1) return new Float32Array(0)
    const padded = new Float32Array(this.input.length + FRAME + SEEK * 2)
    padded.set(this.input)
    const sourceEnd = this.base + this.input.length
    this.input = padded
    const out = this.run(true, sourceEnd)
    const rest = new Float32Array(out.length + HOP)
    rest.set(out)
    rest.set(this.tail, out.length)
    this.tail = new Float32Array(HOP)
    this.input = new Float32Array(0)
    this.base = sourceEnd
    this.ideal = sourceEnd
    return rest
  }

  private run(ending: boolean, sourceEnd = Infinity): Float32Array {
    const frames: Float32Array[] = []
    const hopIn = HOP * this.speed
    const end = this.base + this.input.length
    while (true) {
      const at = Math.round(this.ideal)
      if (ending ? at >= sourceEnd : at + SEEK + FRAME > end) break
      const start = this.last < 0 ? at : this.best(at, end)
      const out = new Float32Array(HOP)
      const from = start - this.base
      for (let i = 0; i < HOP; i++) {
        const v = this.input[from + i]
        // The very first frame starts at full volume; later ones fade in over the last one's fade-out.
        out[i] = this.last < 0 ? v : this.tail[i] + v * WINDOW[i]
      }
      for (let i = 0; i < HOP; i++) this.tail[i] = this.input[from + HOP + i] * WINDOW[HOP + i]
      frames.push(out)
      this.last = start
      this.ideal += hopIn
    }
    // What can't be needed again: before the earliest sample the next frame or its comparison could use.
    const keepFrom = Math.max(this.base, Math.min(this.last + HOP, Math.round(this.ideal) - SEEK))
    if (!ending && keepFrom > this.base) {
      this.input = this.input.slice(keepFrom - this.base)
      this.base = keepFrom
    }
    const total = new Float32Array(frames.length * HOP)
    frames.forEach((f, i) => total.set(f, i * HOP))
    return total
  }

  /** The start near `at` (±10 ms) whose first half is most like what naturally follows the last frame. */
  private best(at: number, end: number): number {
    const natural = this.last + HOP - this.base
    let bestAt = at
    let bestScore = -Infinity
    const lo = Math.max(this.base, at - SEEK)
    const hi = Math.min(end - FRAME, at + SEEK)
    for (let c = lo; c <= hi; c += 2) {
      const from = c - this.base
      let score = 0
      for (let k = 0; k < HOP; k += STEP) score += this.input[from + k] * this.input[natural + k]
      if (score > bestScore) {
        bestScore = score
        bestAt = c
      }
    }
    return bestAt
  }
}

export const SPEEDS = [1, 1.2, 1.5, 2] as const
export type Speed = (typeof SPEEDS)[number]

/** "1.2×" in the reader's way of writing numbers. */
export function speedLabel(speed: number, locale?: string): string {
  return `${speed.toLocaleString(locale, { maximumFractionDigits: 1 })}×`
}
