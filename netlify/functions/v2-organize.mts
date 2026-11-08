import type { Config, Context } from "@netlify/functions"
import { timingSafeEqual } from "node:crypto"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, type Counter } from "../shared/db.mts"
import { clip, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { embed, judgeTags, organizeCost, OrganizeUpstream, sanitizeTagCheck, sanitizeTexts, vectorSpace } from "../shared/organize.mts"
import { hasPro, resolveAccess } from "../shared/plan.mts"

/**
 * POST /api/v2/organize — organizing the chats (2.5): Pro only, and the panel and the app ask only after the
 * user agreed. Stateless: the texts go to the AI providers for this request and are neither kept nor logged
 * (the logs get counts, tokens and time). Doesn't use the answer allowance; it has its own daily limits.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement: <StoreKit JWS>, op, … }
 *   op "embed": texts: string[] (1–128, each cut to 1,200 characters)
 *     → { space: "model:dims", vectors: string[] } (src/shared/organize.ts `packVector`, in the texts' order)
 *   op "tags": message: string, candidates: [{tag, examples: string[]}] (up to 3 tags, 5 examples each)
 *     → { verdicts: [{tag, fits, confidence}] }
 * Errors: {code} — PRO_ONLY (403), OFF (503, switched off), LIMIT_REACHED (429), UPSTREAM (502), BAD_REQUEST (400).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 400_000)
  if (!body || !isUuid(body.installId)) return json({ code: "BAD_REQUEST" }, 400)
  const installId = body.installId
  const op = body.op === "embed" || body.op === "tags" ? body.op : null
  const texts = op === "embed" ? sanitizeTexts(body.texts) : null
  const check = op === "tags" ? sanitizeTagCheck(body) : null
  if (!op || (op === "embed" ? !texts : !check)) return json({ code: "BAD_REQUEST" }, 400)
  if (!settings.organize.enabled) return json({ code: "OFF" }, 503)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)

  let subject: string
  if (calibrating(req, context)) {
    subject = "eval"
  } else {
    const access = await resolveAccess(body.entitlement, installId)
    if (!hasPro(access.plan) || !access.entitlement) {
      context.waitUntil(logEvent("pro_only", installId, { feature: "organize", plan: access.plan, platform, version }))
      return json({ code: "PRO_ONLY", plan: access.plan, feature: "organize" }, 403)
    }
    subject = `tx:${access.entitlement.originalTransactionId}`
  }

  const counters: Counter[] = [
    { subject: `organize:${op}:${subject}`, period: "day", limit: subject === "eval" ? 20_000 : op === "embed" ? settings.organize.embedDaily : settings.organize.tagsDaily },
    { subject: "global:organize", period: "day", limit: settings.organize.globalDaily }
  ]
  const quota = await consume(counters).catch((err) => {
    // Database trouble must not switch the feature off for paying users.
    console.error("[cf] organize consume failed:", err instanceof Error ? err.message : err)
    return null
  })
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  const started = Date.now()
  try {
    if (op === "embed") {
      const result = await embed(texts!, req.signal)
      context.waitUntil(logEvent("organize_api", installId, {
        op, n: texts!.length, tokens: result.tokens, cost_usd: organizeCost("embed", result.tokens), model: settings.organize.embedModel, ms: Date.now() - started, platform, version
      }))
      return json({ space: vectorSpace(), vectors: result.vectors })
    }
    const judged = await judgeTags(check!, req.signal)
    context.waitUntil(logEvent("organize_api", installId, {
      op, n: check!.candidates.length, fits: judged.verdicts.filter((v) => v.fits).length, provider: judged.provider, model: judged.model,
      ...(judged.fallback ? { fallback: judged.fallback } : {}),
      prompt_tokens: judged.tokensIn, completion_tokens: judged.tokensOut, cost_usd: organizeCost("tags", judged.tokensIn, judged.tokensOut, judged.provider),
      ms: Date.now() - started, platform, version
    }))
    return json({ verdicts: judged.verdicts })
  } catch (err) {
    console.error(`[cf] organize ${op} failed:`, err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      quota ? refund(counters).catch(() => undefined) : Promise.resolve(),
      logEvent("upstream_error", installId, {
        mode: `organize_${op}`, provider: err instanceof OrganizeUpstream ? err.provider : "openai",
        message: err instanceof Error ? err.message.slice(0, 300) : "unknown", platform, version
      })
    ]))
    return json({ code: "UPSTREAM" }, 502)
  }
}

/** The calibration script on a deploy preview (ORGANIZE_EVAL_TOKEN set there): stands in for Pro. Never in production. */
function calibrating(req: Request, context: Context): boolean {
  const token = settings.organize.evalToken
  const deploy = (context as { deploy?: { context?: string } }).deploy?.context
  if (!token || !deploy || deploy === "production") return false
  const sent = Buffer.from(req.headers.get("authorization") ?? "")
  const wanted = Buffer.from(`Bearer ${token}`)
  return sent.length === wanted.length && timingSafeEqual(sent, wanted)
}

export const config: Config = { path: "/api/v2/organize" }
