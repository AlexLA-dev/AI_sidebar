// Read aloud in the panel (2.6, Ultra, Mac and other desktops): plays the 24 kHz PCM that comes through the "speak"
// port with Web Audio. Web Audio needs no URL: the page's Content-Security-Policy (media-src on GitHub, X…) can't
// block it the way it blocks an <audio> element's blob: or data: source.

import { SPEECH_RATE } from "../../shared/speech"

type Ctx = AudioContext

export class PcmPlayer {
  private ctx: Ctx
  // When the next piece starts (the context's clock), and how much audio was scheduled in all.
  private next = 0
  private scheduled = 0
  private sources = new Set<AudioBufferSourceNode>()
  // Where each part starts in the audio (seconds), as its first piece is scheduled.
  private partStarts = new Map<number, number>()
  private closed = false

  constructor() {
    const Ctor = (globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext
    this.ctx = new Ctor()
  }

  /** Call from the tap that starts it: browsers only let audio start from a gesture. */
  async unlock(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined)
  }

  /** Base64 PCM (16-bit little-endian, mono) of `part`, played right after what's already scheduled. */
  push(part: number, data: string): void {
    if (this.closed) return
    const binary = atob(data)
    const samples = binary.length >> 1
    if (!samples) return
    const buffer = this.ctx.createBuffer(1, samples, SPEECH_RATE)
    const out = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) {
      const lo = binary.charCodeAt(i * 2)
      const hi = binary.charCodeAt(i * 2 + 1)
      let v = (hi << 8) | lo
      if (v >= 0x8000) v -= 0x10000
      out[i] = v / 0x8000
    }
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    // Ran dry (slow network): carry on a moment from now rather than in the past.
    const at = Math.max(this.next, this.ctx.currentTime + 0.04)
    if (!this.partStarts.has(part)) this.partStarts.set(part, this.scheduled)
    source.start(at)
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
    this.next = at + buffer.duration
    this.scheduled += buffer.duration
  }

  /** Seconds heard so far. */
  get position(): number {
    return Math.max(0, this.scheduled - Math.max(0, this.next - this.ctx.currentTime))
  }

  /** Seconds of audio received so far. */
  get received(): number {
    return this.scheduled
  }

  /** Whether everything received has been heard (waiting for more, or done). */
  get drained(): boolean {
    return this.ctx.currentTime >= this.next - 0.02
  }

  /** The part being heard now (-1 before the first). */
  get part(): number {
    const at = this.position
    let current = -1
    for (const [part, start] of this.partStarts) if (start <= at + 0.05 && part > current) current = part
    return current
  }

  get paused(): boolean {
    return this.ctx.state === "suspended"
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
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // Already ended.
      }
    }
    this.sources.clear()
    void this.ctx.close().catch(() => undefined)
  }
}

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
