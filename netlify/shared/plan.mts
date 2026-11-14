import { createPublicKey, verify } from "node:crypto"

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
 * Deploy previews only (never production): a request signed with the measuring key counts as Ultra, so read aloud
 * and the Ultra counters can be measured there without a purchase (StoreKit test transactions aren't signed by
 * Apple). `x-cf-eval: <ms>.<Ed25519 signature of "<installId>.<ms>", base64url>`, at most 10 minutes old. Only the
 * public key is here (CF_EVAL_PUBLIC_KEY replaces it, for tests); the private key never leaves the measuring Mac.
 * The counters go to `tx:eval-<install>`; the rows are marked as tests (db.mts testMark).
 */
const EVAL_PUBLIC_KEY = "MCowBQYDK2VwAyEAv7vts/GRgB6nrdl42cv/23RdbMSGjYQufT8U5z7SifU="
const EVAL_MAX_AGE_MS = 10 * 60_000

function evalSigned(header: string, installId: string): boolean {
  const [ts, sig] = header.split(".")
  const at = Number(ts)
  if (!sig || !Number.isFinite(at) || Math.abs(Date.now() - at) > EVAL_MAX_AGE_MS) return false
  try {
    const raw = (process.env.CF_EVAL_PUBLIC_KEY ?? EVAL_PUBLIC_KEY).trim()
    const key = createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" })
    return verify(null, Buffer.from(`${installId}.${ts}`), key, Buffer.from(sig, "base64url"))
  } catch {
    return false
  }
}

export function evalAccess(req: Request, installId: string, context?: { deploy?: { context?: string } }): Access | null {
  return evalCheck(req, installId, context).access
}

/** evalAccess and, when it says no to a request that tried, why ("context", "token"): never the token itself. */
export function evalCheck(req: Request, installId: string, context?: { deploy?: { context?: string } }): { access: Access | null; refused?: "context" | "token" } {
  if (!req.headers.has("x-cf-eval")) return { access: null }
  const deploy = context?.deploy?.context ??
    (globalThis as { Netlify?: { context?: { deploy?: { context?: string } } | null } }).Netlify?.context?.deploy?.context ?? process.env.CONTEXT
  if (!deploy || deploy === "production") return { access: null, refused: "context" }
  if (!evalSigned(req.headers.get("x-cf-eval") ?? "", installId)) return { access: null, refused: "token" }
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
export function speakCountersFor(access: Access, seconds: number, finishing = false): Counter[] {
  const amount = Math.max(1, Math.ceil(seconds))
  const otid = access.entitlement?.originalTransactionId ?? "none"
  // A text already playing finishes in the same voice (build 90, the owner heard Apple's voice take over at the end):
  // its later parts may run over the week's minutes by up to speakFinishSeconds; a new text can't.
  const limit = config.ultra.speakWeeklySeconds + (finishing ? config.ultra.speakFinishSeconds : 0)
  return [
    { subject: `speak:tx:${otid}`, period: "week", limit, amount },
    { subject: "global:speak", period: "day", limit: config.ultra.speakGlobalDailySeconds, amount }
  ]
}

/**
 * Read aloud's own caps on audio made (build 92, the owner: "30 s heard is 30 s off; the rest is our economy"): per
 * subscription a week, a share of the allowance above it (ULTRA_SPEAK_MADE_PERCENT), and for everyone a day. What's made
 * isn't the user's minutes; what's heard is (speakCountersFor, through /api/v2/speak-heard).
 */
export function speakMadeCountersFor(access: Access, seconds: number): Counter[] {
  const amount = Math.max(1, Math.ceil(seconds))
  const otid = access.entitlement?.originalTransactionId ?? "none"
  return [
    { subject: `speakmade:tx:${otid}`, period: "week", limit: Math.round((config.ultra.speakWeeklySeconds * config.ultra.speakMadePercent) / 100), amount },
    { subject: "global:speak", period: "day", limit: config.ultra.speakGlobalDailySeconds, amount }
  ]
}

/**
 * Find similar (Ultra): one search against the subscription's weekly allowance. The engine (/api/v2/similar) charges
 * it together with its own daily safety caps before it searches (consume), gives it back when nothing came (refund),
 * and answers LIMIT_REACHED with ultraUsage(…, "similar:") when blockReason() says "similar".
 */
export function similarCountersFor(access: Access): Counter[] {
  const otid = access.entitlement?.originalTransactionId ?? "none"
  return [{ subject: `similar:tx:${otid}`, period: "week", limit: config.ultra.similarWeekly }]
}

/**
 * Find similar's light search (2.7, everyone not on Ultra): the week's free searches per device, a wider week per network
 * address, and a day for everyone. LIMIT_REACHED shows ultraUsage(…, "similarfree:").
 */
export function similarFreeCounters(installId: string, ip: string): Counter[] {
  return [
    { subject: `similarfree:${installId}`, period: "week", limit: config.similar.freeWeekly },
    { subject: `similarfree:ip:${ip}`, period: "week", limit: config.similar.freeIpWeekly },
    { subject: "global:similarfree", period: "day", limit: config.similar.freeGlobalDaily }
  ]
}

/** An Ultra allowance (or the light search's week) as the clients show it: used of limit, and when it starts again. */
export function ultraUsage(counters: { subject: string; n: number; limit: number | null }[], prefix: "speak:" | "similar:" | "similarfree:"): Usage | null {
  const own = counters.find((c) => c.subject.startsWith(prefix) && !c.subject.startsWith("global:"))
  if (!own || own.limit === null) return null
  // The allowance as sold (a text's finishing room isn't shown).
  const limit = prefix === "speak:" ? Math.min(own.limit, config.ultra.speakWeeklySeconds) : own.limit
  return { used: own.n, limit, period: "week", resetsAt: nextReset("week") }
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
  if (blocked.startsWith("similar:") || blocked.startsWith("similarfree:")) return "similar"
  return "limit"
}
