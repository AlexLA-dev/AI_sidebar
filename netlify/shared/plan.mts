import { timingSafeEqual } from "node:crypto"

import { toEntitlement, verifyTransactionCached, type Entitlement } from "./apple.mts"
import { config, PRODUCTS, type Plan } from "./config.mts"
import { logEvent, upsertEntitlement, type Counter } from "./db.mts"
import { hasPro, isUltra, PLAN_RANK } from "../../src/shared/plan.ts"

export { hasPro, isUltra } from "../../src/shared/plan.ts"

export interface Access {
  plan: Plan
  entitlement: Entitlement | null
  // Why a provided entitlement was not honoured (for diagnostics in the client).
  entitlementError?: string
}

/**
 * Resolves the caller's plan from the Apple-signed StoreKit transaction the
 * extension forwards (no accounts). The database only adds what the device
 * may not know yet: refunds/revocations and renewals from App Store Server
 * Notifications.
 */
export async function resolveAccess(jws: unknown, installId: string | null): Promise<Access> {
  if (typeof jws !== "string" || jws.length < 100 || jws.length > 20_000) {
    return { plan: "free", entitlement: null }
  }

  const { tx, error } = verifyTransactionCached(jws)
  if (!tx) {
    void logEvent("entitlement_invalid", installId, { reason: error })
    return { plan: "free", entitlement: null, entitlementError: error }
  }
  const entitlement = toEntitlement(tx)
  if (!entitlement) return { plan: "free", entitlement: null, entitlementError: "unknown product" }

  let expiresAt = entitlement.expiresAt
  let revoked = typeof tx.revocationDate === "number"
  try {
    const row = await upsertEntitlement({
      original_transaction_id: entitlement.originalTransactionId,
      product_id: entitlement.productId,
      environment: entitlement.environment,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      revoked_at: revoked ? new Date(tx.revocationDate as number).toISOString() : null,
      app_account_token: entitlement.appAccountToken ?? null,
      last_transaction_id: String(tx.transactionId)
    })
    if (row?.revoked_at) revoked = true
    if (row?.expires_at) {
      const renewed = Date.parse(row.expires_at)
      const rowPlan = PRODUCTS[row.product_id]
      // A renewal the device hasn't seen yet extends the plan the device sent. When the subscription has moved to
      // another plan at that renewal (Ultra → Pro, a downgrade), the newer plan is the one that renewed: an old
      // signed Ultra transaction must not keep Ultra going (the 2.6 cf_entitlement_upsert keeps the newer product).
      if (renewed > (expiresAt ?? 0)) {
        expiresAt = renewed
        if (rowPlan && rowPlan !== entitlement.plan && PLAN_RANK[rowPlan] < PLAN_RANK[entitlement.plan]) {
          entitlement.plan = rowPlan
          entitlement.productId = row.product_id
        }
      }
    }
  } catch (err) {
    // Database trouble must not lock paying users out: fall back to the signed data.
    console.error("[cf] entitlement upsert failed:", err instanceof Error ? err.message : err)
  }

  if (revoked) return { plan: "free", entitlement: null, entitlementError: "revoked" }
  if (expiresAt && expiresAt + config.entitlementLeewayMs < Date.now()) {
    return { plan: "free", entitlement: null, entitlementError: "expired" }
  }
  return { plan: entitlement.plan, entitlement: { ...entitlement, expiresAt } }
}

/** The App Store offer code shown to a free user who ran out of answers (null when switched off). */
export function proOffer(access: Access): { code: string; discount: number } | null {
  const code = config.proOfferCode
  if (access.plan !== "free" || !code || code.toLowerCase() === "off") return null
  return { code, discount: config.proOfferDiscount }
}

/**
 * Deploy previews only (never production): a request with the admin token in `x-cf-eval` counts as Ultra, so
 * read aloud and the Ultra counters can be measured there without a purchase (StoreKit test transactions aren't
 * signed by Apple). The counters go to `eval:<install>`; the rows are marked as tests (db.mts testMark).
 */
export function evalAccess(req: Request, installId: string, context?: { deploy?: { context?: string } }): Access | null {
  return evalCheck(req, installId, context).access
}

/** evalAccess and, when it says no to a request that tried, why ("context", "token"): never the token itself. */
export function evalCheck(req: Request, installId: string, context?: { deploy?: { context?: string } }): { access: Access | null; refused?: "context" | "token" } {
  if (!req.headers.has("x-cf-eval")) return { access: null }
  const deploy = context?.deploy?.context ??
    (globalThis as { Netlify?: { context?: { deploy?: { context?: string } } | null } }).Netlify?.context?.deploy?.context ?? process.env.CONTEXT
  if (!deploy || deploy === "production" || !config.adminToken) return { access: null, refused: "context" }
  const given = Buffer.from(req.headers.get("x-cf-eval") ?? "")
  const token = Buffer.from(config.adminToken)
  if (given.length !== token.length || !timingSafeEqual(given, token)) return { access: null, refused: "token" }
  return { access: evalUltra(installId) }
}

function evalUltra(installId: string): Access {
  return {
    plan: "ultra",
    entitlement: { plan: "ultra", productId: "com.contextflow.ultra.monthly", originalTransactionId: `eval-${installId}`, environment: "Sandbox", expiresAt: Date.now() + 86_400_000 }
  }
}

/** The weekly answer allowance of a Pro-level plan (Ultra has its own setting, by default the same). */
function proLimit(plan: Plan): number {
  return isUltra(plan) ? config.ultra.weeklyLimit : config.proWeeklyLimit
}

/** Counters a request is charged against, by plan. */
export function countersFor(access: Access, installId: string, ipSubject: string): Counter[] {
  if (hasPro(access.plan) && access.entitlement) {
    // One counter per subscription: an upgrade Pro → Ultra keeps the original transaction, so what was used
    // this week carries over.
    return [
      { subject: `tx:${access.entitlement.originalTransactionId}`, period: "week", limit: proLimit(access.plan) },
      { subject: "global:pro", period: "day", limit: null }
    ]
  }
  // Free and BYOK users share the free allowance when they use our server
  // (BYOK subscribers normally talk to OpenAI directly with their own key).
  return [
    { subject: `install:${installId}`, period: "day", limit: config.freeDailyLimit },
    { subject: ipSubject, period: "day", limit: config.freeIpDailyLimit },
    { subject: "global:free", period: "day", limit: config.freeGlobalDailyLimit }
  ]
}

/** Extra counters for a Google (search-grounded) answer, charged together with countersFor(). */
export function searchCountersFor(access: Access, installId: string): Counter[] {
  const own = hasPro(access.plan) && access.entitlement
    ? { subject: `search:tx:${access.entitlement.originalTransactionId}`, period: "week" as const, limit: config.searchProWeeklyLimit }
    : { subject: `search:install:${installId}`, period: "day" as const, limit: config.searchFreeDailyLimit }
  return [own, { subject: "global:search", period: "day", limit: config.searchGlobalDailyLimit }]
}

/** Read aloud (Ultra): `seconds` of audio, charged before speaking (estimated from the text, see speak.mts). */
export function speakCountersFor(access: Access, seconds: number): Counter[] {
  const amount = Math.max(1, Math.ceil(seconds))
  const otid = access.entitlement?.originalTransactionId ?? "none"
  return [
    { subject: `speak:tx:${otid}`, period: "week", limit: config.ultra.speakWeeklySeconds, amount },
    { subject: "global:speak", period: "day", limit: config.ultra.speakGlobalDailySeconds, amount }
  ]
}

/** Find similar (Ultra): one search. The engine (/api/v2/similar) charges these before it searches. */
export function similarCountersFor(access: Access): Counter[] {
  const otid = access.entitlement?.originalTransactionId ?? "none"
  return [
    { subject: `similar:tx:${otid}`, period: "week", limit: config.ultra.similarWeekly },
    { subject: "global:similar", period: "day", limit: config.ultra.similarGlobalDaily }
  ]
}

/** An Ultra allowance as the clients show it: used of limit this week, and when it starts again. */
export function ultraUsage(counters: { subject: string; n: number; limit: number | null }[], prefix: "speak:" | "similar:"): Usage | null {
  const own = counters.find((c) => c.subject.startsWith(prefix) && !c.subject.startsWith("global:"))
  if (!own || own.limit === null) return null
  return { used: own.n, limit: own.limit, period: "week", resetsAt: nextReset("week") }
}

export interface Usage {
  used: number
  limit: number
  period: "day" | "week"
  resetsAt: string
}

/** The counter the user sees ("3 of 5 today"). */
export function visibleUsage(access: Access, counters: { subject: string; period: "day" | "week"; n: number; limit: number | null }[]): Usage {
  const main = counters.find((c) => c.subject.startsWith(hasPro(access.plan) ? "tx:" : "install:")) ?? counters[0]
  return {
    used: main?.n ?? 0,
    limit: main?.limit ?? (hasPro(access.plan) ? proLimit(access.plan) : config.freeDailyLimit),
    period: main?.period ?? "day",
    resetsAt: nextReset(main?.period ?? "day")
  }
}

function nextReset(period: "day" | "week"): string {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  if (period === "week") {
    const daysToMonday = (8 - next.getUTCDay()) % 7
    next.setUTCDate(next.getUTCDate() + daysToMonday)
  }
  return next.toISOString()
}

/** Explains which limit stopped the request. */
export function blockReason(blocked: string | null): "limit" | "busy" | "ip" | "search" | "speak" | "similar" {
  if (!blocked) return "limit"
  if (blocked.startsWith("global:")) return "busy"
  if (blocked.startsWith("ip:")) return "ip"
  if (blocked.startsWith("search:")) return "search"
  if (blocked.startsWith("speak:")) return "speak"
  if (blocked.startsWith("similar:")) return "similar"
  return "limit"
}
