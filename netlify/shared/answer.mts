import Anthropic from "@anthropic-ai/sdk"

import { config } from "./config.mts"
import { readDeltas, startCompletion, type ChatMessage, type StreamStats } from "./llm.mts"
import { modelsFor } from "./models.mts"

/** Which plan's settings an answer uses (AI search and the old endpoint use the free ones). */
export type Tier = "free" | "pro"

export interface Answer {
  provider: "anthropic" | "openai"
  model: string
  /** Why OpenAI answered instead of Claude ("no_key", "credits", "rate_limit", …); null when Claude did. */
  fallback: string | null
  /** The answer's text as it streams; fills `stats` (tokens, characters). */
  text(stats: StreamStats): AsyncGenerator<string>
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max"
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

/** Claude can't answer this one: the reason goes to the logs, OpenAI answers. */
class ClaudeUnavailable extends Error {
  readonly reason: string
  constructor(reason: string, message = reason) {
    super(message)
    this.reason = reason
  }
}

// After a failure that will repeat (no credits, a bad key, a rate limit), this function instance
// stops asking Claude for a while instead of paying the round trip on every answer.
const COOLDOWN_MS: Record<string, number> = { credits: 10 * 60_000, auth: 10 * 60_000, forbidden: 10 * 60_000, rate_limit: 30_000 }
let cooldown: { until: number; reason: string } | null = null

export function resetClaudeCooldownForTests(): void {
  cooldown = null
}

function reasonOf(err: unknown): string {
  if (err instanceof ClaudeUnavailable) return err.reason
  if (err instanceof Anthropic.AuthenticationError) return "auth"
  if (err instanceof Anthropic.PermissionDeniedError) return "forbidden"
  if (err instanceof Anthropic.RateLimitError) return "rate_limit"
  if (err instanceof Anthropic.NotFoundError) return "model"
  // The API says so in a 400 when the prepaid credits are used up.
  if (err instanceof Anthropic.BadRequestError) return /credit balance/i.test(err.message) ? "credits" : "bad_request"
  if (err instanceof Anthropic.InternalServerError) return err.status === 529 ? "overloaded" : "server"
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout"
  if (err instanceof Anthropic.APIUserAbortError) return "timeout"
  if (err instanceof Anthropic.APIConnectionError) return "network"
  if (err instanceof Anthropic.APIError) return /overloaded/i.test(err.message) ? "overloaded" : `status_${err.status ?? "stream"}`
  return "error"
}

/**
 * Starts a Claude answer and waits for its first words, so that anything going wrong before them
 * (an HTTP error, a refusal, an empty answer, no first word in time) can still be answered by OpenAI.
 */
async function startClaude(system: string, messages: ChatMessage[], tier: Tier, signal?: AbortSignal): Promise<Answer> {
  const settings = config.claude[tier]
  const effort = (EFFORTS.includes(settings.effort) ? settings.effort : tier === "pro" ? "medium" : "low") as Effort
  // Retries would only delay the switch to OpenAI. The address is pinned: no environment variable
  // (ANTHROPIC_BASE_URL) can send the key anywhere else.
  const client = new Anthropic({ apiKey: config.anthropicKey, baseURL: "https://api.anthropic.com", maxRetries: 0 })

  const abort = new AbortController()
  const stop = () => abort.abort()
  signal?.addEventListener("abort", stop)
  let late = false
  const timer = setTimeout(() => {
    late = true
    abort.abort()
  }, config.claudeFirstTokenMs)

  // Adaptive thinking (the default) at the plan's effort. A decline in the categories Claude Sonnet 5
  // handles is re-run there by the API; other declines go to OpenAI below.
  const stream = client.beta.messages.stream({
    model: settings.model,
    max_tokens: settings.maxTokens,
    system,
    messages,
    output_config: { effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default"
  }, { signal: abort.signal })
  const events = stream[Symbol.asyncIterator]()

  let model = settings.model
  let promptTokens = 0
  let completionTokens = 0
  let stopReason: string | null = null
  /** The next piece of text, reading usage on the way; null at the end of the answer. */
  const nextText = async (): Promise<string | null> => {
    while (true) {
      const { done, value: event } = await events.next()
      if (done) return null
      if (event.type === "message_start") {
        model = event.message.model || model
        const u = event.message.usage
        promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      } else if (event.type === "message_delta") {
        completionTokens = event.usage.output_tokens ?? completionTokens
        stopReason = event.delta.stop_reason ?? stopReason
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        return event.delta.text
      }
    }
  }

  let first: string | null
  try {
    first = await nextText()
    if (first === null) throw new ClaudeUnavailable(stopReason === "refusal" ? "refusal" : "empty", `no text (stop: ${stopReason})`)
  } catch (err) {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    abort.abort()
    if (signal?.aborted) throw err
    throw late ? new ClaudeUnavailable("timeout", `no first word in ${config.claudeFirstTokenMs} ms`) : err
  }
  clearTimeout(timer)

  return {
    provider: "anthropic",
    model,
    fallback: null,
    async *text(stats: StreamStats) {
      try {
        let piece: string | null = first
        while (piece !== null) {
          stats.chars += piece.length
          yield piece
          piece = await nextText()
        }
        if (stopReason === "refusal") throw new Error("Claude declined to finish the answer")
      } finally {
        stats.promptTokens = promptTokens
        stats.completionTokens = completionTokens
        if (stopReason === "max_tokens") stats.cut = true
        signal?.removeEventListener("abort", stop)
        abort.abort()
        // Spend per plan in the function log: shows how fast the Claude credits go.
        console.log(`[cf] claude ${tier} ${model} effort=${effort} in=${promptTokens} out=${completionTokens} usd=${answerCost({ provider: "anthropic" }, stats)}`)
      }
    }
  }
}

/** The app build a request came from (`client.build`, the app's CFBundleVersion), or null. */
export function clientBuild(client: Record<string, unknown>): number | null {
  const match = /^\d+/.exec(String(client.build ?? "").trim())
  return match ? Number(match[0]) : null
}

/**
 * Starts an answer: Claude with the plan's model and effort, or OpenAI when Claude can't answer
 * before its first word or the app build is older than CLAUDE_MIN_BUILD. Nothing reaches the user
 * (or is charged) twice: the switch happens before any text is sent. Errors after OpenAI fails too
 * are thrown like startCompletion's.
 */
export async function startAnswer(system: string, messages: ChatMessage[], tier: Tier, build: number | null, signal?: AbortSignal): Promise<Answer> {
  let fallback: string
  // CLAUDE_MIN_BUILD=0 lets every client use Claude (the local stand: its extension has no build).
  if (config.claudeMinBuild > 0 && (build === null || build < config.claudeMinBuild)) fallback = "old_client"
  else if (!config.anthropicKey) fallback = "no_key"
  else if (!config.claudeEnabled) fallback = "off"
  else if (cooldown && cooldown.until > Date.now()) fallback = `cooldown_${cooldown.reason}`
  else {
    try {
      return await startClaude(system, messages, tier, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      fallback = reasonOf(err)
      const pause = COOLDOWN_MS[fallback]
      if (pause) cooldown = { until: Date.now() + pause, reason: fallback }
      console.warn(`[cf] claude unavailable (${fallback}): ${err instanceof Error ? err.message.slice(0, 300) : err}; answering with openai`)
    }
  }
  const completion = await startCompletion(system, messages, await modelsFor(tier), signal)
  return { provider: "openai", model: completion.model, fallback, text: (stats) => readDeltas(completion.body, stats) }
}

/** What an answer cost us in USD, when it's known (Claude: from its tokens and list prices). */
export function answerCost(answer: Pick<Answer, "provider">, stats: StreamStats): number | null {
  if (answer.provider !== "anthropic") return null
  const usd = (stats.promptTokens * config.claudePriceIn + stats.completionTokens * config.claudePriceOut) / 1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}
