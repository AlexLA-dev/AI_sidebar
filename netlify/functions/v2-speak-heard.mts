import type { Config, Context } from "@netlify/functions"

import { logEvent, peek } from "../shared/db.mts"
import { applyHeard, heardItems } from "../shared/heard.mts"
import { clip, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { evalCheck, isUltra, resolveAccess, speakCountersFor, ultraUsage } from "../shared/plan.mts"

/**
 * POST /api/v2/speak-heard — read aloud's seconds heard (build 92): what counts against the week's minutes.
 *
 * Body: { installId, client: {version, platform}, entitlement: <StoreKit JWS>, items: [{ key, s }] }
 * - key: a part's key (sha256 hex of "v1|<language>|<text>"), s: seconds of it heard so far (the device's total for
 *   that part; sent again, it adds nothing).
 * Response 200: { ok: true, added, usage } (usage: the week's heard seconds, as X-CF-Usage). 403 ULTRA_ONLY, 400.
 * The devices send these in batches: when a text stops or ends, with the next part they ask for, and again at the next
 * start if a batch didn't go.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)
  const body = await readJson(req, 32_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const items = heardItems(body.items)
  if (!items.length) return json({ code: "BAD_REQUEST", message: "items required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const check = evalCheck(req, installId, context)
  const access = check.access ?? (await resolveAccess(body.entitlement, installId))
  if (!isUltra(access.plan)) return json({ code: "ULTRA_ONLY", plan: access.plan, feature: "speak" }, 403)

  // The database refusing (busy, or the 'ever' counters not set up yet): the device keeps the seconds and sends again.
  const added = await applyHeard(access, items).catch((err) => {
    console.error("[cf] heard failed:", err instanceof Error ? err.message : err)
    return null
  })
  if (added === null) return json({ code: "BUSY", message: "Try again" }, 503)
  const minutes = speakCountersFor(access, 0).filter((c) => c.subject.startsWith("speak:"))
  const usage = ultraUsage(await peek(minutes).catch(() => minutes.map((c) => ({ ...c, n: 0 }))), "speak:")
  context.waitUntil(logEvent("speak_heard", installId, {
    plan: access.plan, parts: items.length, heard_s: Math.round(items.reduce((n, i) => n + i.s, 0)), added_s: added,
    platform: clip(client.platform, 20), version: clip(client.version, 20), ...(client.audience === "test" ? { audience: "test" } : {})
  }).catch(() => undefined))
  return json({ ok: true, added, usage })
}

export const config: Config = { path: "/api/v2/speak-heard" }
