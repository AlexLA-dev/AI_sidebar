import { API_BASE } from "../shared/config"
import { systemPrompt } from "../shared/prompt"
import { sseData } from "../shared/sse"
import type { AskPayload, ErrorCode, Plan, StreamEvent, Usage } from "../shared/types"

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
        action: req.payload.action
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
      let event: { type?: string; text?: string; plan?: Plan; usage?: Usage; code?: ErrorCode; message?: string }
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === "meta") emit({ type: "meta", plan: event.plan ?? "free", usage: event.usage ?? null, viaOwnKey: false })
      else if (event.type === "delta" && event.text) emit({ type: "delta", text: event.text })
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

const OWN_KEY_MODELS = ["gpt-4.1-mini", "gpt-4o-mini"]

/** Streams an answer straight from OpenAI with the user's own key. */
export async function askWithOwnKey(
  key: string,
  payload: AskPayload,
  profile: string,
  locale: string,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  const system = systemPrompt(payload.page, profile, locale)
  let res: Response | null = null
  for (const model of OWN_KEY_MODELS) {
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: 1500,
          temperature: 0.4,
          messages: [{ role: "system", content: system }, ...payload.messages]
        }),
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
