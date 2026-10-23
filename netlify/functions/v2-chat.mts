import type { Config, Context } from "@netlify/functions"

import { consume, logEvent, maybeCleanup, refund, touchInstall, type ConsumeResult } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson, corsHeaders } from "../shared/http.mts"
import { readDeltas, sanitizeMessages, sanitizePage, startCompletion, systemPrompt, type StreamStats } from "../shared/llm.mts"
import { blockReason, countersFor, resolveAccess, visibleUsage } from "../shared/plan.mts"

/**
 * POST /api/v2/chat — streaming answer about the current page.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS>,
 *         messages: [{role, content}], page?: {kind, title, url, text}, profile?, action? }
 * Response: text/event-stream of `data: {"type": "meta"|"delta"|"done"|"error", …}` lines,
 * or JSON {code, …} with a 4xx/5xx status when the request is refused before streaming.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 300_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const messages = sanitizeMessages(body.messages)
  if (!messages) return json({ code: "BAD_REQUEST", message: "messages required" }, 400)
  const page = sanitizePage(body.page)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)

  const access = await resolveAccess(body.entitlement, installId)
  const counters = countersFor(access, installId, ipSubject(context.ip))

  let quota: ConsumeResult
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    if (access.plan !== "pro") return json({ code: "UNAVAILABLE", message: "Service temporarily unavailable" }, 503)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  const usage = visibleUsage(access, quota.counters)

  if (!quota.allowed) {
    const reason = blockReason(quota.blocked)
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, platform }))
    const code = reason === "busy" ? "BUSY" : "LIMIT_REACHED"
    return json({ code, plan: access.plan, usage }, reason === "busy" ? 503 : 402)
  }

  const system = systemPrompt(page, clip(body.profile, 1_000), locale)
  let completion
  try {
    completion = await startCompletion(system, messages, req.signal)
  } catch (err) {
    console.error("[cf] upstream failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown" })
    ]))
    return json({ code: "UPSTREAM", message: "The AI service is busy. Please try again in a moment." }, 502)
  }

  const started = Date.now()
  const stats: StreamStats = { promptTokens: 0, completionTokens: 0, chars: 0 }
  const encoder = new TextEncoder()
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))

  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let ok = false
      try {
        send(controller, { type: "meta", plan: access.plan, usage, model: completion.model, entitlementError: access.entitlementError })
        for await (const text of readDeltas(completion.body, stats)) send(controller, { type: "delta", text })
        ok = stats.chars > 0
        send(controller, ok ? { type: "done", usage } : { type: "error", code: "EMPTY", message: "Empty answer, please retry." })
      } catch (err) {
        console.error("[cf] stream failed:", err instanceof Error ? err.message : err)
        try {
          send(controller, { type: "error", code: "STREAM", message: "Connection interrupted. Please retry." })
        } catch {
          // client already gone
        }
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
        if (!ok) await refund(counters).catch(() => undefined)
        finished()
      }
    }
  })

  context.waitUntil(done.then(() => Promise.all([
    logEvent("chat", installId, {
      plan: access.plan,
      model: completion.model,
      action: clip(body.action, 32) || null,
      page: page ? page.kind : "none",
      page_chars: page?.text.length ?? 0,
      history: messages.length,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      ms: Date.now() - started,
      platform,
      version
    }),
    touchInstall(installId, platform, version, locale, 1).catch(() => undefined),
    maybeCleanup()
  ])))

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  })
}

export const config: Config = { path: "/api/v2/chat" }
