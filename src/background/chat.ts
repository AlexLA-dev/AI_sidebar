import { API_BASE } from "../shared/config"
import { isReasoningGpt, keyProvider, newestGptModel, type ModelTier } from "../shared/models"
import { systemPrompt } from "../shared/prompt"
import { sseData } from "../shared/sse"
import { STORAGE, type AskPayload, type ErrorCode, type Grounding, type Plan, type StreamEvent, type Usage } from "../shared/types"
import { askClaude } from "./claude"

type Emit = (event: StreamEvent) => void

const FIRST_BYTE_TIMEOUT_MS = 30_000

interface ServerRequest {
  installId: string
  client: { version: string; platform: string; locale: string }
  entitlement: string | null
  profile: string
  payload: AskPayload
}

/** Streams an answer from our backend (/api/v2/chat). */
export async function askServer(req: ServerRequest, emit: Emit, signal: AbortSignal): Promise<void> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), FIRST_BYTE_TIMEOUT_MS)
  signal.addEventListener("abort", () => timeout.abort())

  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/v2/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: req.installId,
        client: req.client,
        entitlement: req.entitlement,
        profile: req.profile,
        messages: req.payload.messages,
        page: req.payload.page,
        action: req.payload.action,
        mode: req.payload.mode
      }),
      signal: timeout.signal
    })
  } catch {
    clearTimeout(timer)
    if (!signal.aborted) emit({ type: "error", code: timeout.signal.aborted ? "UPSTREAM" : "NETWORK" })
    return
  }
  clearTimeout(timer)

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: ErrorCode; usage?: Usage; plan?: Plan; message?: string }
    emit({ type: "error", code: body.code ?? (res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST"), usage: body.usage ?? null, plan: body.plan, message: body.message })
    return
  }

  let finished = false
  try {
    for await (const data of sseData(res.body)) {
      let event: { type?: string; text?: string; plan?: Plan; usage?: Usage; code?: ErrorCode; message?: string; grounding?: Grounding }
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === "meta") emit({ type: "meta", plan: event.plan ?? "free", usage: event.usage ?? null, viaOwnKey: false })
      else if (event.type === "delta" && event.text) emit({ type: "delta", text: event.text })
      else if (event.type === "grounding" && event.text && event.grounding) emit({ type: "grounding", text: event.text, grounding: event.grounding })
      else if (event.type === "done") {
        finished = true
        emit({ type: "done", usage: event.usage ?? null })
      } else if (event.type === "error") {
        finished = true
        emit({ type: "error", code: event.code ?? "STREAM", message: event.message })
      }
    }
  } catch {
    // connection dropped mid-answer
  }
  if (!finished && !signal.aborted) emit({ type: "error", code: "STREAM" })
}

// Used when the model list can't be read; newer models are picked up from the list.
const OPENAI_FALLBACK_MODELS: Record<ModelTier, string[]> = { smart: ["gpt-5", "gpt-4.1"], fast: ["gpt-5-mini", "gpt-4.1-mini"] }
const MODEL_LIST_TTL_MS = 24 * 3600_000
const MAX_OUTPUT_TOKENS = 1500

async function newestGpt(key: string, tier: ModelTier, signal: AbortSignal): Promise<string | null> {
  const stored = ((await chrome.storage.local.get(STORAGE.ownKeyModels))[STORAGE.ownKeyModels] ?? {}) as { openai?: { ids: string[]; at: number } }
  let list = stored.openai
  if (!list || Date.now() - list.at > MODEL_LIST_TTL_MS) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal })
      if (res.ok) {
        const body = (await res.json()) as { data?: { id?: unknown }[] }
        list = { ids: (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"), at: Date.now() }
        await chrome.storage.local.set({ [STORAGE.ownKeyModels]: { ...stored, openai: list } })
      }
    } catch {
      // offline or blocked: the fallback models below still work
    }
  }
  return list ? newestGptModel(list.ids, tier) : null
}

/** Streams an answer with the user's own key: Anthropic keys go to Claude, the rest to OpenAI. */
export async function askWithOwnKey(
  key: string,
  payload: AskPayload,
  profile: string,
  locale: string,
  tier: ModelTier,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  if (keyProvider(key) === "anthropic") return askClaude(key, payload, profile, locale, tier, emit, signal)

  const system = systemPrompt(payload.page, profile, locale)
  const models = [...new Set([await newestGpt(key, tier, signal), ...OPENAI_FALLBACK_MODELS[tier]].filter((m): m is string => Boolean(m)))]
  let res: Response | null = null
  for (const model of models) {
    const body: Record<string, unknown> = { model, stream: true, messages: [{ role: "system", content: system }, ...payload.messages] }
    if (isReasoningGpt(model)) {
      body.max_completion_tokens = MAX_OUTPUT_TOKENS + 2048
      body.reasoning_effort = "low"
    } else {
      body.max_tokens = MAX_OUTPUT_TOKENS
      body.temperature = 0.4
    }
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal
      })
    } catch {
      if (!signal.aborted) emit({ type: "error", code: "NETWORK" })
      return
    }
    if (res.status !== 404) break
  }
  if (!res) return

  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    if (res.status === 401) emit({ type: "error", code: "BAD_KEY" })
    else emit({ type: "error", code: res.status === 429 ? "BUSY" : "UPSTREAM", message: detail.error?.message })
    return
  }

  emit({ type: "meta", plan: "byok", usage: null, viaOwnKey: true })
  let chars = 0
  try {
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const text = chunk.choices?.[0]?.delta?.content
        if (text) {
          chars += text.length
          emit({ type: "delta", text })
        }
      } catch {
        // ignore keep-alive / partial frames
      }
    }
  } catch {
    if (!signal.aborted) emit({ type: "error", code: "STREAM" })
    return
  }
  emit(chars > 0 ? { type: "done", usage: null } : { type: "error", code: "EMPTY" })
}
