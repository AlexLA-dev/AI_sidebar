import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"

/**
 * POST /api/v2/usage — usage report for an answer the extension got with the user's own key
 * (those requests go straight from the device to OpenAI / Anthropic, so the server never sees them).
 *
 * Body: { installId, client: {version, platform, locale},
 *         usage: { provider, model, tier, action?, ok, error?, promptTokens, completionTokens, ms } }
 * Only counters: never the key, the question or the page. Always answers 204 so the client can fire and forget.
 */

const PROVIDERS = new Set(["openai", "anthropic"])

function count(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : 0
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 4_000)
  const installId = body?.installId
  const usage = (body?.usage ?? null) as Record<string, unknown> | null
  const provider = clip(usage?.provider, 16)
  if (!isUuid(installId) || !usage || !PROVIDERS.has(provider)) return json({ code: "BAD_REQUEST" }, 400)
  const client = (body?.client ?? {}) as Record<string, unknown>

  // Reports only feed analytics: cap them so a broken or hostile client can't flood the events table.
  try {
    const quota = await consume([
      { subject: `ownlog:install:${installId}`, period: "day", limit: settings.ownKeyReportDailyLimit },
      { subject: `ownlog:${ipSubject(context.ip)}`, period: "day", limit: settings.ownKeyReportDailyLimit * 3 }
    ])
    if (!quota.allowed) return new Response(null, { status: 204 })
  } catch {
    return new Response(null, { status: 204 })
  }

  context.waitUntil(logEvent("chat", installId, {
    key: "own",
    provider,
    mode: "chat",
    ok: usage.ok === true,
    error: usage.ok === true ? null : clip(usage.error, 24) || null,
    model: clip(usage.model, 64),
    tier: usage.tier === "fast" ? "fast" : "smart",
    action: clip(usage.action, 32) || null,
    prompt_tokens: count(usage.promptTokens, 10_000_000),
    completion_tokens: count(usage.completionTokens, 10_000_000),
    ms: count(usage.ms, 600_000),
    platform: clip(client.platform, 20),
    version: clip(client.version, 20)
  }).catch(() => undefined))

  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } })
}

export const config: Config = { path: "/api/v2/usage" }
