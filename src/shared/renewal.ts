// The one question a Pro user who turned auto-renew off is asked (the app and the panel, once per
// subscription period): what was missing. The answer goes to /api/v2/event as "renewal_off"; no offer
// of any kind is made before the subscription ends.

// "later": put off without an answer (not asked again this period either).
export const RENEWAL_REASONS = ["price", "rarely", "answers", "features", "free_enough", "other"] as const
export type RenewalReason = (typeof RENEWAL_REASONS)[number] | "later"

export function isRenewalReason(value: unknown): value is RenewalReason {
  return value === "later" || (RENEWAL_REASONS as readonly unknown[]).includes(value)
}

/** Whole days until the subscription ends (0 on its last day; null without a date). */
export function daysLeft(expiresAt: string | null | undefined, now = Date.now()): number | null {
  const end = expiresAt ? Date.parse(expiresAt) : NaN
  return Number.isFinite(end) ? Math.max(0, Math.floor((end - now) / 86_400_000)) : null
}
