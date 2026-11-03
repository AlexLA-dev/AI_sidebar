import type { Config, Context } from "@netlify/functions"

import { attributionFields, resolveAdToken } from "../shared/adservices.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { isRenewalReason } from "../../src/shared/renewal.ts"

// "app_open": the ContextFlow app was opened (at most once a day per app); "ext_on": the Safari
// extension ran for the first time, i.e. the user switched it on. "media_notice": a free answer said
// it skipped the page's video or PDFs (Pro reads them); "media_notice_pro": its "Try Pro" was tapped.
// "renewal_off": a Pro user who turned auto-renew off said what was missing (or put the question off).
// "byok_upsell": an Own key subscriber was shown Pro (at a refusal, or the discount a day later) or tapped it.
const KINDS = new Set(["app_open", "ext_on", "media_notice", "media_notice_pro", "renewal_off", "byok_upsell"])
// Quick insert (2.5), counts only, no text and no sites: "insert_copied" / "insert_template" / "insert_answer"
// something went into a field (how the list was opened, the template's blanks and how they were filled);
// "insert_tpl_new" a template was made (from a selection, Copied or +; blanks, marked by AI or not);
// "insert_fill" the AI filled blanks (how many of how many), "insert_fill_edit" one was changed after;
// "insert_manual" a field didn't take the text (copied for a paste by hand); "social_open" a link to X or Threads.
const INSERT_KINDS = new Set(["insert_copied", "insert_template", "insert_answer", "insert_tpl_new", "insert_fill", "insert_fill_edit", "insert_manual", "social_open"])
const UPSELL_ACTIONS = new Set(["shown", "tap"])
const UPSELL_WHERE = new Set(["limit", "search", "pro_only", "offer", "pro_screen"])
const RENEWAL_FROM = new Set(["app", "panel"])
const MEDIA = new Set(["video", "pdf", "video,pdf"])
const STATES = new Set(["off", "on", "in_use"])
const NOTIFICATIONS = new Set(["granted", "denied", "not_asked"])

/**
 * POST /api/v2/event — anonymous funnel step between the App Store download and the first answer.
 * Body: { kind, installId?: <extension install id>, appId?: <random id of the app>,
 *         client: {version, platform, locale}, extension?: "off"|"on"|"in_use", notifications?,
 *         adToken?: <AdServices attribution token, app_open only>, media?: "video"|"pdf"|"video,pdf",
 *         renewal_off: reason (src/shared/renewal.ts), product, days_left, from: "app"|"panel" }
 * Nothing else is accepted: no page content, no Apple ID, no device identifiers.
 * With adToken the answer carries ads: "attributed" | "organic" | "pending" (the app sends the
 * token again on a later launch while it's pending).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 10_000)
  const kind = clip(body?.kind, 16)
  const installId = isUuid(body?.installId) ? (body?.installId as string) : null
  const appId = isUuid(body?.appId) ? (body?.appId as string) : null
  if (!body || !(KINDS.has(kind) || INSERT_KINDS.has(kind)) || !(installId || appId)) return json({ code: "BAD_REQUEST" }, 400)
  if (kind === "renewal_off" && !isRenewalReason(body.reason)) return json({ code: "BAD_REQUEST" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>

  // Inserts happen many times a day: their own allowance, so they never use up the funnel's.
  const quota = await consume(INSERT_KINDS.has(kind) ? [
    { subject: `event:insert:${appId ?? installId}`, period: "day", limit: settings.insert.eventDaily },
    { subject: `event:insert:${ipSubject(context.ip)}`, period: "day", limit: settings.insert.eventDaily * 10 }
  ] : [
    { subject: `event:${appId ?? installId}`, period: "day", limit: settings.eventDailyLimit },
    { subject: `event:${ipSubject(context.ip)}`, period: "day", limit: settings.eventDailyLimit * 10 }
  ]).catch(() => null)
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  const extension = clip(body.extension, 8)
  const notifications = clip(body.notifications, 12)
  const media = clip(body.media, 9)
  context.waitUntil(
    logEvent(kind, installId, {
      ...(appId ? { app: appId } : {}),
      platform: clip(client.platform, 20),
      version: clip(client.version, 20),
      locale: clip(client.locale, 12),
      ...(STATES.has(extension) ? { extension } : {}),
      ...(NOTIFICATIONS.has(notifications) ? { notifications } : {}),
      ...(kind.startsWith("media_notice") && MEDIA.has(media) ? { media } : {}),
      ...(kind === "renewal_off" ? renewalFields(body) : {}),
      ...(kind === "byok_upsell" ? upsellFields(body) : {}),
      ...(INSERT_KINDS.has(kind) ? insertFields(body) : {})
    })
  )

  // Apple Ads attribution: which campaign / ad group / keyword brought this download, so
  // subscriptions can be joined to keywords (rpc cf_ads_funnel).
  const adToken = kind === "app_open" && typeof body.adToken === "string" && body.adToken.length <= 4096 ? body.adToken : null
  if (!adToken) return json({ ok: true })
  const attribution = await resolveAdToken(adToken)
  if (attribution === "pending" || attribution === null) return json({ ok: true, ads: attribution ?? "pending" })
  if (attribution.attribution) {
    context.waitUntil(logEvent("ads_attribution", installId, { ...(appId ? { app: appId } : {}), ...attributionFields(attribution) }))
  }
  return json({ ok: true, ads: attribution.attribution ? "attributed" : "organic" })
}

const INSERT_VIA = new Set(["button", "slash", "shortcut", "panel"])
const INSERT_FILLED = new Set(["ai", "manual", "none"])
const INSERT_WHAT = new Set(["answer", "note"])
const INSERT_FROM = new Set(["selection", "plus", "pin"])
const INSERT_FIELD = new Set(["control", "editor"])
const NETWORKS = new Set(["x", "threads"])

/** Quick insert's counts: only these fields, only these values (a number of blanks up to 50). */
function insertFields(body: Record<string, unknown>): Record<string, unknown> {
  const pick = (key: string, allowed: Set<string>) => {
    const v = clip(body[key], 12)
    return allowed.has(v) ? { [key]: v } : {}
  }
  const count = (key: string) => {
    const n = body[key]
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 50 ? { [key]: n } : {}
  }
  return {
    ...pick("via", INSERT_VIA),
    ...pick("filled", INSERT_FILLED),
    ...pick("what", INSERT_WHAT),
    ...pick("from", INSERT_FROM),
    ...pick("field", INSERT_FIELD),
    ...pick("network", NETWORKS),
    ...count("blanks"),
    ...count("found"),
    ...(typeof body.ai === "boolean" ? { ai: body.ai } : {})
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
