import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { resolveAccess } from "../shared/plan.mts"
import { promoConfigured, signPromo } from "../shared/promo.mts"

/**
 * POST /api/v2/promo — the signature for Pro's promotional offer, only for an active Own key subscription
 * (the upgrade at a discount the owner set up in App Store Connect).
 * Body: { installId, entitlement: <StoreKit JWS of the Own key subscription>, bundleId, appAccountToken?, client }
 * Response: { offerId, keyId, nonce, timestamp, signature } or { code }: 404 OFFER_OFF (not set up),
 * 403 NOT_ELIGIBLE (not an active Own key subscription), 400 BAD_REQUEST.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)
  if (!promoConfigured()) return json({ code: "OFFER_OFF" }, 404)

  const body = await readJson(req, 50_000)
  if (!body || !isUuid(body.installId)) return json({ code: "BAD_REQUEST" }, 400)
  const installId = body.installId
  const bundleId = clip(body.bundleId, 100)
  if (!settings.appBundleIds.includes(bundleId)) return json({ code: "BAD_REQUEST" }, 400)
  const token = body.appAccountToken === undefined || body.appAccountToken === "" ? "" : isUuid(body.appAccountToken) ? String(body.appAccountToken) : null
  if (token === null) return json({ code: "BAD_REQUEST" }, 400)

  const access = await resolveAccess(body.entitlement, installId)
  if (access.plan !== "byok") return json({ code: "NOT_ELIGIBLE", plan: access.plan }, 403)
  const quota = await consume([{ subject: `promo:${installId}`, period: "day", limit: 20 }]).catch(() => null)
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  const client = (body.client ?? {}) as Record<string, unknown>
  context.waitUntil(logEvent("byok_upsell", installId, {
    action: "signed", product: settings.promoProductId, offer: settings.promoOfferId,
    platform: clip(client.platform, 20), version: clip(client.version, 20)
  }))
  return json(signPromo(bundleId, settings.promoProductId, token))
}

export const config: Config = { path: "/api/v2/promo" }
