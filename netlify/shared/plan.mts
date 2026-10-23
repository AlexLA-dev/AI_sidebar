import { toEntitlement, verifyTransactionCached, type Entitlement } from "./apple.mts"
import { config, type Plan } from "./config.mts"
import { getEntitlement, logEvent, upsertEntitlement, type Counter } from "./db.mts"

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
    if (row?.expires_at) expiresAt = Math.max(expiresAt ?? 0, Date.parse(row.expires_at))
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

/** Counters a request is charged against, by plan. */
export function countersFor(access: Access, installId: string, ipSubject: string): Counter[] {
  if (access.plan === "pro" && access.entitlement) {
    return [
      { subject: `tx:${access.entitlement.originalTransactionId}`, period: "week", limit: config.proWeeklyLimit },
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

export interface Usage {
  used: number
  limit: number
  period: "day" | "week"
  resetsAt: string
}

/** The counter the user sees ("3 of 5 today"). */
export function visibleUsage(access: Access, counters: { subject: string; period: "day" | "week"; n: number; limit: number | null }[]): Usage {
  const main = counters.find((c) => c.subject.startsWith(access.plan === "pro" ? "tx:" : "install:")) ?? counters[0]
  return {
    used: main?.n ?? 0,
    limit: main?.limit ?? (access.plan === "pro" ? config.proWeeklyLimit : config.freeDailyLimit),
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
export function blockReason(blocked: string | null): "limit" | "busy" | "ip" {
  if (!blocked) return "limit"
  if (blocked.startsWith("global:")) return "busy"
  if (blocked.startsWith("ip:")) return "ip"
  return "limit"
}
