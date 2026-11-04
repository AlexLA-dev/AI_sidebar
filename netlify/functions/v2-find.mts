import type { Config, Context } from "@netlify/functions"

import { consume, logEvent, refund, touchInstall } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { answerCost, clientBuild, startAnswer, type Answer } from "../shared/answer.mts"
import type { StreamStats } from "../shared/llm.mts"
import { blockReason, countersFor, resolveAccess, visibleUsage } from "../shared/plan.mts"
import { findPrompt, MAX_FIND_CHARS, MAX_FIND_CHATS, parseFindAnswer, sanitizeDigests } from "../../src/shared/history.ts"
import { chatSize, digestCut, LIMITS_VERSION } from "../shared/limits.mts"
import { uiFields } from "../../src/shared/usage.ts"

/**
 * POST /api/v2/find — AI search over the user's chats (Pro): the chats that match what the user
 * describes, best first, each with a one-line reason. Costs one answer of the Pro allowance.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement: <StoreKit JWS>, query,
 *         chats: [{id, title, date, text}] }
 * Response: { results: [{id, why}], usage } — or {code} with 4xx/5xx: PRO_ONLY (403), LIMIT_REACHED (402),
 * BUSY (503), UPSTREAM (502), BAD_REQUEST (400).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 200_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const query = clip(body.query, 500).trim()
  const chats = sanitizeDigests(body.chats, MAX_FIND_CHATS, MAX_FIND_CHARS)
  if (!query || !chats.length) return json({ code: "BAD_REQUEST", message: "query and chats required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  // The app build (2.4 build 67 and later send it): Claude answers only builds that name it.
  const build = clientBuild(client)
  // The step this search is in the user's session (where, the step before), for /analytics.
  const step = { ...uiFields(body.ui, "ai_search"), ...(client.audience === "test" ? { audience: "test" } : {}) }

  const access = await resolveAccess(body.entitlement, installId)
  if (access.plan !== "pro") {
    context.waitUntil(logEvent("pro_only", installId, { feature: "find", plan: access.plan, platform, version, ...step }))
    return json({ code: "PRO_ONLY", plan: access.plan, feature: "find" }, 403)
  }

  const counters = countersFor(access, installId, ipSubject(context.ip))
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  const usage = visibleUsage(access, quota.counters)
  if (!quota.allowed) {
    const reason = blockReason(quota.blocked)
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, platform, version, mode: "find", ...step }))
    return json({ code: reason === "busy" ? "BUSY" : "LIMIT_REACHED", plan: access.plan, usage }, reason === "busy" ? 503 : 402)
  }

  const started = Date.now()
  const stats: StreamStats = { promptTokens: 0, completionTokens: 0, chars: 0 }
  let text = ""
  let answer: Answer | null = null
  try {
    // The free plan's settings: picking chats needs no long writing.
    answer = await startAnswer(findPrompt(chats, locale), [{ role: "user", content: query }], "free", build, req.signal)
    for await (const piece of answer.text(stats)) text += piece
  } catch (err) {
    console.error("[cf] find failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", mode: "find", provider: answer?.provider ?? "openai", platform, version })
    ]))
    return json({ code: "UPSTREAM", message: "The AI service is busy. Please try again in a moment." }, 502)
  }

  const results = parseFindAnswer(text, new Set(chats.map((c) => c.id)))
  context.waitUntil(Promise.all([
    logEvent("chat", installId, {
      key: "ours",
      provider: answer.provider,
      ...(answer.fallback ? { fallback: answer.fallback } : {}),
      ...(answer.provider === "anthropic" ? { cost_usd: answerCost(answer, stats) } : {}),
      ok: true,
      plan: access.plan,
      model: answer.model,
      mode: "find",
      find_chats: chats.length,
      find_results: results.length,
      // The chats didn't all fit (cf_limits_report), and how many the device has (2.4).
      limits_v: LIMITS_VERSION,
      ...(digestCut(body.chats, chats, MAX_FIND_CHARS) ? { digest_cut: true } : {}),
      ...chatSize(body.stats),
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      ms: Date.now() - started,
      platform,
      version,
      build,
      ...step
    }),
    touchInstall(installId, platform, version, locale, 1).catch(() => undefined)
  ]))
  return json({ results, usage })
}

export const config: Config = { path: "/api/v2/find" }
