import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { clip, ipSubject, json, preflight, readJson } from "../shared/http.mts"
import { isSiteLabel, isSitePage, isSiteSource } from "../../src/shared/site.ts"

// Crawlers and link previews that run the page's script would count as visits.
const BOTS = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|facebookexternalhit|curl|wget|python|httpx|okhttp|java\//i

/**
 * POST /api/v2/site — the site counter (site/visit.js).
 * Body: { kind: "site_visit", src, page } | { kind: "site_click", src, label }, values from src/shared/site.ts.
 * Logged with no install id and nothing else: no address, no user agent, no referrer.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 500)
  const kind = clip(body?.kind, 16)
  const valid = !!body && isSiteSource(body.src) &&
    ((kind === "site_visit" && isSitePage(body.page)) || (kind === "site_click" && isSiteLabel(body.label)))
  if (!valid) return json({ code: "BAD_REQUEST" }, 400)
  if (BOTS.test(req.headers.get("user-agent") ?? "")) return json({ ok: true })

  const quota = await consume([
    { subject: `site:${ipSubject(context.ip)}`, period: "day", limit: settings.siteDailyLimit },
    { subject: "site:all", period: "day", limit: settings.siteGlobalDailyLimit }
  ]).catch(() => null)
  if (quota && !quota.allowed) return json({ code: "LIMIT_REACHED" }, 429)

  context.waitUntil(logEvent(kind, null, kind === "site_visit" ? { src: body.src, page: body.page } : { src: body.src, label: body.label }))
  return json({ ok: true })
}

export const config: Config = { path: "/api/v2/site" }
