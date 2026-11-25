import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { limitedBefore, logEvent, peek, touchInstall } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { countersFor, evalAccess, isUltra, proOffer, resolveAccess, similarCountersFor, speakCountersFor, ultraUsage, useBreakdown, useCountersFor, visibleUsage } from "../shared/plan.mts"
import { WATCH_LIMITS } from "../../src/shared/plan.ts"
import { vectorSpace } from "../shared/organize.mts"
import { promoConfigured } from "../shared/promo.mts"
import { inviteExtra, readState } from "../shared/invite.mts"

/**
 * POST /api/v2/status — plan and remaining allowance, without consuming anything.
 * Body: { installId, client: {version, platform, locale}, entitlement?: <StoreKit JWS> }
 * `limitedBefore`: a free install that ran out of free answers on an earlier day.
 * `offer`: {code, discount} — the App Store offer code for Pro, for a free install that is out of answers
 * today or was before; else null.
 * `upgradeOffer`: {discount} — an Own key subscriber can move to Pro at a discount (a promotional offer the
 * app gets signed by /api/v2/promo); null when it isn't set up. When to show it is the client's call.
 * `usage.by` (110): this period's answers by what they went on ({chat, google, translate, write, chats, similar}, the
 * ones above 0; src/shared/spent.ts), from counters charged with the answers' own; what isn't in it is «Other».
 * `organize`: {on, space, config} — organizing the chats (2.5): switched on, the vector space to key vectors by,
 * and the thresholds (src/shared/organize.ts), for every plan (free users see what it does).
 * `ultra`: {speak, similar} — this week's read-aloud seconds and find-similar searches (used, limit, resetsAt), for
 * an Ultra subscriber only. `limits` also carries the Ultra allowances and the watched pages per plan, for what the
 * paywall says (2.6).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 50_000)
  if (!body || !isUuid(body.installId)) return json({ code: "BAD_REQUEST" }, 400)
  const installId = body.installId
  const client = (body.client ?? {}) as Record<string, unknown>

  const access = evalAccess(req, installId, context) ?? (await resolveAccess(body.entitlement, installId))
  const counters = countersFor(access, installId, ipSubject(context.ip), await inviteExtra(client, [installId], access.plan))
  const ultraCounters = isUltra(access.plan) ? [...speakCountersFor(access, 0), ...similarCountersFor(access)] : []
  // 110: what the answers went on, read with them (no answers' counter, as with their own key: none).
  const use = useCountersFor(counters)
  const [state, limited, ultraState, invite] = await Promise.all([
    peek([...counters, ...use]).catch(() => [...counters, ...use].map((c) => ({ ...c, n: 0 }))),
    access.plan === "free" ? limitedBefore(installId).catch(() => false) : false,
    ultraCounters.length ? peek(ultraCounters).catch(() => ultraCounters.map((c) => ({ ...c, n: 0 }))) : Promise.resolve([]),
    // 2.7: an install with an invite code of its own hears when a friend becomes active (its reward).
    client.invc === 1 && settings.invite.enabled ? readState([installId]).catch(() => null) : Promise.resolve(null)
  ])

  context.waitUntil(
    touchInstall(installId, clip(client.platform, 20), clip(client.version, 20), clip(client.locale, 12)).catch(() => undefined)
  )

  if (invite && invite.new_active > 0) context.waitUntil(logEvent("invite_active", installId, { n: invite.new_active, platform: clip(client.platform, 20), version: clip(client.version, 20), s: "panel" }))
  const usage = { ...visibleUsage(access, state), by: useBreakdown(state, counters) }
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
    upgradeOffer: access.plan === "byok" && promoConfigured() ? { discount: settings.promoDiscount } : null,
    ultra: isUltra(access.plan) ? { speak: ultraUsage(ultraState, "speak:"), similar: ultraUsage(ultraState, "similar:") } : null,
    limits: {
      freeDaily: settings.freeDailyLimit, proWeekly: settings.proWeeklyLimit, searchFreeDaily: settings.searchFreeDailyLimit, searchProWeekly: settings.searchProWeeklyLimit,
      // 2.8 (Б8): free Google answers don't take from the free answers.
      searchFreeApart: settings.searchFreeApart,
      ultraWeekly: settings.ultra.weeklyLimit, speakWeeklySeconds: settings.ultra.speakWeeklySeconds, similarWeekly: settings.ultra.similarWeekly, similarLightWeekly: settings.similar.lightWeekly, similarProAnswers: settings.similar.proAnswers, watch: WATCH_LIMITS
    },
    organize: { on: settings.organize.enabled, space: vectorSpace(), config: settings.organize.thresholds },
    ...(invite ? { invite: { active: invite.active } } : {}),
    // Build 93: the country the request came from (Find similar's "near me"); missing when unknown.
    ...(geoCountryOf(context) ? { country: geoCountryOf(context) } : {})
  })
}

function geoCountryOf(context: Context): string {
  const code = (context as unknown as { geo?: { country?: { code?: string } } }).geo?.country?.code ?? ""
  return /^[A-Z]{2}$/.test(code) ? code : ""
}

export const config: Config = { path: "/api/v2/status" }
