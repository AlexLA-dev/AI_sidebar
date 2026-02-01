import { Storage } from "@plasmohq/storage"

// Shared storage instance for the extension
export const storage = new Storage()

// Storage keys
export const STORAGE_KEYS = {
  // License & Trial
  TRIAL_USAGE_COUNT: "trial_usage_count",
  HAS_ACTIVE_LICENSE: "has_active_license",
  // API Key (BYOK)
  USER_API_KEY: "user_api_key"
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

// Trial info type
export type TrialInfo = {
  usageCount: number
  hasLicense: boolean
  remaining: number
  isTrialExpired: boolean
}

// Get trial info
export async function getTrialInfo(): Promise<TrialInfo> {
  const usageCount = (await storage.get<number>(STORAGE_KEYS.TRIAL_USAGE_COUNT)) || 0
  const hasLicense = (await storage.get<boolean>(STORAGE_KEYS.HAS_ACTIVE_LICENSE)) || false

  return {
    usageCount,
    hasLicense,
    remaining: Math.max(0, LICENSE_CONFIG.TRIAL_LIMIT - usageCount),
    isTrialExpired: !hasLicense && usageCount >= LICENSE_CONFIG.TRIAL_LIMIT
  }
}

// Increment trial usage
export async function incrementTrialUsage(): Promise<number> {
  const currentCount = (await storage.get<number>(STORAGE_KEYS.TRIAL_USAGE_COUNT)) || 0
  const newCount = currentCount + 1
  await storage.set(STORAGE_KEYS.TRIAL_USAGE_COUNT, newCount)
  return newCount
}

// Set license status
export async function setLicenseStatus(active: boolean): Promise<void> {
  await storage.set(STORAGE_KEYS.HAS_ACTIVE_LICENSE, active)
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

      // Sync trial usage from server credits_balance
      if (sub.plan_type === "free" && sub.credits_balance >= 0) {
        const serverUsage = LICENSE_CONFIG.TRIAL_LIMIT - sub.credits_balance
        await storage.set(STORAGE_KEYS.TRIAL_USAGE_COUNT, Math.max(0, serverUsage))
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
