// «Подборки» with the AI (2.7, plan section 2; Pro, under the one AI consent): where a card goes ("place"), the layout,
// a comparison of picked cards, the summary. The texts go to /api/v2/collect for the request and aren't kept there; the
// collection itself stays on the device and in iCloud (src/shared/collections.ts). Free never calls this: «В подборку»
// suggests by words on the device (suggestPlace).

import { hasPro } from "../shared/plan"
import { API_BASE } from "../shared/config"
import type { CollectOp, CollectReply, StatusInfo } from "../shared/types"

export interface CollectContext {
  status: StatusInfo
  installId: string
  jws: string | null
  client: Record<string, unknown>
  // The one AI consent is given (the panel asks first for a tap; a suggestion without it is by words).
  agreed: boolean
}

const OPS = new Set<CollectOp>(["place", "layout", "compare", "summary"])

export async function collectAi(op: CollectOp, body: Record<string, unknown>, ctx: CollectContext): Promise<CollectReply> {
  if (!OPS.has(op)) return { ok: false, code: "NETWORK" }
  if (!hasPro(ctx.status.plan)) return { ok: false, code: "PRO_ONLY" }
  if (!ctx.agreed) return { ok: false, code: "CONSENT" }
  try {
    const res = await fetch(`${API_BASE}/api/v2/collect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, installId: ctx.installId, client: ctx.client, entitlement: ctx.jws, op }),
      // A layout of many cards takes the longest (one answer for up to 120 cards).
      signal: AbortSignal.timeout(op === "layout" ? 60_000 : 40_000)
    })
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) return { ok: true, body: out }
    const code = out.code === "PRO_ONLY" || out.code === "LIMIT_REACHED" || out.code === "OFF" ? out.code : res.status >= 500 ? "UPSTREAM" : "NETWORK"
    return { ok: false, code }
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}
