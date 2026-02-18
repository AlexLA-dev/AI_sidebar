import { Storage } from "@plasmohq/storage"

// Shared storage instance for the extension
export const storage = new Storage()

// Storage keys
export const STORAGE_KEYS = {
  // License & Trial
  TRIAL_USAGE_COUNT: "trial_usage_count",
  HAS_ACTIVE_LICENSE: "has_active_license",
  PLAN_TYPE: "plan_type",
  // API Key (BYOK)
  USER_API_KEY: "user_api_key",
  // Payment provider tracking
  PAYMENT_PROVIDER: "payment_provider",
  // Pro usage tracking
  PRO_USAGE_COUNT: "pro_usage_count",
  PRO_WEEKLY_LIMIT: "pro_weekly_limit",
  PRO_LAST_RESET_AT: "pro_last_reset_at"
} as const

// Plan & pricing constants
export const LICENSE_CONFIG = {
  TRIAL_LIMIT: 5,
  BASIC: {
    label: "BYOK License",
    price: 1.99,
    description: "Unlimited interface access. Use your own API keys."
  },
  PRO: {
    label: "Pro Subscription",
    price: 6.99,
    description: "All included. No API keys needed."
  }

} as const

export type PaymentProviderType = "stripe" | "appstore" | null
export type PlanType = "free" | "byok_license" | "pro_subscription" | null

// Trial info type
export type TrialInfo = {
  usageCount: number
  hasLicense: boolean
  remaining: number
  isTrialExpired: boolean
  paymentProvider: PaymentProviderType
  planType: PlanType
  proUsageCount?: number
  proWeeklyLimit?: number
  proLastResetAt?: string | null
}

// Get trial info
export async function getTrialInfo(): Promise<TrialInfo> {
  const usageCount = (await storage.get<number>(STORAGE_KEYS.TRIAL_USAGE_COUNT)) || 0
  const hasLicense = (await storage.get<boolean>(STORAGE_KEYS.HAS_ACTIVE_LICENSE)) || false
  const paymentProvider = (await storage.get<PaymentProviderType>(STORAGE_KEYS.PAYMENT_PROVIDER)) || null
  const planType = (await storage.get<PlanType>(STORAGE_KEYS.PLAN_TYPE)) || null
  const proUsageCount = (await storage.get<number>(STORAGE_KEYS.PRO_USAGE_COUNT)) || undefined
  const proWeeklyLimit = (await storage.get<number>(STORAGE_KEYS.PRO_WEEKLY_LIMIT)) || undefined
  const proLastResetAt = (await storage.get<string>(STORAGE_KEYS.PRO_LAST_RESET_AT)) || undefined

  return {
    usageCount,
    hasLicense,
    remaining: Math.max(0, LICENSE_CONFIG.TRIAL_LIMIT - usageCount),
    isTrialExpired: !hasLicense && usageCount >= LICENSE_CONFIG.TRIAL_LIMIT,
    paymentProvider,
    planType,
    proUsageCount,
    proWeeklyLimit,
    proLastResetAt
  }
}

// Increment trial usage and sync to native app
export async function incrementTrialUsage(): Promise<number> {
  const currentCount = (await storage.get<number>(STORAGE_KEYS.TRIAL_USAGE_COUNT)) || 0
  const newCount = currentCount + 1
  await storage.set(STORAGE_KEYS.TRIAL_USAGE_COUNT, newCount)

  // Sync to native app so it shows accurate remaining count
  try {
    const { syncTrialUsage } = await import("./appstore")
    await syncTrialUsage(newCount)
  } catch {
    // Non-critical — native app just won't update immediately
  }

  return newCount
}

// Set license status
export async function setLicenseStatus(active: boolean): Promise<void> {
  await storage.set(STORAGE_KEYS.HAS_ACTIVE_LICENSE, active)
}

// Sync subscription status from native App Store bridge to local storage.
// Reads SharedDefaults (App Group) via native handler and writes to Plasmo storage.
export async function syncSubscriptionFromNative(): Promise<TrialInfo> {
  try {
    const { getSubscriptionStatus } = await import("./appstore")
    const status = await getSubscriptionStatus()

    if (status.isSubscribed) {
      await storage.set(STORAGE_KEYS.HAS_ACTIVE_LICENSE, true)
      await storage.set(STORAGE_KEYS.PAYMENT_PROVIDER, "appstore" as PaymentProviderType)
      if (status.planType) {
        await storage.set(STORAGE_KEYS.PLAN_TYPE, status.planType as PlanType)
      }
    }
  } catch (err) {
    // Non-critical — native bridge may not be available (e.g. Chrome)
    console.warn("[ContextFlow] Failed to sync subscription from native:", err)
  }

  return getTrialInfo()
}

// Sync subscription status from Supabase to local storage
export async function syncSubscriptionFromServer(): Promise<TrialInfo> {
  try {
    const { getUserSubscription } = await import("./api-client")
    const sub = await getUserSubscription()

    if (sub) {
      const isActive =
        (sub.plan_type === "pro_subscription" || sub.plan_type === "byok_license") &&
        sub.subscription_status === "active"

      await storage.set(STORAGE_KEYS.HAS_ACTIVE_LICENSE, isActive)
      await storage.set(STORAGE_KEYS.PLAN_TYPE, (sub.plan_type || "free") as PlanType)

      // Track payment provider
      if (sub.payment_provider) {
        await storage.set(STORAGE_KEYS.PAYMENT_PROVIDER, sub.payment_provider)
      }

      // Sync trial usage from server credits_balance
      if (sub.plan_type === "free" && sub.credits_balance >= 0) {
        const serverUsage = Math.max(0, LICENSE_CONFIG.TRIAL_LIMIT - sub.credits_balance)
        await storage.set(STORAGE_KEYS.TRIAL_USAGE_COUNT, serverUsage)

        // Also sync to native app
        try {
          const { syncTrialUsage } = await import("./appstore")
          await syncTrialUsage(serverUsage)
        } catch {
          // Non-critical
        }
      }

      // Sync Pro usage data
      if (sub.plan_type === "pro_subscription") {
        await storage.set(STORAGE_KEYS.PRO_USAGE_COUNT, sub.usage_count || 0)
        await storage.set(STORAGE_KEYS.PRO_WEEKLY_LIMIT, 375)
        if (sub.last_reset_at) {
          await storage.set(STORAGE_KEYS.PRO_LAST_RESET_AT, sub.last_reset_at)
        }
      }
    }
  } catch (err) {
    console.warn("[ContextFlow] Failed to sync subscription:", err)
  }

  return getTrialInfo()
}

// API Key helpers
export async function getStoredApiKey(): Promise<string> {
  const key = await storage.get<string>(STORAGE_KEYS.USER_API_KEY)
  return key || ""
}

export async function setStoredApiKey(key: string): Promise<void> {
  if (key) {
    await storage.set(STORAGE_KEYS.USER_API_KEY, key)
  } else {
    await storage.remove(STORAGE_KEYS.USER_API_KEY)
  }
}
