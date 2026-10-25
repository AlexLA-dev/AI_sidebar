import Anthropic from "@anthropic-ai/sdk"

import { newestClaudeModel, type ModelTier } from "../shared/models"
import { systemPrompt } from "../shared/prompt"
import { STORAGE, type AskPayload, type OwnKeyUsage, type StreamEvent } from "../shared/types"

type Emit = (event: StreamEvent) => void

// Used when the model list can't be read; newer models are picked up from the list.
const FALLBACK_MODEL: Record<ModelTier, string> = { smart: "claude-sonnet-5-5", fast: "claude-haiku-5-5" }
const MODEL_LIST_TTL_MS = 24 * 3600_000

type ModelList = { models: { id: string; created_at: string }[]; at: number }

async function newestModel(client: Anthropic, tier: ModelTier): Promise<string> {
  const stored = ((await chrome.storage.local.get(STORAGE.ownKeyModels))[STORAGE.ownKeyModels] ?? {}) as { anthropic?: ModelList }
  let list = stored.anthropic
  if (!list || Date.now() - list.at > MODEL_LIST_TTL_MS) {
    try {
      const models: ModelList["models"] = []
      for await (const m of client.models.list({ limit: 100 })) models.push({ id: m.id, created_at: m.created_at })
      list = { models, at: Date.now() }
      await chrome.storage.local.set({ [STORAGE.ownKeyModels]: { ...stored, anthropic: list } })
    } catch {
      // A bad key fails here too; the message request below reports it.
    }
  }
  return (list && newestClaudeModel(list.models, tier)) ?? FALLBACK_MODEL[tier]
}

function errorEvent(err: unknown): StreamEvent {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { type: "error", code: "BAD_KEY" }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return { type: "error", code: "BUSY" }
  if (err instanceof Anthropic.APIConnectionError) return { type: "error", code: "NETWORK" }
  if (err instanceof Anthropic.APIError) return { type: "error", code: "UPSTREAM", message: err.message }
  return { type: "error", code: "STREAM" }
}

/** Streams an answer straight from the Claude API with the user's own Anthropic key. */
export async function askClaude(
  key: string,
  payload: AskPayload,
  profile: string,
  locale: string,
  tier: ModelTier,
  emit: Emit,
  signal: AbortSignal
): Promise<OwnKeyUsage> {
  // The key never leaves the device except to api.anthropic.com (pinned so no environment can redirect it).
  const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", dangerouslyAllowBrowser: true, maxRetries: 1 })
  const newest = await newestModel(client, tier)
  const candidates = [...new Set([newest, FALLBACK_MODEL[tier]])]

  for (const [i, model] of candidates.entries()) {
    const params = {
      model,
      max_tokens: 16000,
      system: systemPrompt(payload.page, profile, locale),
      messages: payload.messages,
      // Short answers about a page: low effort keeps thinking brief and the reply quick.
      output_config: { effort: "low" as const }
    }
    let chars = 0
    const onText = (text: string) => {
      if (chars === 0) emit({ type: "meta", plan: "byok", usage: null, viaOwnKey: true })
      chars += text.length
      emit({ type: "delta", text })
    }

    const usage: OwnKeyUsage = { provider: "anthropic", model, ok: false, promptTokens: 0, completionTokens: 0 }
    try {
      // Sonnet can decline in a few safety categories; the API then re-runs the request on its
      // recommended fallback model instead of returning the refusal.
      const message = model.includes("-sonnet-")
        ? await client.beta.messages
            .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
            .on("text", onText)
            .finalMessage()
        : await client.messages.stream(params, { signal }).on("text", onText).finalMessage()
      usage.model = message.model || model
      const u = message.usage
      usage.promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      usage.completionTokens = u.output_tokens ?? 0
      if (message.stop_reason === "refusal") {
        emit({ type: "error", code: "UPSTREAM", message: message.stop_details?.explanation ?? "Claude declined this request." })
        return { ...usage, error: "UPSTREAM" }
      }
    } catch (err) {
      if (signal.aborted) return { ...usage, error: "STOPPED" }
      // The newest model may not be enabled for this key's organization: try the known one.
      if (err instanceof Anthropic.NotFoundError && chars === 0 && i < candidates.length - 1) continue
      const event = errorEvent(err)
      emit(event)
      return { ...usage, error: event.type === "error" ? event.code : "STREAM" }
    }
    emit(chars > 0 ? { type: "done", usage: null } : { type: "error", code: "EMPTY" })
    return chars > 0 ? { ...usage, ok: true } : { ...usage, error: "EMPTY" }
  }
  return { provider: "anthropic", model: candidates.at(-1) ?? "", ok: false, error: "UPSTREAM", promptTokens: 0, completionTokens: 0 }
}
