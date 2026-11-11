// Read aloud in the panel (2.6, Ultra, Mac and other desktops): plays the 24 kHz PCM that comes through the "speak"
// port with Web Audio. Web Audio needs no URL: the page's Content-Security-Policy (media-src on GitHub, X…) can't
// block it the way it blocks an <audio> element's blob: or data: source.

import { SPEECH_RATE } from "../../shared/speech"
import { Stretcher } from "../../shared/stretch"

type Ctx = AudioContext

/** A piece scheduled: when it plays (the context's clock) and which source samples it holds. */
interface Piece {
  at: number
  until: number
  from: number
  to: number
  source: AudioBufferSourceNode
}

/**
 * Plays the parts as they come, at 1×, 1.2×, 1.5× or 2× (build 90) with the pitch kept (Stretcher, WSOLA). Times are
 * the audio's own (source) seconds: what's heard, what's received, where each part starts, whatever the speed.
 */
export class PcmPlayer {
  private ctx: Ctx
  // Every source sample received (the speed can change, so they're kept), the stretcher, and when the next piece
  // starts (the context's clock).
  private source: Float32Array[] = []
  private sourceLength = 0
  private fed = 0
  private stretch: Stretcher
  private next = 0
  private pieces: Piece[] = []
  // The source sample the last piece scheduled ends at (where the next one starts).
  private lastTo = 0
  // Where each part starts in the source (samples), as its first piece comes.
  private partStarts = new Map<number, number>()
  private ended = false
  private closed = false
  // Pieces go in strictly in order: a part from iCloud is decoded first (AAC), and what comes after it waits for it.
  private queue: Promise<void> = Promise.resolve()
  private waiting = 0

  constructor(speed = 1) {
    const Ctor = (globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext
    this.ctx = new Ctor()
    this.stretch = new Stretcher(speed)
  }

  get speed(): number {
    return this.stretch.speed
  }

  /** Call from the tap that starts it: browsers only let audio start from a gesture. */
  async unlock(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined)
  }

  private then(step: () => void | Promise<void>): void {
    this.waiting++
    this.queue = this.queue.then(step).catch(() => undefined).then(() => void this.waiting--)
  }

  /** Base64 PCM (16-bit little-endian, mono) of `part`, played right after what's already scheduled. */
  push(part: number, data: string): void {
    this.then(() => {
      if (this.closed) return
      const binary = atob(data)
      const count = binary.length >> 1
      if (!count) return
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const lo = binary.charCodeAt(i * 2)
        const hi = binary.charCodeAt(i * 2 + 1)
        let v = (hi << 8) | lo
        if (v >= 0x8000) v -= 0x10000
        samples[i] = v / 0x8000
      }
      this.add(part, samples)
    })
  }

  /** A whole part as AAC (base64, from the user's iCloud): decoded at the voice's rate, then played in its turn. */
  pushAac(part: number, data: string): void {
    this.then(async () => {
      if (this.closed) return
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      const decoder = new OfflineAudioContext(1, 1, SPEECH_RATE)
      const audio = await decoder.decodeAudioData(bytes.buffer)
      if (!this.closed) this.add(part, audio.getChannelData(0).slice())
    })
  }

  private add(part: number, samples: Float32Array): void {
    if (!samples.length) return
    if (!this.partStarts.has(part)) this.partStarts.set(part, this.sourceLength)
    this.source.push(samples)
    this.sourceLength += samples.length
    this.feed()
  }

  /** Everything has come: the stretcher gives up what it held back. */
  end(): void {
    this.then(() => {
      if (this.closed || this.ended) return
      this.ended = true
      this.feed()
    })
  }

  /** From now on at `speed`, from where it is (what's scheduled ahead is laid down again). */
  setSpeed(speed: number): void {
    if (this.closed || speed === this.stretch.speed) return
    const now = this.ctx.currentTime
    const from = Math.min(this.sourceLength, Math.round(this.heardSamples()))
    for (const piece of this.pieces) {
      try {
        piece.source.stop()
      } catch {
        // Already ended.
      }
    }
    this.pieces = []
    this.stretch = new Stretcher(speed, from)
    this.lastTo = from
    this.fed = from
    this.next = now
    this.feed()
  }

  /** Plays from `seconds` of the audio, back or forward within what has come (the bar, build 92; the owner: "it won't
   *  let me move the audio back or forward"). Paused, it stays paused there. */
  seek(seconds: number): void {
    if (this.closed || !this.sourceLength) return
    const to = Math.max(0, Math.min(this.sourceLength - 1, Math.round(seconds * SPEECH_RATE)))
    for (const piece of this.pieces) {
      try {
        piece.source.stop()
      } catch {
        // Already ended.
      }
    }
    this.pieces = []
    this.stretch = new Stretcher(this.stretch.speed, to)
    this.lastTo = to
    this.fed = to
    this.next = this.ctx.currentTime
    this.feed()
  }

  private feed(): void {
    if (this.fed < this.sourceLength) {
      const fresh = this.slice(this.fed, this.sourceLength)
      this.fed = this.sourceLength
      this.schedule(this.stretch.push(fresh), this.stretch.position)
    }
    if (this.ended) this.schedule(this.stretch.end(), this.sourceLength)
  }

  /** The source samples [from, to) as one array. */
  private slice(from: number, to: number): Float32Array {
    const out = new Float32Array(to - from)
    let at = 0
    let offset = 0
    for (const chunk of this.source) {
      const start = Math.max(from, offset)
      const end = Math.min(to, offset + chunk.length)
      if (end > start) {
        out.set(chunk.subarray(start - offset, end - offset), at)
        at += end - start
      }
      offset += chunk.length
      if (offset >= to) break
    }
    return out
  }

  private schedule(samples: Float32Array, upTo: number): void {
    if (!samples.length) return
    const buffer = this.ctx.createBuffer(1, samples.length, SPEECH_RATE)
    buffer.getChannelData(0).set(samples)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    // Ran dry (slow network): carry on a moment from now rather than in the past.
    const at = Math.max(this.next, this.ctx.currentTime + 0.04)
    source.start(at)
    const piece = { at, until: at + buffer.duration, from: this.lastTo, to: upTo, source }
    this.lastTo = upTo
    this.pieces.push(piece)
    source.onended = () => {
      // Keep the last one: it holds the clock while waiting for more.
      if (this.pieces.length > 1 && this.pieces[0] === piece) this.pieces.shift()
    }
    this.next = piece.until
  }

  /** Source samples heard so far. */
  private heardSamples(): number {
    const now = this.ctx.currentTime
    const live = this.pieces.find((p) => now < p.until)
    if (!live) return this.lastTo
    if (now <= live.at) return live.from
    return live.from + ((now - live.at) / (live.until - live.at)) * (live.to - live.from)
  }

  /** Seconds heard so far (of the audio itself, whatever the speed). */
  get position(): number {
    return Math.max(0, this.heardSamples() / SPEECH_RATE)
  }

  /** Where each part starts in the audio (seconds; index = part), as far as it has come. A part with nothing to say
   *  (skipped) starts where the next one does. For the app to carry on from the same second (2.6). */
  get starts(): number[] {
    const last = Math.max(-1, ...this.partStarts.keys())
    const out: number[] = new Array(last + 1)
    let following = this.sourceLength
    for (let part = last; part >= 0; part--) {
      const start = this.partStarts.get(part)
      if (start !== undefined) following = start
      out[part] = Math.round((following / SPEECH_RATE) * 100) / 100
    }
    return out
  }

  /** Seconds of audio received so far. */
  get received(): number {
    return this.sourceLength / SPEECH_RATE
  }

  /** Whether everything received has been heard (waiting for more, or done). */
  get drained(): boolean {
    return this.waiting === 0 && this.ctx.currentTime >= this.next - 0.02 && (this.ended || this.fed >= this.sourceLength)
  }

  /** The part being heard now (-1 before the first). */
  get part(): number {
    const at = this.heardSamples()
    let current = -1
    for (const [part, start] of this.partStarts) if (start <= at + 0.05 * SPEECH_RATE && part > current) current = part
    return current
  }

  get paused(): boolean {
    // "interrupted" (iOS: the page went away, a call): silent too, so it shows as paused and Play resumes it.
    return this.ctx.state !== "running"
  }

  pause(): void {
    void this.ctx.suspend().catch(() => undefined)
  }

  resume(): void {
    void this.ctx.resume().catch(() => undefined)
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    for (const piece of this.pieces) {
      try {
        piece.source.stop()
      } catch {
        // Already ended.
      }
    }
    this.pieces = []
    void this.ctx.close().catch(() => undefined)
  }
}

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
