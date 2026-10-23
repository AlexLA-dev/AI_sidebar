import type { Context } from "@netlify/functions"

import { config } from "../shared/config.mts"
import { consume, db, entitlementByToken, logEvent, refund, type Counter } from "../shared/db.mts"
import { corsHeaders, ipSubject, json, preflight, readJson } from "../shared/http.mts"
import { readDeltas, startCompletion, type StreamStats } from "../shared/llm.mts"

/**
 * /.netlify/functions/chat-proxy — compatibility endpoint for the extension
 * builds that are already installed (<= build 40). They send their own system
 * prompt and expect `data: {"content": …}` / `data: [DONE]` frames.
 * New builds use /api/v2/chat.
 */
type LegacyMessage = { role: "system" | "user" | "assistant"; content: string }

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const body = await readJson(req, 300_000)
  if (!body) return json({ error: "Invalid JSON body" }, 400)
  const messages = sanitizeLegacy(body.messages)
  if (!messages) return json({ error: "Messages array is required" }, 400)

  const counters: Counter[] = []
  let plan = "legacy_anonymous"
  let userId: string | null = null

  const auth = req.headers.get("Authorization")
  if (auth?.startsWith("Bearer ")) {
    const { data } = await db().auth.getUser(auth.slice(7)).catch(() => ({ data: { user: null } }))
    userId = data.user?.id ?? null
  }

  if (userId) {
    const ent = await entitlementByToken(userId).catch(() => null)
    const active = ent?.product_id.includes("pro") && ent.expires_at &&
      Date.parse(ent.expires_at) + config.entitlementLeewayMs > Date.now()
    if (active && ent) {
      plan = "legacy_pro"
      counters.push({ subject: `tx:${ent.original_transaction_id}`, period: "week", limit: config.proWeeklyLimit })
    } else {
      plan = "legacy_user"
      counters.push(
        { subject: `user:${userId}`, period: "day", limit: config.freeDailyLimit },
        { subject: "global:free", period: "day", limit: config.freeGlobalDailyLimit }
      )
    }
  } else {
    if (!body.anonymous) return json({ error: "Missing or invalid authorization header" }, 401)
    counters.push(
      { subject: `legacy-${ipSubject(context.ip)}`, period: "day", limit: config.legacyIpDailyLimit },
      { subject: "global:free", period: "day", limit: config.freeGlobalDailyLimit }
    )
  }

  const quota = await consume(counters).catch((err) => {
    console.error("[legacy] consume failed:", err instanceof Error ? err.message : err)
    return null
  })
  if (!quota) return json({ error: "Service temporarily unavailable" }, 503)
  if (!quota.allowed) {
    context.waitUntil(logEvent("limit", null, { plan, reason: quota.blocked?.split(":")[0] }))
    return json({ error: "Free requests for today are used up. Update ContextFlow in the App Store for the new version.", code: "CREDITS_EXHAUSTED", credits_remaining: 0 }, 403)
  }

  const [system, ...rest] = messages[0].role === "system" ? messages : [{ role: "system", content: "" } as LegacyMessage, ...messages]
  const chat = rest.filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system")

  let completion
  try {
    completion = await startCompletion(system.content || "You are ContextFlow, a helpful AI browser assistant.", chat, req.signal)
  } catch (err) {
    console.error("[legacy] upstream failed:", err instanceof Error ? err.message : err)
    context.waitUntil(refund(counters).catch(() => undefined))
    return json({ error: "The AI service is busy. Please try again." }, 502)
  }

  const stats: StreamStats = { promptTokens: 0, completionTokens: 0, chars: 0 }
  const encoder = new TextEncoder()
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const text of readDeltas(completion.body, stats)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } catch (err) {
        console.error("[legacy] stream failed:", err instanceof Error ? err.message : err)
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
        if (stats.chars === 0) await refund(counters).catch(() => undefined)
        finished()
      }
    }
  })

  context.waitUntil(done.then(() => logEvent("chat", null, {
    plan, model: completion.model, prompt_tokens: stats.promptTokens, completion_tokens: stats.completionTokens, legacy: true
  })))

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" }
  })
}

function sanitizeLegacy(raw: unknown): LegacyMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: LegacyMessage[] = []
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return
    const { role, content } = item as { role?: unknown; content?: unknown }
    if (typeof content !== "string") return
    if (role === "system" && index === 0) out.push({ role, content: content.slice(0, 40_000) })
    else if (role === "user" || role === "assistant") out.push({ role, content: content.slice(0, 6_000) })
  })
  const last = out[out.length - 1]
  if (!last || last.role !== "user") return null
  return [out[0], ...out.slice(1).slice(-12)]
}
