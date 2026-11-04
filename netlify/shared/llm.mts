import { config } from "./config.mts"
import { isReasoningGpt } from "../../src/shared/models.ts"
import { MAX_ATTACHMENTS, mediaKinds, type Attachment, type MediaKind } from "../../src/shared/attachments.ts"
import { MAX_MEDIA_PAGE_CHARS, MAX_OTHER_PAGE_CHARS, MAX_OTHER_PAGES, MAX_PAGE_CHARS, systemPrompt, systemPromptParts, type PageContext } from "../../src/shared/prompt.ts"

export { systemPrompt, systemPromptParts, type PageContext }

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

const MAX_MESSAGE_CHARS = 6_000
const MAX_HISTORY = 12
// "Whole chat" (context: "chat"): the whole conversation, notes included, within a character budget.
const MAX_CHAT_HISTORY = 120
const MAX_CHAT_CHARS = 60_000

export function sanitizeMessages(raw: unknown, wholeChat = false): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const messages: ChatMessage[] = []
  for (const item of raw.slice(-(wholeChat ? MAX_CHAT_HISTORY : MAX_HISTORY))) {
    if (!item || typeof item !== "object") return null
    const { role, content } = item as { role?: unknown; content?: unknown }
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return null
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) })
  }
  if (messages[messages.length - 1].role !== "user") return null
  if (wholeChat) {
    let size = messages.reduce((n, m) => n + m.content.length, 0)
    while (size > MAX_CHAT_CHARS && messages.length > 1) size -= messages.shift()!.content.length
  }
  return messages
}

/** Other pages of the conversation sent with "whole chat": `max` of them, each cut to a budget. */
export function sanitizeOtherPages(raw: unknown, max = MAX_OTHER_PAGES): PageContext[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, max + 7).flatMap((p) => {
    const page = sanitizePage(p)
    return page ? [{ ...page, kind: "page" as const, text: page.text.slice(0, MAX_OTHER_PAGE_CHARS + 1), changed: false }] : []
  }).slice(0, max)
}

/**
 * The page as sent. Its video transcript and PDFs come as `attachments` (2.4 build 68 and later) or
 * already inside the text with `media` (earlier 2.4 test builds); pageForModel then keeps them for
 * Pro and leaves them out otherwise. `skipped`: the panel didn't read them (not Pro).
 */
export function sanitizePage(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  const kind = p.kind === "selection" ? "selection" : "page"
  // Video transcripts and PDFs get a longer limit than a page.
  const media = kind === "page" && (p.media === "video" || p.media === "pdf") ? p.media : undefined
  // A page comes whole (2.5; the request's 6 MB bounds it), a selection and a page with its media inside within their limits.
  const limit = media ? MAX_MEDIA_PAGE_CHARS : kind === "selection" ? MAX_PAGE_CHARS : Infinity
  const text = typeof p.text === "string" ? p.text.slice(0, limit + 1) : ""
  const attachments = kind === "page" ? sanitizeAttachments(p.attachments) : []
  const skipped = kind === "page" && Array.isArray(p.skipped) ? mediaKinds(p.skipped.filter(isMedia).map((k) => ({ kind: k }))) : []
  if (!text.trim() && !attachments.length && !skipped.length) return null
  return {
    kind,
    title: typeof p.title === "string" ? p.title.slice(0, 300) : "",
    url: typeof p.url === "string" ? p.url.slice(0, 1_000) : "",
    text,
    changed: p.changed === true,
    ...(media ? { media } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(skipped.length ? { skipped } : {})
  }
}

function isMedia(value: unknown): value is MediaKind {
  return value === "video" || value === "pdf"
}

function sanitizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_ATTACHMENTS).flatMap((a): Attachment[] => {
    if (!a || typeof a !== "object") return []
    const { kind, heading, text, lead } = a as Record<string, unknown>
    if (!isMedia(kind) || typeof text !== "string" || !text.trim()) return []
    return [{ kind, heading: typeof heading === "string" ? heading.slice(0, 400) : "", text: text.slice(0, MAX_MEDIA_PAGE_CHARS), ...(lead === true ? { lead: true } : {}) }]
  })
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
  // All of the prompt's tokens; of them, written to and read from Claude's cache (2.5: the page is cached).
  promptTokens: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  completionTokens: number
  chars: number
  // The model stopped at its length limit (the answer is cut off).
  cut?: boolean
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
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
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
        if (chunk.choices?.[0]?.finish_reason === "length") stats.cut = true
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
