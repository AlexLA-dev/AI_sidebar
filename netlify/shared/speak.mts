// Read aloud (2.6, Ultra): text → speech with Gemini TTS (the Interactions API, streamed). Gemini 3.8 Flash-Lite TTS
// speaks about 100 languages; the full Flash TTS speaks the rest (speechKind in src/shared/speech.ts). The audio is
// headerless 16-bit PCM at 24 kHz, passed on to the device as it comes; nothing is kept here.

import { config } from "./config.mts"
import { UpstreamError } from "./llm.mts"
import { ttsModels } from "./models.mts"
import { SPEECH_BYTES_PER_SECOND, SPEECH_RATE } from "../../src/shared/speech.ts"

const INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions"
// Audio tokens a second of speech (Google's pricing note).
export const AUDIO_TOKENS_PER_SECOND = 25

export interface SpeechStats {
  model: string
  kind: "lite" | "full"
  inputTokens: number
  outputTokens: number
  bytes: number
  firstAudioMs: number | null
}

export interface Speech {
  model: string
  kind: "lite" | "full"
  body: ReadableStream<Uint8Array>
}

// Whose voice it is, for the device's own voice when it must stand in at a text's start (offline, out of minutes): it
// picks one of the same gender, so a text never sounds like a different person (build 90).
const VOICE_GENDER: Record<string, "female" | "male"> = { Kore: "female", Leda: "female", Aoede: "female", Zephyr: "female", Puck: "male", Charon: "male", Fenrir: "male", Orus: "male" }

export function voiceGender(voice = config.speak.voice): "female" | "male" | null {
  return VOICE_GENDER[voice] ?? null
}

function requestBody(model: string, text: string): string {
  return JSON.stringify({
    model,
    input: [{ type: "user_input", content: [{ type: "text", text }] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: SPEECH_RATE },
    generation_config: { speech_config: [{ voice: config.speak.voice }] },
    stream: true
  })
}

/**
 * Starts speaking `text`. `prefer`: the model a text's earlier parts were spoken with, so every part of one text has
 * the same voice (build 91: a part that went to another model sounded like another person). A model that isn't
 * there (404) falls through to the next one; Flash-Lite refusing the language moves to the full Flash TTS. Any other
 * refusal is passed on as it is (no quiet switch to another model mid-text).
 */
export async function startSpeech(text: string, kind: "lite" | "full", signal?: AbortSignal, prefer = ""): Promise<Speech> {
  let lastError: UpstreamError | null = null
  // A text begun on the full model stays on it (build 95): a later part that Flash-Lite could say (a part without the
  // words of a language it lacks) went to Flash-Lite, another voice mid-text. The full model says every language. (The
  // other way, a part in a language Flash-Lite lacks still goes to the full model: said right over the same voice.)
  const textOnFull = kind === "lite" && Boolean(prefer) && (await ttsModels("full")).includes(prefer) && !(await ttsModels("lite")).includes(prefer)
  const kinds: Array<"lite" | "full"> = kind === "lite" && !textOnFull ? ["lite", "full"] : ["full"]
  for (const k of kinds) {
    let languageRefused = false
    const models = await ttsModels(k)
    // The text's own model first, when it's one of this kind's.
    const ordered = prefer && models.includes(prefer) ? [prefer, ...models.filter((m) => m !== prefer)] : models
    for (const model of ordered) {
      const ask = () => fetch(INTERACTIONS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey, "Api-Revision": "2026-05-20" },
        body: requestBody(model, text),
        signal
      })
      let res = await ask()
      // A passing hiccup (overloaded, 5xx): once more, the same model and voice, before the device hears of it.
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 400))
        res = await ask()
      }
      if (res.ok && res.body) return { model, kind: k, body: res.body }
      const detail = await res.text().catch(() => "")
      lastError = new UpstreamError(`${model}: ${res.status} ${detail.slice(0, 300)}`, res.status)
      if (res.status === 400 && /language|locale/i.test(detail)) {
        languageRefused = true
        break
      }
      if (res.status !== 404) throw lastError
      console.warn(`[cf] tts model ${model} unavailable, trying next`)
    }
    if (!languageRefused && k === "lite") break
  }
  throw lastError ?? new UpstreamError("no tts model configured", 500)
}

interface InteractionEvent {
  event_type?: string
  delta?: { type?: string; data?: string }
  interaction?: { status?: string; usage?: { total_input_tokens?: number; total_output_tokens?: number } }
  error?: { message?: string; code?: number }
}

/** Reads the Interactions stream: yields PCM as it comes, fills `stats` (tokens from the last event). */
export async function* readSpeech(body: ReadableStream<Uint8Array>, stats: SpeechStats, started = Date.now()): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  // PCM samples are 2 bytes: an odd byte waits for the next chunk, so every piece holds whole samples.
  let carry: Uint8Array | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith("data:")) continue
        let event: InteractionEvent
        try {
          event = JSON.parse(line.slice(5).trim()) as InteractionEvent
        } catch {
          continue
        }
        if (event.error || event.event_type === "error") {
          throw new UpstreamError(`tts stream: ${event.error?.message ?? "error"}`.slice(0, 300), event.error?.code ?? 502)
        }
        if (event.event_type === "step.delta" && event.delta?.type === "audio" && event.delta.data) {
          let pcm = new Uint8Array(Buffer.from(event.delta.data, "base64"))
          if (carry) {
            const joined = new Uint8Array(carry.length + pcm.length)
            joined.set(carry)
            joined.set(pcm, carry.length)
            pcm = joined
            carry = null
          }
          if (pcm.length % 2) {
            carry = pcm.slice(pcm.length - 1)
            pcm = pcm.slice(0, pcm.length - 1)
          }
          if (!pcm.length) continue
          if (stats.firstAudioMs === null) stats.firstAudioMs = Date.now() - started
          stats.bytes += pcm.length
          yield pcm
        }
        const usage = event.interaction?.usage
        if (usage) {
          stats.inputTokens = usage.total_input_tokens ?? stats.inputTokens
          stats.outputTokens = usage.total_output_tokens ?? stats.outputTokens
        }
        if (event.interaction?.status === "failed") throw new UpstreamError("tts failed", 502)
      }
    }
  } finally {
    reader.releaseLock()
  }
  // No usage in the stream: the audio tokens follow from its length.
  if (!stats.outputTokens && stats.bytes) stats.outputTokens = Math.round((stats.bytes / SPEECH_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND)
}

/** USD for one part, at today's prices and at the doubled ones from 2027-01-01 (Google's announced change). */
export function speechCost(stats: SpeechStats): { now: number; from2027: number } {
  const price = stats.kind === "full" ? config.speak.prices.full : config.speak.prices.lite
  const now = (stats.inputTokens * price.text + stats.outputTokens * price.audio) / 1e6
  return { now: round(now), from2027: round(now * 2) }
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}
