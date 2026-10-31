import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { limitedBefore, peek, touchInstall } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { countersFor, proOffer, resolveAccess, visibleUsage } from "../shared/plan.mts"

/**
 * POST /api/v2/status — plan and remaining allowance, without consuming anything.
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS> }
 * `limitedBefore`: a free install that ran out of free answers on an earlier day.
 * `offer`: {code, discount} — the App Store offer code for Pro, for a free install that is out of answers
 * today or was before; else null.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 50_000)
  if (!body || !isUuid(body.installId)) return json({ code: "BAD_REQUEST" }, 400)
  const installId = body.installId
  const client = (body.client ?? {}) as Record<string, unknown>

  const access = await resolveAccess(body.entitlement, installId)
  const counters = countersFor(access, installId, ipSubject(context.ip))
  const [state, limited] = await Promise.all([
    peek(counters).catch(() => counters.map((c) => ({ ...c, n: 0 }))),
    access.plan === "free" ? limitedBefore(installId).catch(() => false) : false
  ])

  context.waitUntil(
    touchInstall(installId, clip(client.platform, 20), clip(client.version, 20), clip(client.locale, 12)).catch(() => undefined)
  )

  const usage = visibleUsage(access, state)
  const offer = limited === true || usage.used >= usage.limit ? proOffer(access) : null

  return json({
    plan: access.plan,
    entitlement: access.entitlement
      ? {
          productId: access.entitlement.productId,
          expiresAt: access.entitlement.expiresAt ? new Date(access.entitlement.expiresAt).toISOString() : null,
          environment: access.entitlement.environment
        }
      : null,
    entitlementError: access.entitlementError ?? null,
    usage,
    limitedBefore: limited === true,
    offer,
    limits: { freeDaily: settings.freeDailyLimit, proWeekly: settings.proWeeklyLimit }
  })
}

export const config: Config = { path: "/api/v2/status" }
