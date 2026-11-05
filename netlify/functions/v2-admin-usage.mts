import type { Config } from "@netlify/functions"
import { createHash, timingSafeEqual } from "node:crypto"

import { config as settings } from "../shared/config.mts"
import { afterLimit, featureFunnels, features, limitsReport, newUserOutcomes, onboarding, ownerInsights, releases, setupFunnel, usageReport } from "../shared/db.mts"
import { featureBase } from "../../src/shared/usage.ts"

/**
 * GET /api/v2/admin/usage?days=30 — usage analytics for the /analytics page.
 * Authorization: Bearer <ADMIN_TOKEN>. Without ADMIN_TOKEN configured the endpoint doesn't exist (404).
 */

const noStore = { "Content-Type": "application/json", "Cache-Control": "no-store" }

function sameToken(given: string, expected: string): boolean {
  // Compare digests so the check takes the same time whatever the input length.
  const a = createHash("sha256").update(given).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

export default async (req: Request): Promise<Response> => {
  if (!settings.adminToken) return new Response("Not found", { status: 404 })
  if (req.method !== "GET") return new Response(JSON.stringify({ code: "METHOD" }), { status: 405, headers: noStore })

  const auth = req.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
  if (!token || !sameToken(token, settings.adminToken)) {
    return new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401, headers: noStore })
  }

  const days = Math.max(1, Math.min(180, Number.parseInt(new URL(req.url).searchParams.get("days") ?? "30", 10) || 30))
  try {
    const missing = (what: string) => (err: unknown) => {
      console.error(`[cf] ${what} failed:`, err instanceof Error ? err.message : err)
      return null
    }
    const [report, funnel, insights, limits, steps, outcomes, used, funnels, after, shipped] = await Promise.all([
      usageReport(days),
      // Older databases have no funnel or insights yet; the rest of the report still works.
      setupFunnel(days).catch(() => []),
      ownerInsights(days).catch(missing("owner insights")),
      limitsReport(days).catch(missing("limits report")),
      onboarding(days).catch(missing("onboarding")),
      newUserOutcomes(days).catch(missing("new user outcomes")),
      features(days, featureBase()).catch(missing("features")),
      featureFunnels(days).catch(missing("feature funnels")),
      afterLimit(days).catch(missing("after limit")),
      releases().catch(missing("releases"))
    ])
    return new Response(JSON.stringify({
      ...report, setup_funnel: funnel, insights, limits_report: limits, onboarding: steps, new_outcomes: outcomes,
      features: used, feature_funnels: funnels, after_limit: after, releases: shipped
    }), { headers: noStore })
  } catch (err) {
    console.error("[cf] usage report failed:", err instanceof Error ? err.message : err)
    return new Response(JSON.stringify({ code: "UNAVAILABLE" }), { status: 503, headers: noStore })
  }
}

export const config: Config = { path: "/api/v2/admin/usage" }
