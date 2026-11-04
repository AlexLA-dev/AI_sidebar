import type { Config, Context } from "@netlify/functions"

import { attributionFields, resolveAdToken } from "../shared/adservices.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { isRenewalReason } from "../../src/shared/renewal.ts"
import { sessionFields, useFields } from "../../src/shared/usage.ts"

// "app_open": the ContextFlow app was opened (at most once a day per app); "ext_on": the Safari
// extension ran for the first time, i.e. the user switched it on. "media_notice": a free answer said
// it skipped the page's video or PDFs (Pro reads them); "media_notice_pro": its "Try Pro" was tapped.
// "renewal_off": a Pro user who turned auto-renew off said what was missing (or put the question off).
// "byok_upsell": an Own key subscriber was shown Pro (at a refusal, or the discount a day later) or tapped it.
// These few a day per id share one small allowance; everything else ("use": a step in a feature, see
// src/shared/usage.ts) has its own, larger one.
const KINDS = new Set(["app_open", "ext_on", "media_notice", "media_notice_pro", "renewal_off", "byok_upsell"])
const STEP_KINDS = new Set(["use"])
const UPSELL_ACTIONS = new Set(["shown", "tap"])
const UPSELL_WHERE = new Set(["limit", "search", "pro_only", "offer", "pro_screen", "settings"])
const RENEWAL_FROM = new Set(["app", "panel"])
const MEDIA = new Set(["video", "pdf", "video,pdf"])
const STATES = new Set(["off", "on", "in_use"])
const NOTIFICATIONS = new Set(["granted", "denied", "not_asked"])

/**
 * POST /api/v2/event — anonymous counts: funnel steps between the App Store download and the first answer,
 * and which features people use, in what order.
 * Body: { kind, installId?: <extension install id>, appId?: <random id of the app>,
 *         client: {version, build?, platform, locale}, audience?: "test" (debug and TestFlight builds),
 *         extension?: "off"|"on"|"in_use", notifications?,
 *         adToken?: <AdServices attribution token, app_open only>, media?: "video"|"pdf"|"video,pdf",
 *         renewal_off: reason (src/shared/renewal.ts), product, days_left, from: "app"|"panel",
 *         use: f, a, via?, …the feature's own fields (src/shared/usage.ts),
 *         any kind: sid, n, prev, dt, s, psid (the session the step belongs to) }
 * or { batch: [{kind, …}, …up to 25], installId?, appId?, client, audience? } — steps sent together;
 * a step that isn't allowed is left out, the rest are kept.
 * Nothing else is accepted: no page content, no Apple ID, no device identifiers.
 * With adToken the answer carries ads: "attributed" | "organic" | "pending" (the app sends the
 * token again on a later launch while it's pending).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 20_000)
  const installId = isUuid(body?.installId) ? (body?.installId as string) : null
  const appId = isUuid(body?.appId) ? (body?.appId as string) : null
  if (!body || !(installId || appId)) return json({ code: "BAD_REQUEST" }, 400)
  const batch = Array.isArray(body.batch)
  const items = batch ? (body.batch as unknown[]).slice(0, MAX_BATCH) : [body]
  const client = (body.client ?? {}) as Record<string, unknown>
  // The app build (CFBundleVersion), read as /api/v2/chat reads it: it tells builds apart when the version doesn't.
  const build = /^\d{1,6}/.exec(String(client.build ?? "").trim())
  const shared = {
    ...(appId ? { app: appId } : {}),
    platform: clip(client.platform, 20),
    version: clip(client.version, 20),
    locale: clip(client.locale, 12),
    ...(build ? { build: Number(build[0]) } : {}),
    ...(body.audience === "test" || client.audience === "test" ? { audience: "test" } : {})
  }
  const steps = items.map((item) => step(item, shared)).filter((s): s is Step => s !== null)
  if (!steps.length) return json({ code: "BAD_REQUEST" }, 400)

  // One request counts once, however many steps it carries.
  const funnel = steps.some((s) => KINDS.has(s.kind))
  const limit = funnel ? settings.eventDailyLimit : settings.useEventDailyLimit
  const bucket = funnel ? "event" : "event:use"
  const quota = await consume([
    { subject: `${bucket}:${appId ?? installId}`, period: "day", limit },
    { subject: `${bucket}:${ipSubject(context.ip)}`, period: "day", limit: limit * 10 }
  ]).catch(() => null)
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  context.waitUntil(Promise.all(steps.map((s) => logEvent(s.kind, installId, s.data))))
  if (batch) return json({ ok: true, kept: steps.length, left_out: items.length - steps.length })

  // Apple Ads attribution: which campaign / ad group / keyword brought this download, so
  // subscriptions can be joined to keywords (rpc cf_ads_funnel).
  const adToken = body.kind === "app_open" && typeof body.adToken === "string" && body.adToken.length <= 4096 ? body.adToken : null
  if (!adToken) return json({ ok: true })
  const attribution = await resolveAdToken(adToken)
  if (attribution === "pending" || attribution === null) return json({ ok: true, ads: attribution ?? "pending" })
  if (attribution.attribution) {
    context.waitUntil(logEvent("ads_attribution", installId, { ...(appId ? { app: appId } : {}), ...attributionFields(attribution) }))
  }
  return json({ ok: true, ads: attribution.attribution ? "attributed" : "organic" })
}

const MAX_BATCH = 25

interface Step {
  kind: string
  data: Record<string, unknown>
}

/** One event as it will be logged, or null when its kind or its required fields aren't allowed. */
function step(raw: unknown, shared: Record<string, unknown>): Step | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const kind = clip(item.kind, 16)
  if (!KINDS.has(kind) && !STEP_KINDS.has(kind)) return null
  if (kind === "renewal_off" && !isRenewalReason(item.reason)) return null
  const use = kind === "use" ? useFields(item) : null
  if (kind === "use" && !use) return null
  const extension = clip(item.extension, 8)
  const notifications = clip(item.notifications, 12)
  const media = clip(item.media, 9)
  return {
    kind,
    data: {
      ...shared,
      ...(STATES.has(extension) ? { extension } : {}),
      ...(NOTIFICATIONS.has(notifications) ? { notifications } : {}),
      ...(kind.startsWith("media_notice") && MEDIA.has(media) ? { media } : {}),
      ...(kind === "renewal_off" ? renewalFields(item) : {}),
      ...(kind === "byok_upsell" ? upsellFields(item) : {}),
      ...use,
      ...sessionFields(item)
    }
  }
}

/** An Own key subscriber and Pro: shown or tapped, where (which refusal, the discount, the Pro screen), from where. */
function upsellFields(body: Record<string, unknown>): Record<string, unknown> {
  const action = clip(body.action, 8)
  const where = clip(body.where, 12)
  const from = clip(body.from, 8)
  return {
    ...(UPSELL_ACTIONS.has(action) ? { action } : {}),
    ...(UPSELL_WHERE.has(where) ? { where } : {}),
    ...(RENEWAL_FROM.has(from) ? { from } : {}),
    ...(body.discount === true ? { discount: true } : {})
  }
}

/** What the auto-renew question carries: the answer, the plan, days left in it, and where it was asked. */
function renewalFields(body: Record<string, unknown>): Record<string, unknown> {
  const days = body.days_left
  const from = clip(body.from, 8)
  return {
    reason: body.reason,
    product: clip(body.product, 64),
    ...(typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 400 ? { days_left: days } : {}),
    ...(RENEWAL_FROM.has(from) ? { from } : {})
  }
}

export const config: Config = { path: "/api/v2/event" }
