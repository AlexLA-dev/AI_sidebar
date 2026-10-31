import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"

// "app_open": the ContextFlow app was opened (at most once a day per app); "ext_on": the Safari
// extension ran for the first time, i.e. the user switched it on.
const KINDS = new Set(["app_open", "ext_on"])
const STATES = new Set(["off", "on", "in_use"])
const NOTIFICATIONS = new Set(["granted", "denied", "not_asked"])

/**
 * POST /api/v2/event — anonymous funnel step between the App Store download and the first answer.
 * Body: { kind, installId?: <extension install id>, appId?: <random id of the app>,
 *         client: {version, platform, locale}, extension?: "off"|"on"|"in_use", notifications? }
 * Nothing else is accepted: no page content, no Apple ID, no device identifiers.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 10_000)
  const kind = clip(body?.kind, 16)
  const installId = isUuid(body?.installId) ? (body?.installId as string) : null
  const appId = isUuid(body?.appId) ? (body?.appId as string) : null
  if (!body || !KINDS.has(kind) || !(installId || appId)) return json({ code: "BAD_REQUEST" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>

  const quota = await consume([
    { subject: `event:${appId ?? installId}`, period: "day", limit: settings.eventDailyLimit },
    { subject: `event:${ipSubject(context.ip)}`, period: "day", limit: settings.eventDailyLimit * 10 }
  ]).catch(() => null)
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  const extension = clip(body.extension, 8)
  const notifications = clip(body.notifications, 12)
  context.waitUntil(
    logEvent(kind, installId, {
      ...(appId ? { app: appId } : {}),
      platform: clip(client.platform, 20),
      version: clip(client.version, 20),
      locale: clip(client.locale, 12),
      ...(STATES.has(extension) ? { extension } : {}),
      ...(NOTIFICATIONS.has(notifications) ? { notifications } : {})
    })
  )
  return json({ ok: true })
}

export const config: Config = { path: "/api/v2/event" }
