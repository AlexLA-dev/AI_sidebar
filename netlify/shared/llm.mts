import { config } from "./config.mts"
import { isReasoningGpt } from "../../src/shared/models.ts"
import { MAX_PAGE_CHARS, systemPrompt, type PageContext } from "../../src/shared/prompt.ts"

export { systemPrompt, type PageContext }

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

const MAX_MESSAGE_CHARS = 6_000
const MAX_HISTORY = 12

export function sanitizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const messages: ChatMessage[] = []
  for (const item of raw.slice(-MAX_HISTORY)) {
    if (!item || typeof item !== "object") return null
    const { role, content } = item as { role?: unknown; content?: unknown }
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return null
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) })
  }
  if (messages[messages.length - 1].role !== "user") return null
  return messages
}

export function sanitizePage(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  const text = typeof p.text === "string" ? p.text.slice(0, MAX_PAGE_CHARS + 1) : ""
  if (!text.trim()) return null
  return {
    kind: p.kind === "selection" ? "selection" : "page",
    title: typeof p.title === "string" ? p.title.slice(0, 300) : "",
    url: typeof p.url === "string" ? p.url.slice(0, 1_000) : "",
    text
  }
}

export class UpstreamError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface Completion {
  model: string
  // OpenAI SSE body; parse with readDeltas().
  body: ReadableStream<Uint8Array>
}

/**
 * Starts a streaming completion. Models are tried in order; a model that is
 * missing/retired for this key falls through to the next one, every other
 * error is final.
 */
export async function startCompletion(system: string, messages: ChatMessage[], models: string[], signal?: AbortSignal): Promise<Completion> {
  let lastError: UpstreamError | null = null
  for (const model of models) {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: system }, ...messages]
    }
    if (isReasoningGpt(model)) {
      body.max_completion_tokens = config.maxOutputTokens + 2048
      // Accepted by every GPT-5.x ("minimal" is not).
      body.reasoning_effort = "low"
    } else {
      body.max_tokens = config.maxOutputTokens
      body.temperature = 0.4
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openaiKey}` },
      body: JSON.stringify(body),
      signal
    })
    if (res.ok && res.body) return { model, body: res.body }

    const detail = await res.text().catch(() => "")
    lastError = new UpstreamError(`${model}: ${res.status} ${detail.slice(0, 300)}`, res.status)
    const modelUnavailable = res.status === 404 || (res.status === 400 && /model/i.test(detail))
    if (!modelUnavailable) throw lastError
    console.warn(`[cf] model ${model} unavailable, trying next`)
  }
  throw lastError ?? new UpstreamError("no model configured", 500)
}

export interface StreamStats {
  promptTokens: number
  completionTokens: number
  chars: number
}

/** Parses OpenAI's SSE stream and yields text deltas; fills `stats` at the end. */
export async function* readDeltas(body: ReadableStream<Uint8Array>, stats: StreamStats): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
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
        const data = line.slice(5).trim()
        if (data === "[DONE]") return
        let chunk: {
          choices?: { delta?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.usage) {
          stats.promptTokens = chunk.usage.prompt_tokens ?? 0
          stats.completionTokens = chunk.usage.completion_tokens ?? 0
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          stats.chars += delta.length
          yield delta
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
