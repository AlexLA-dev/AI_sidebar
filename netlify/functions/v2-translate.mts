import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type ConsumeResult, type Counter } from "../shared/db.mts"
import { clip, corsHeaders, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { blockReason, hasPro, proOffer, resolveAccess, visibleUsage, type Usage } from "../shared/plan.mts"
import { haikuCall, runTranslation, type Effort, safetyReason, translateCost, translateCounters, type TranslateStats } from "../shared/translate.mts"
import { sessionFields } from "../../src/shared/usage.ts"
import { TRANSLATE_LIMITS, type TranslateBlock } from "../../src/shared/translate.ts"

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/
const PAGE = /^[0-9a-f]{16,64}$/

/**
 * POST /api/v2/translate — a page translated in place (2.7, Claude Haiku). Nothing sent here is stored; the logs get
 * counts. A page is one answer (the owner's rule): the first request of a page this week charges it, the rest of the
 * same page (more blocks as the person scrolls, translating again after "Original") don't.
 *
 * Body: { installId, client, entitlement, page: <hash of the address and language>, to, from?, first?,
 *         blocks: [{id, text}] (marked text, src/shared/translate.ts) }
 * Response: text/event-stream of `data: {"type": "meta"|"items"|"skip"|"done"|"error", …}`:
 *   meta {charged, usage}; items {items: [{id, text}]} as lines come; skip {ids} (the tags couldn't be kept: left as
 *   they are); done {left: [ids]} (not reached in time: may be asked again); error {code} (nothing was translated).
 * Refused before streaming (JSON {code}): LIMIT_REACHED 402 {usage, offer}, PAGE_CAP 413, BUSY 503, UNAVAILABLE 400/503,
 * BAD_REQUEST 400.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 200_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const to = clip(body.to, 16)
  const from = typeof body.from === "string" && LANG.test(body.from) ? body.from : null
  const page = clip(body.page, 64)
  if (!LANG.test(to) || !PAGE.test(page)) return json({ code: "BAD_REQUEST", message: "to and page required" }, 400)
  const blocks = readBlocks(body.blocks)
  if (!blocks.length) return json({ code: "BAD_REQUEST", message: "blocks required" }, 400)
  const chars = blocks.reduce((n, b) => n + b.text.length, 0)
  const first = body.first === true
  // Off production only (deploy previews, netlify dev): a request may name the model's effort, to compare them.
  const deploy = (globalThis as { Netlify?: { context?: { deploy?: { context?: string } } | null } }).Netlify?.context?.deploy?.context ?? process.env.CONTEXT
  const effort: Effort = deploy && deploy !== "production" && ["low", "medium", "high"].includes(String(body.effort)) ? (body.effort as Effort) : settings.translate.effort
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  const test = client.audience === "test" ? { audience: "test" } : {}
  // Claude answers only builds whose consent screen names it (as for answers).
  if (settings.claudeMinBuild > 0 && !(Number(build) >= settings.claudeMinBuild)) return json({ code: "UNAVAILABLE", message: "update the app" }, 400)
  if (!settings.translate.enabled || !settings.anthropicKey) return json({ code: "UNAVAILABLE" }, 503)

  const access = await resolveAccess(body.entitlement, installId)
  const counters = translateCounters(access, installId, ipSubject(context.ip), page, chars)
  const base = { plan: access.plan, to, ...(from ? { from } : {}), first, blocks: blocks.length, chars_in: chars, platform, version, build, ...test, ...sessionFields(body.ui as Record<string, unknown>) }

  // 1. The page: charged this week already, or charged now (one answer). 2. The hidden caps, in characters.
  let charged: Counter[] = []
  let caps: Counter[] = []
  let usage: Usage | null = null
  try {
    const mark = await consume([counters.page])
    if (mark.allowed) {
      const answer: ConsumeResult = await consume(counters.answer)
      if (!answer.allowed) {
        await refund([counters.page]).catch(() => undefined)
        const reason = blockReason(answer.blocked)
        context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, mode: "translate", platform, version, ...test }))
        if (reason === "busy") return json({ code: "BUSY" }, 503)
        return json({ code: "LIMIT_REACHED", plan: access.plan, usage: visibleUsage(access, answer.counters), offer: proOffer(access) }, 402)
      }
      charged = [counters.page, ...counters.answer]
      usage = visibleUsage(access, answer.counters)
    }
    const safety = await consume(counters.safety)
    if (!safety.allowed) {
      await refund(charged).catch(() => undefined)
      const code = safetyReason(safety.blocked)
      context.waitUntil(logEvent("translate", installId, { ...base, ok: false, error: code }))
      return json({ code }, code === "PAGE_CAP" ? 413 : 503)
    }
    caps = counters.safety
  } catch (err) {
    console.error("[cf] translate consume failed:", err instanceof Error ? err.message : err)
    // As for answers: the free plan waits for the counters, a subscription isn't locked out by them.
    await refund(charged).catch(() => undefined)
    if (!hasPro(access.plan)) return json({ code: "UNAVAILABLE", message: "Service temporarily unavailable" }, 503)
    charged = []
  }

  const stats: TranslateStats = { model: settings.translate.model, calls: 0, promptTokens: 0, completionTokens: 0, firstMs: null, failedCalls: 0, retried: 0 }
  const started = Date.now()
  const encoder = new TextEncoder()
  const abort = new AbortController()
  req.signal.addEventListener("abort", () => abort.abort())
  const timer = setTimeout(() => abort.abort(), settings.translate.budgetMs)
  let outcome = { done: 0, skipped: [] as string[], left: [] as string[] }
  let charsOut = 0
  let finished!: () => void
  const ended = new Promise<void>((resolve) => (finished = resolve))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          // the page went away
        }
      }
      try {
        send({ type: "meta", charged: charged.length > 0, usage })
        outcome = await runTranslation(blocks, {
          to, from, first, call: haikuCall(stats, effort), stats, signal: abort.signal,
          batchChars: first ? settings.translate.firstBatchChars : settings.translate.batchChars,
          parallel: Math.max(1, settings.translate.parallel),
          onItems: (items) => {
            charsOut += items.reduce((n, i) => n + i.text.length, 0)
            send({ type: "items", items })
          }
        })
        if (outcome.skipped.length) send({ type: "skip", ids: outcome.skipped })
        if (outcome.done === 0 && !outcome.skipped.length) send({ type: "error", code: "UPSTREAM" })
        else send({ type: "done", left: outcome.left })
      } catch (err) {
        console.error("[cf] translate failed:", err instanceof Error ? err.message : err)
        send({ type: "error", code: "UPSTREAM" })
      } finally {
        clearTimeout(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
        // Nothing came: the page and the answer are the person's again (the caps too).
        if (outcome.done === 0) await refund([...charged, ...caps]).catch(() => undefined)
        finished()
      }
    },
    cancel() {
      abort.abort()
    }
  })

  context.waitUntil(ended.then(() => Promise.all([
    logEvent("translate", installId, {
      ...base,
      ok: outcome.done > 0,
      charged: charged.length > 0,
      done: outcome.done,
      skipped: outcome.skipped.length,
      left: outcome.left.length,
      chars_out: charsOut,
      model: stats.model,
      effort,
      calls: stats.calls,
      failed_calls: stats.failedCalls,
      retried: stats.retried,
      first_ms: stats.firstMs,
      ms: Date.now() - started,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      cost_usd: translateCost(stats),
      // The subscription that paid for it, as answers carry it.
      ...(access.entitlement ? { otid: access.entitlement.originalTransactionId } : {})
    }),
    // A charged page is a request like an answer (the install's last use, its language).
    touchInstall(installId, platform, version, locale, charged.length > 0 ? 1 : 0).catch(() => undefined)
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

/** The blocks as sent, checked: an id and marked text each, within the request's limits (the rest is dropped). */
export function readBlocks(raw: unknown): TranslateBlock[] {
  if (!Array.isArray(raw)) return []
  const out: TranslateBlock[] = []
  const ids = new Set<string>()
  let chars = 0
  for (const item of raw.slice(0, TRANSLATE_LIMITS.requestBlocks)) {
    const r = (item ?? {}) as Record<string, unknown>
    const id = clip(r.id, 24)
    const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : ""
    if (!id || ids.has(id) || !text || text.length > TRANSLATE_LIMITS.blockChars) continue
    if (chars + text.length > TRANSLATE_LIMITS.requestChars) break
    ids.add(id)
    chars += text.length
    out.push({ id, text })
  }
  return out
}

export const config: Config = { path: "/api/v2/translate" }
