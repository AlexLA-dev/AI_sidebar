import { Storage } from "@plasmohq/storage"

// Shared storage instance for the extension
export const storage = new Storage()

// User mode type
export type UserMode = "byok" | "subscription" | null

// Storage keys
export const STORAGE_KEYS = {
  OPENAI_API_KEY: "openai_api_key",
  USER_MODE: "user_mode",
  USAGE_COUNTER: "usage_counter",
  USAGE_PERIOD_END: "usage_period_end",
  SUBSCRIPTION_ACTIVE: "subscription_active"
} as const

// Subscription constants
export const SUBSCRIPTION_CONFIG = {
  WEEKLY_LIMIT: 150,
  PRICE_MONTHLY: 6.99,
  PERIOD_DAYS: 7
} as const

// Helper to get next period end date
export function getNextPeriodEnd(): string {
  const date = new Date()
  date.setDate(date.getDate() + SUBSCRIPTION_CONFIG.PERIOD_DAYS)
  return date.toISOString()
}
