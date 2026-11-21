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

/**
 * Find similar's light search for Own key and Pro (2.7, the owner: «Свой ключ и Pro получают тоже поиск похожего, но до
 * 5 в неделю»): searches a week per device. The one number: the server's default (env SIMILAR_LIGHT_WEEKLY overrides it
 * there, and the status then says so), and what the panel says before a status came. Free has no Find similar.
 */
export const SIMILAR_LIGHT_WEEKLY = 5

/** What one light search costs a Pro subscriber in answers (2.7, the owner: «У Pro каждый поиск = 10 ответов»). */
export const SIMILAR_PRO_ANSWERS = 10

/**
 * The agent (2.7.1, «Сделай на этой странице»): Pro and Ultra only. Tasks a day per subscription, and deferred tasks
 * waiting at once on a device (the owner, 2026-11-21: Pro 5 / Ultra 20 a day; «Отложенных дел тоже сделай 5 и 20»).
 * The server's defaults (env AGENT_PRO_DAILY, AGENT_ULTRA_DAILY, AGENT_DEFERRED_PRO, AGENT_DEFERRED_ULTRA override them
 * there, and the status then says so), and what the panel says before a status came. Own key has no agent.
 */
export const AGENT_DEFAULTS = { proDaily: 5, ultraDaily: 20, deferredPro: 5, deferredUltra: 20, maxSteps: 30 } as const

export interface AgentLimits {
  proDaily: number
  ultraDaily: number
  deferredPro: number
  deferredUltra: number
  maxSteps: number
}

/** Agent tasks a day on a plan (0: no agent on it). */
export function agentDaily(plan: Plan | null | undefined, limits: AgentLimits = AGENT_DEFAULTS): number {
  return isUltra(plan) ? limits.ultraDaily : hasPro(plan) ? limits.proDaily : 0
}

/** Deferred agent tasks a device keeps waiting at once on a plan. */
export function agentDeferred(plan: Plan | null | undefined, limits: AgentLimits = AGENT_DEFAULTS): number {
  return isUltra(plan) ? limits.deferredUltra : hasPro(plan) ? limits.deferredPro : 0
}

/** The link that opens the ContextFlow app on a plan and period (2.6), or on its plans or home. */
export function appLink(target: "subscribe" | "manage" | "home", feature?: "ai" | "organize" | "listen" | "watch", plan: PaidPlan = "pro", period?: Period): string {
  const query = [`plan=${plan}`, period ? `period=${period}` : "", feature ? `feature=${feature}` : ""].filter(Boolean).join("&")
  return target === "subscribe" ? `contextflow://subscribe?${query}` : target === "manage" ? "contextflow://manage" : "contextflow://open"
}

/** What the plans sheet says about each plan when no status came (build 92: the sheet showed bare plan names). */
export const DEFAULT_PLAN_FACTS = {
  freeDaily: 5, proWeekly: 375, ultraWeekly: 375, searchProWeekly: 50,
  speakWeeklySeconds: ULTRA_DEFAULTS.speakWeeklySeconds, similarWeekly: ULTRA_DEFAULTS.similarWeekly, similarLightWeekly: SIMILAR_LIGHT_WEEKLY, similarProAnswers: SIMILAR_PRO_ANSWERS, watch: WATCH_LIMITS
} as const

/**
 * Find similar's colour (107, the owner: «сиреневый цвет у кнопки Find similar, хотя там уже Pro»): violet is Ultra's,
 * so only Ultra's full search wears it; Pro's and Own key's light search, and the offer of Pro to Free, are blue.
 */
export function similarTone(plan: Plan | null | undefined): "ultra" | "pro" {
  return isUltra(plan) ? "ultra" : "pro"
}
