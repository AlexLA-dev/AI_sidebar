import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent, maybeCleanup, refund, touchInstall, type ConsumeResult } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson, corsHeaders } from "../shared/http.mts"
import { buildGrounding, googlePrompt, readGoogle, startGoogle, type GoogleStats } from "../shared/google.mts"
import { readDeltas, sanitizeMessages, sanitizeOtherPages, sanitizePage, startCompletion, systemPrompt } from "../shared/llm.mts"
import { geminiModels, modelsFor } from "../shared/models.mts"
import { blockReason, countersFor, proOffer, resolveAccess, searchCountersFor, visibleUsage } from "../shared/plan.mts"

/**
 * POST /api/v2/chat — streaming answer about the current page.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS>,
 *         messages: [{role, content}], page?: {kind, title, url, text}, profile?, action?, mode?: "google",
 *         context?: "chat" (the whole conversation and notes), pages?: [{title, url, text}] (its other pages) }
 * Response: text/event-stream of `data: {"type": "meta"|"delta"|"grounding"|"done"|"error", …}` lines
 * ("grounding" only in Google mode: the final text with citations, sources and Search Suggestions),
 * or JSON {code, …} with a 4xx/5xx status when the request is refused before streaming.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 300_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const wholeChat = body.context === "chat"
  const messages = sanitizeMessages(body.messages, wholeChat)
  if (!messages) return json({ code: "BAD_REQUEST", message: "messages required" }, 400)
  const page = sanitizePage(body.page)
  const others = wholeChat ? sanitizeOtherPages(body.pages) : []
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const google = body.mode === "google"
  if (google && !settings.geminiKey) return json({ code: "SEARCH_UNAVAILABLE", message: "Google search is not available right now." }, 503)

  const access = await resolveAccess(body.entitlement, installId)
  const counters = [...countersFor(access, installId, ipSubject(context.ip)), ...(google ? searchCountersFor(access, installId) : [])]

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
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, platform, version, mode: google ? "google" : "chat" }))
    const code = reason === "busy" ? "BUSY" : reason === "search" ? "SEARCH_LIMIT" : "LIMIT_REACHED"
    // Out of free answers: the App Store offer code for Pro.
    const offer = code === "LIMIT_REACHED" ? proOffer(access) : null
    return json({ code, plan: access.plan, usage, offer }, reason === "busy" ? 503 : 402)
  }

  const profile = clip(body.profile, 1_000)
  let completion
  try {
    completion = google
      ? await startGoogle(googlePrompt(page, profile, locale, others), messages, await geminiModels(), req.signal)
      : await startCompletion(systemPrompt(page, profile, locale, others), messages, await modelsFor(access.plan), req.signal)
  } catch (err) {
    console.error("[cf] upstream failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, {
        message: err instanceof Error ? err.message.slice(0, 300) : "unknown",
        mode: google ? "google" : "chat",
        provider: google ? "gemini" : "openai",
        platform,
        version
      })
    ]))
    return json({ code: "UPSTREAM", message: "The AI service is busy. Please try again in a moment." }, 502)
  }

  const started = Date.now()
  const stats: GoogleStats = { promptTokens: 0, completionTokens: 0, chars: 0, grounding: null }
  const encoder = new TextEncoder()
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))

  let succeeded = false
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let ok = false
      try {
        send(controller, { type: "meta", plan: access.plan, usage, model: completion.model, entitlementError: access.entitlementError })
        let answer = ""
        for await (const text of (google ? readGoogle : readDeltas)(completion.body, stats)) {
          answer += text
          send(controller, { type: "delta", text })
        }
        ok = stats.chars > 0
        const grounded = ok && google ? buildGrounding(answer, stats.grounding) : null
        if (grounded) send(controller, { type: "grounding", ...grounded })
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
        succeeded = ok
        finished()
      }
    }
  })

  context.waitUntil(done.then(() => Promise.all([
    logEvent("chat", installId, {
      // Analytics segments: whose key paid (ours / the user's own) and Google vs other AI.
      key: "ours",
      provider: google ? "gemini" : "openai",
      ok: succeeded,
      plan: access.plan,
      model: completion.model,
      action: clip(body.action, 32) || null,
      mode: google ? "google" : "chat",
      search_queries: stats.grounding?.webSearchQueries?.length ?? 0,
      page: page ? page.kind : "none",
      page_chars: page?.text.length ?? 0,
      history: messages.length,
      ...(wholeChat ? { whole_chat: true, other_pages: others.length } : {}),
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
