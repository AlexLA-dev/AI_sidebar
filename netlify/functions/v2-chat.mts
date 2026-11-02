import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent, maybeCleanup, refund, touchInstall, type ConsumeResult } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson, corsHeaders } from "../shared/http.mts"
import { buildGrounding, googlePrompt, readGoogle, startGoogle, type GoogleStats } from "../shared/google.mts"
import { answerCost, clientBuild, startAnswer, type Answer } from "../shared/answer.mts"
import { sanitizeMessages, sanitizeOtherPages, sanitizePage, systemPrompt } from "../shared/llm.mts"
import { geminiModels } from "../shared/models.mts"
import { pageForModel } from "../../src/shared/attachments.ts"
import { MAX_APP_OTHER_PAGES, MAX_OTHER_PAGES } from "../../src/shared/prompt.ts"
import { historyPrompt, MAX_HISTORY_CHARS, MAX_HISTORY_CHATS, sanitizeDigests } from "../../src/shared/history.ts"
import { blockReason, countersFor, proOffer, resolveAccess, searchCountersFor, visibleUsage } from "../shared/plan.mts"

/**
 * POST /api/v2/chat — streaming answer about the current page.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS>,
 *         messages: [{role, content}], page?: {kind, title, url, text}, profile?, action?, mode?: "google",
 *         context?: "chat" (the whole conversation and notes), pages?: [{title, url, text}] (its other pages),
 *         from?: "app" (with context "chat": asked in the ContextFlow app; page and pages are the chat's saved texts),
 *         context?: "history" with history: [{id, title, date, text}] — "Ask your chats", Pro only (no page) }
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
  // Asked in the ContextFlow app about a saved chat (its page texts, if saved), not on a page.
  const fromApp = wholeChat && body.from === "app"
  // "Ask your chats": answered from a digest of all the user's chats instead of a page (Pro).
  const history = body.context === "history"
  const messages = sanitizeMessages(body.messages, wholeChat)
  if (!messages) return json({ code: "BAD_REQUEST", message: "messages required" }, 400)
  const sent = history ? null : sanitizePage(body.page)
  const chats = history ? sanitizeDigests(body.history, MAX_HISTORY_CHATS, MAX_HISTORY_CHARS) : []
  const others = wholeChat ? sanitizeOtherPages(body.pages, fromApp ? MAX_APP_OTHER_PAGES : MAX_OTHER_PAGES) : []
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  // The app build (2.4 build 67 and later send it): Claude answers only builds that name it.
  const build = clientBuild(client)
  const google = body.mode === "google" && !history
  if (google && !settings.geminiKey) return json({ code: "SEARCH_UNAVAILABLE", message: "Google search is not available right now." }, 503)

  const access = await resolveAccess(body.entitlement, installId)
  // Video transcripts and PDFs are Pro: for anyone else they're left out here, whatever the panel sent.
  const page = sent && pageForModel(sent, access.plan === "pro")
  // Pro features are checked here, not in the panel: nothing is charged or asked without Pro.
  if (history && access.plan !== "pro") {
    context.waitUntil(logEvent("pro_only", installId, { feature: "history", plan: access.plan, platform, version }))
    return json({ code: "PRO_ONLY", plan: access.plan, feature: "history" }, 403)
  }
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
  // Google mode: Gemini with Google Search. Everything else: Claude first, OpenAI when Claude can't.
  let completion: { model: string; body: ReadableStream<Uint8Array> } | null = null
  let answer: Answer | null = null
  try {
    if (google) completion = await startGoogle(googlePrompt(page, profile, locale, others), messages, await geminiModels(), req.signal)
    else answer = await startAnswer(history ? historyPrompt(chats, profile, locale) : systemPrompt(page, profile, locale, others, fromApp), messages, access.plan === "pro" ? "pro" : "free", build, req.signal)
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

  const model = completion?.model ?? answer?.model ?? ""
  const provider = google ? "gemini" : answer?.provider ?? "openai"
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
        send(controller, { type: "meta", plan: access.plan, usage, model, entitlementError: access.entitlementError })
        let full = ""
        for await (const text of completion ? readGoogle(completion.body, stats) : answer!.text(stats)) {
          full += text
          send(controller, { type: "delta", text })
        }
        ok = stats.chars > 0
        const grounded = ok && google ? buildGrounding(full, stats.grounding) : null
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
      provider,
      // Why OpenAI answered instead of Claude (no key, credits, rate limit, …); and Claude's cost.
      ...(answer?.fallback ? { fallback: answer.fallback } : {}),
      ...(answer?.provider === "anthropic" ? { cost_usd: answerCost(answer, stats) } : {}),
      ok: succeeded,
      plan: access.plan,
      // The subscription that paid for it: /analytics shows each subscriber's device and language.
      ...(access.entitlement ? { otid: access.entitlement.originalTransactionId } : {}),
      model,
      action: clip(body.action, 32) || null,
      mode: google ? "google" : history ? "history" : "chat",
      search_queries: stats.grounding?.webSearchQueries?.length ?? 0,
      page: page ? page.kind : "none",
      page_chars: page?.text.length ?? 0,
      // A video's transcript or PDFs went with it (Pro), or the page had them and they were left out.
      ...(page?.media ? { media: page.media } : {}),
      ...(page?.skipped?.length ? { skipped: page.skipped.join(",") } : {}),
      history: messages.length,
      ...(wholeChat ? { whole_chat: true, other_pages: others.length } : {}),
      ...(history ? { history_chats: chats.length, history_chars: chats.reduce((n, c) => n + c.text.length, 0) } : {}),
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      ms: Date.now() - started,
      platform,
      version,
      build
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
