import type { Config } from "@netlify/functions"
import { createHash, timingSafeEqual } from "node:crypto"

import { config as settings } from "../shared/config.mts"
import { newUserOutcomes, onboarding, ownerInsights, setupFunnel, usageReport } from "../shared/db.mts"

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
    const [report, funnel, insights, steps, outcomes] = await Promise.all([
      usageReport(days),
      // Older databases have no funnel or insights yet; the rest of the report still works.
      setupFunnel(days).catch(() => []),
      ownerInsights(days).catch((err) => {
        console.error("[cf] owner insights failed:", err instanceof Error ? err.message : err)
        return null
      }),
      onboarding(days).catch((err) => {
        console.error("[cf] onboarding failed:", err instanceof Error ? err.message : err)
        return null
      }),
      newUserOutcomes(days).catch((err) => {
        console.error("[cf] new user outcomes failed:", err instanceof Error ? err.message : err)
        return null
      })
    ])
    return new Response(JSON.stringify({ ...report, setup_funnel: funnel, insights, onboarding: steps, new_outcomes: outcomes }), { headers: noStore })
  } catch (err) {
    console.error("[cf] usage report failed:", err instanceof Error ? err.message : err)
    return new Response(JSON.stringify({ code: "UNAVAILABLE" }), { status: 503, headers: noStore })
  }
}

export const config: Config = { path: "/api/v2/admin/usage" }
