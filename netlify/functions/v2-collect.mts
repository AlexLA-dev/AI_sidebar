import type { Config, Context } from "@netlify/functions"

import { collect, collectCost, collectStats, sanitizeCollect, type CollectOp } from "../shared/collect.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, type Counter } from "../shared/db.mts"
import { clip, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { OrganizeUpstream } from "../shared/organize.mts"
import { evalAccess, hasPro, resolveAccess } from "../shared/plan.mts"

/**
 * POST /api/v2/collect — the AI parts of collections («Подборки», 2.7): Pro only, under the one AI consent. Stateless:
 * the texts go to the AI providers for this request and are neither kept nor logged (the logs get counts, tokens and
 * time). Doesn't use the answer allowance; it has its own daily limits per op. The model sees numbers, not ids: every
 * id in an answer is one the request sent.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement: <StoreKit JWS>, op, … }
 *   op "place": card: {gist ≤300, text? ≤2,000, title? ≤200, site? ≤100},
 *       collections: [{id, name ≤60, sections: [{id, name ≤40, cards: string[] (gists, 8 per section, each ≤160)}]}]
 *       (up to 20 collections of up to 20 sections; with many sections each shows fewer gists)
 *     → { collection: id | null, section: id | null, newSection?: string ≤40, newCollection?: string ≤60 }
 *       an existing section; or collection + newSection (section null); or newCollection, with its first section's
 *       name in newSection when the AI gave one (collection and section null)
 *   op "layout": cards: [{id, gist ≤300}] (1–120), sections: [{id, name ≤40, own: boolean}] (≤20), lang?: "ru"
 *     → { sections: [{id: existing id | null (new), name ≤40}], cards: [{id, section: index into sections}] }
 *       every card once, in the order sent; the person's own sections always come back with their ids and names
 *   op "compare": cards: [{id, gist ≤300, text? ≤2,000, site? ≤100}] (2–8), lang?
 *     → { h: string[] (2–5 columns, the first names the item), r: string[][] (a row per card, in the order sent, each
 *       as long as h, cells ≤60, "—" when unknown), note?: string ≤160 }
 *   op "summary": sections: [{name, cards: string[] (gists)}] (≤20 sections, the first 40 cards), lang?
 *     → { text } (one plain paragraph, ≤400 characters)
 * Errors: {code} — PRO_ONLY (403), OFF (503, switched off), LIMIT_REACHED (429), UPSTREAM (502), BAD_REQUEST (400).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  // place may carry up to 20 × 20 sections of 8 gists.
  const body = await readJson(req, 600_000)
  if (!body || !isUuid(body.installId)) return json({ code: "BAD_REQUEST" }, 400)
  const installId = body.installId
  const ask = sanitizeCollect(body)
  if (!ask) return json({ code: "BAD_REQUEST" }, 400)
  if (!settings.collect.enabled) return json({ code: "OFF" }, 503)
  const op = ask.op
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)

  // Deploy previews: a request signed with the measuring key counts as a subscriber (never in production).
  const access = evalAccess(req, installId, context) ?? (await resolveAccess(body.entitlement, installId))
  if (!hasPro(access.plan) || !access.entitlement) {
    context.waitUntil(logEvent("pro_only", installId, { feature: "collect", op, plan: access.plan, platform, version }))
    return json({ code: "PRO_ONLY", plan: access.plan, feature: "collect" }, 403)
  }

  const daily: Record<CollectOp, number> = {
    place: settings.collect.placeDaily,
    layout: settings.collect.layoutDaily,
    compare: settings.collect.compareDaily,
    summary: settings.collect.summaryDaily
  }
  const counters: Counter[] = [
    { subject: `collect:${op}:tx:${access.entitlement.originalTransactionId}`, period: "day", limit: daily[op] },
    { subject: "global:collect", period: "day", limit: settings.collect.globalDaily }
  ]
  const quota = await consume(counters).catch((err) => {
    // Database trouble must not switch the feature off for paying users.
    console.error("[cf] collect consume failed:", err instanceof Error ? err.message : err)
    return null
  })
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  const started = Date.now()
  try {
    const asked = await collect(ask, req.signal)
    context.waitUntil(logEvent("collect_api", installId, {
      op, ...collectStats(ask, asked.answer), provider: asked.provider, model: asked.model,
      ...(asked.fallback ? { fallback: asked.fallback } : {}),
      prompt_tokens: asked.tokensIn, completion_tokens: asked.tokensOut, cost_usd: collectCost(asked),
      ms: Date.now() - started, platform, version
    }))
    return json(asked.answer)
  } catch (err) {
    console.error(`[cf] collect ${op} failed:`, err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      quota ? refund(counters).catch(() => undefined) : Promise.resolve(),
      logEvent("upstream_error", installId, {
        mode: `collect_${op}`, provider: err instanceof OrganizeUpstream ? err.provider : "openai",
        message: err instanceof Error ? err.message.slice(0, 300) : "unknown", platform, version
      })
    ]))
    return json({ code: "UPSTREAM" }, 502)
  }
}

export const config: Config = { path: "/api/v2/collect" }
