import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, giveTourAnswerBack, logEvent, maybeCleanup, peek, refund, takeTourAnswer, touchInstall, type ConsumeResult } from "../shared/db.mts"
import { installCounter, tourAsked, tourCounters } from "../shared/tour.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson, corsHeaders } from "../shared/http.mts"
import { buildGrounding, googlePrompt, readGoogle, startGoogle, type GoogleStats } from "../shared/google.mts"
import { answerCost, clientBuild, startAnswer, type Answer } from "../shared/answer.mts"
import { freeMemory, sanitizeMessages, sanitizeOtherPages, sanitizePage, systemPromptParts } from "../shared/llm.mts"
import { geminiModels } from "../shared/models.mts"
import { pageForModel } from "../../src/shared/attachments.ts"
import { hasMarks, MAX_APP_OTHER_PAGES, MAX_OTHER_PAGES } from "../../src/shared/prompt.ts"
import { uiFields } from "../../src/shared/usage.ts"
import { historyPrompt, MAX_HISTORY_CHARS, MAX_HISTORY_CHATS, sanitizeDigests } from "../../src/shared/history.ts"
import { blockReason, countersFor, hasPro, proOffer, resolveAccess, searchCountersFor, visibleUsage } from "../shared/plan.mts"
import { chatSize, digestCut, limitsHit } from "../shared/limits.mts"
import { pageBucket, pageChars, requestWeight } from "../shared/weight.mts"

/**
 * POST /api/v2/chat — streaming answer about the current page.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS>,
 *         messages: [{role, content}], page?: {kind, title, url, text}, profile?, action?, mode?: "google",
 *         context?: "chat" (the whole conversation and notes), pages?: [{title, url, text}] (its other pages),
 *         from?: "app" (with context "chat": asked in the ContextFlow app; page and pages are the chat's saved texts),
 *         stats?: {turns, pages, chats} (2.4: the chat's messages and pages and the device's chats, for /analytics),
 *         context?: "history" with history: [{id, title, date, text}] — "Ask your chats", Pro only (no page),
 *         tour?: true (2.6: asked in the guided first request; free for an install's first few, tour.mts) }
 * Response: text/event-stream of `data: {"type": "meta"|"delta"|"grounding"|"done"|"error", …}` lines
 * ("grounding" only in Google mode: the final text with citations, sources and Search Suggestions),
 * or JSON {code, …} with a 4xx/5xx status when the request is refused before streaming.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  // A page comes whole (2.5): up to the function's request limit, 6 MB (the panel keeps the page to 4 MB of it).
  const body = await readJson(req, 6_000_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const wholeChat = body.context === "chat"
  // Asked in the ContextFlow app about a saved chat (its page texts, if saved), not on a page.
  const fromApp = wholeChat && body.from === "app"
  // "Ask your chats": answered from a digest of all the user's chats instead of a page (Pro).
  const history = body.context === "history"
  let messages = sanitizeMessages(body.messages, wholeChat)
  if (!messages) return json({ code: "BAD_REQUEST", message: "messages required" }, 400)
  const sent = history ? null : sanitizePage(body.page)
  const chats = history ? sanitizeDigests(body.history, MAX_HISTORY_CHATS, MAX_HISTORY_CHARS) : []
  let others = wholeChat ? sanitizeOtherPages(body.pages, fromApp ? MAX_APP_OTHER_PAGES : MAX_OTHER_PAGES) : []
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  // The app build (2.4 build 67 and later send it): Claude answers only builds that name it.
  const build = clientBuild(client)
  const google = body.mode === "google" && !history
  // The step this answer is in the user's session (where it was asked, the step before), for /analytics;
  // a question from the app says so even from builds that don't send it.
  const step = {
    ...(fromApp ? { s: "app" } : {}),
    ...uiFields(body.ui, history ? "ask_chats" : "ask"),
    ...(client.audience === "test" ? { audience: "test" } : {})
  }
  if (google && !settings.geminiKey) return json({ code: "SEARCH_UNAVAILABLE", message: "Google search is not available right now." }, 503)

  const access = await resolveAccess(body.entitlement, installId)
  // 2.6 (build 91): the whole chat (every message, the notes, its other pages) is Pro's memory. A free request for it
  // (a 2.5 panel with "Whole chat" on, a chat continued in the app) is answered as any free answer, with the last
  // messages only: trimmed, never refused.
  const memory = wholeChat && hasPro(access.plan)
  if (wholeChat && !memory) others = []
  // Free (build 92, the owner): the last 5 answers and notes, whatever the client sent (2.5 sends 12 messages, the
  // whole chat with "Whole chat" on).
  if (!hasPro(access.plan) && !history) messages = freeMemory(sanitizeMessages(body.messages, true) ?? messages)
  // Video transcripts and PDFs are Pro: for anyone else they're left out here, whatever the panel sent.
  const page = sent && pageForModel(sent, hasPro(access.plan))
  // Pro features are checked here, not in the panel: nothing is charged or asked without Pro.
  if (history && !hasPro(access.plan)) {
    context.waitUntil(logEvent("pro_only", installId, { feature: "history", plan: access.plan, platform, version, ...step }))
    return json({ code: "PRO_ONLY", plan: access.plan, feature: "history" }, 403)
  }
  // A long page counts as several answers, charged in full or not at all (weight.mts); Google mode and
  // "Ask your chats" as one.
  const weight = google || history ? 1 : requestWeight(page, messages)
  // Asked in the guided first request (2.6): not charged to the install's daily answers, for its first few.
  const tour = tourAsked(body, access.plan, google, history)
    ? await takeTourAnswer(installId, settings.tourFreeAnswers).catch(() => false)
    : false
  const giveBack = () => (tour ? giveTourAnswerBack(installId).catch(() => undefined) : Promise.resolve(undefined))
  const own = countersFor(access, installId, ipSubject(context.ip))
  const counters = [
    ...tourCounters(own, installId, tour).map((c) => (weight > 1 ? { ...c, amount: weight } : c)),
    ...(google ? searchCountersFor(access, installId) : [])
  ]

  let quota: ConsumeResult
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    if (!hasPro(access.plan)) {
      context.waitUntil(giveBack())
      return json({ code: "UNAVAILABLE", message: "Service temporarily unavailable" }, 503)
    }
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  // A free guided answer left the install's counter alone: the person still sees where it stands.
  const usage = tour
    ? await peek(own.filter((c) => c.subject === installCounter(installId))).then((rows) => visibleUsage(access, rows), () => null)
    : visibleUsage(access, quota.counters)

  if (!quota.allowed) {
    context.waitUntil(giveBack())
    const reason = blockReason(quota.blocked)
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, platform, version, mode: google ? "google" : "chat", ...(weight > 1 ? { weight } : {}), ...step }))
    const code = reason === "busy" ? "BUSY" : reason === "search" ? "SEARCH_LIMIT" : "LIMIT_REACHED"
    // Out of free answers: the App Store offer code for Pro.
    const offer = code === "LIMIT_REACHED" ? proOffer(access) : null
    // weight: the page is long and the answers left don't cover it (the panel says so).
    return json({ code, plan: access.plan, usage, offer, ...(weight > 1 ? { weight } : {}) }, reason === "busy" ? 503 : 402)
  }

  const profile = clip(body.profile, 1_000)
  // Google mode: Gemini with Google Search. Everything else: Claude first, OpenAI when Claude can't.
  let completion: { model: string; body: ReadableStream<Uint8Array> } | null = null
  let answer: Answer | null = null
  try {
    if (google) completion = await startGoogle(googlePrompt(page, profile, locale, others, hasMarks(messages)), messages, await geminiModels(), req.signal)
    else answer = await startAnswer(history ? historyPrompt(chats, profile, locale, body.links === true) : (tokens) => systemPromptParts(page, profile, locale, others, fromApp, hasMarks(messages), tokens), messages, hasPro(access.plan) ? "pro" : "free", build, req.signal)
  } catch (err) {
    console.error("[cf] upstream failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      giveBack(),
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
        if (!ok) await Promise.all([refund(counters).catch(() => undefined), giveBack()])
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
      ...(memory ? { whole_chat: true, other_pages: others.length } : {}),
      // Asked for the whole chat without Pro: answered with the last messages (build 91).
      ...(wholeChat && !memory ? { memory_trimmed: true } : {}),
      ...(history ? { history_chats: chats.length, history_chars: chats.reduce((n, c) => n + c.text.length, 0) } : {}),
      // The limits it ran into (cf_limits_report), and how big the user's chat is (2.4).
      ...limitsHit({ sent, page, sentMessages: Array.isArray(body.messages) ? body.messages.length : 0, messages: messages.length, others, answerCut: stats.cut === true }),
      ...(history && digestCut(body.history, chats, MAX_HISTORY_CHARS) ? { digest_cut: true } : {}),
      ...chatSize(body.stats),
      // How many answers it counted as, and the page's length, to set against cost_usd (2.5).
      weight,
      // Asked in the guided first request (2.6), and whether it was left out of the daily answers.
      ...(body.tour === true ? { tour: true, tour_free: tour } : {}),
      ...(page?.kind === "page" ? { page_bucket: pageBucket(pageChars(page)) } : {}),
      prompt_tokens: stats.promptTokens,
      ...(stats.cacheWriteTokens ? { cache_write_tokens: stats.cacheWriteTokens } : {}),
      ...(stats.cacheReadTokens ? { cache_read_tokens: stats.cacheReadTokens } : {}),
      completion_tokens: stats.completionTokens,
      ms: Date.now() - started,
      platform,
      version,
      build,
      ...step
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
