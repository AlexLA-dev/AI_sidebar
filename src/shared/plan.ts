// The plans and what each one unlocks (2.6: Ultra). Shared by the panel, the background worker and the server,
// so "Ultra counts as Pro" holds everywhere: every Pro check goes through hasPro(), every Ultra-only one through
// isUltra(). The app (StoreKitManager.swift) mirrors the product lists below.

export type Plan = "free" | "pro" | "byok" | "ultra"
export type PaidPlan = Exclude<Plan, "free">
export type Period = "monthly" | "yearly"

/** App Store products by plan, monthly first. Matches App Store Connect (one subscription group). */
export const PLAN_PRODUCTS = {
  ultra: ["com.contextflow.ultra.monthly", "com.contextflow.ultra.yearly"],
  pro: ["com.contextflow.pro.monthly", "com.contextflow.pro.yearly"],
  byok: ["com.contextflow.byok.monthly", "com.contextflow.byok.yearly"]
} as const satisfies Record<PaidPlan, readonly [string, string]>

export type ProductId = (typeof PLAN_PRODUCTS)[PaidPlan][number]

/** The plan a product id belongs to; "free" for anything we don't sell (or no product). */
export function planOfProduct(productId: string | null | undefined): Plan {
  if (!productId) return "free"
  for (const plan of Object.keys(PLAN_PRODUCTS) as PaidPlan[]) {
    if ((PLAN_PRODUCTS[plan] as readonly string[]).includes(productId)) return plan
  }
  return "free"
}

/** The product of a plan and period ("com.contextflow.ultra.yearly"). */
export function productOf(plan: PaidPlan, period: Period): ProductId {
  return PLAN_PRODUCTS[plan][period === "yearly" ? 1 : 0]
}

export function periodOfProduct(productId: string | null | undefined): Period | null {
  if (!productId) return null
  return productId.endsWith(".yearly") ? "yearly" : productId.endsWith(".monthly") ? "monthly" : null
}

/** Everything Pro unlocks: Pro itself and Ultra (Ultra is everything in Pro and more). Own key is not Pro. */
export function hasPro(plan: Plan | null | undefined): plan is "pro" | "ultra" {
  return plan === "pro" || plan === "ultra"
}

/** Ultra-only features: read aloud, find similar, more watched pages. */
export function isUltra(plan: Plan | null | undefined): plan is "ultra" {
  return plan === "ultra"
}

export function isPaid(plan: Plan | null | undefined): plan is PaidPlan {
  return plan === "pro" || plan === "ultra" || plan === "byok"
}

/** Subscription group order in App Store Connect, top first: moving up is an upgrade (starts at once, Apple
 * refunds the rest of the old plan), moving down starts at the next renewal. */
export const PLAN_RANK: Record<Plan, number> = { ultra: 3, pro: 2, byok: 1, free: 0 }

/** Pages watched at once, by plan (counted on the device). Own key watches as many as Pro. */
export const WATCH_LIMITS: Record<Plan, number> = { free: 5, byok: 20, pro: 20, ultra: 50 }

export function watchLimit(plan: Plan | null | undefined): number {
  return WATCH_LIMITS[plan ?? "free"] ?? WATCH_LIMITS.free
}

/** Ultra's own allowances, as the server gives them in /api/v2/status (these are the defaults the clients show
 * offline). Read aloud is counted in seconds of audio, find similar in searches; both reset on Monday (UTC). */
export const ULTRA_DEFAULTS = { speakWeeklySeconds: 1800, similarWeekly: 10 } as const

/** The link that opens the ContextFlow app on a plan and period (2.6), or on its plans or home. */
export function appLink(target: "subscribe" | "manage" | "home", feature?: "ai" | "organize" | "listen" | "watch", plan: PaidPlan = "pro", period?: Period): string {
  const query = [`plan=${plan}`, period ? `period=${period}` : "", feature ? `feature=${feature}` : ""].filter(Boolean).join("&")
  return target === "subscribe" ? `contextflow://subscribe?${query}` : target === "manage" ? "contextflow://manage" : "contextflow://open"
}

/** What the plans sheet says about each plan when no status came (build 92: the sheet showed bare plan names). */
export const DEFAULT_PLAN_FACTS = {
  freeDaily: 5, proWeekly: 375, ultraWeekly: 375, searchProWeekly: 50,
  speakWeeklySeconds: ULTRA_DEFAULTS.speakWeeklySeconds, similarWeekly: ULTRA_DEFAULTS.similarWeekly, watch: WATCH_LIMITS
} as const
