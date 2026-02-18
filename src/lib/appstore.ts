/**
 * App Store subscription bridge for Safari Web Extension.
 *
 * Purchases are now handled in the native ContextFlow app.
 * This module only reads subscription status from the native handler,
 * which reads from App Group shared UserDefaults.
 *
 * Communication flow:
 * 1. Extension page → chrome.runtime.sendMessage() → Background script
 * 2. Background script → browser.runtime.sendNativeMessage() → SafariWebExtensionHandler
 * 3. SafariWebExtensionHandler → SharedDefaults (App Group) → returns status
 */

import { isSafari, isNativeStoreKitAvailable } from "./platform"

// ── Product IDs (must match App Store Connect configuration) ──────────────

export const APPSTORE_PRODUCT_IDS = {
  basic: "com.contextflow.byok.monthly",
  pro: "com.contextflow.pro.monthly"
} as const

export type AppStoreProductId = (typeof APPSTORE_PRODUCT_IDS)[keyof typeof APPSTORE_PRODUCT_IDS]

// ── Types ─────────────────────────────────────────────────────────────────

export interface AppStoreSubscriptionStatus {
  isSubscribed: boolean
  productId?: string
  planType?: string
  expirationDate?: string
  isInGracePeriod?: boolean
  willAutoRenew?: boolean
  lastUpdated?: number
}

export interface AppStoreSettings {
  fontSize: number
  theme: string
}

// ── Native bridge ─────────────────────────────────────────────────────────

/**
 * Send a command to the native SafariWebExtensionHandler.
 * Relays through the background script since extension pages
 * don't have access to browser.runtime.sendNativeMessage().
 */
async function sendNativeMessage<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!isNativeStoreKitAvailable()) {
    throw new Error("Native bridge is not available.")
  }

  const response = await chrome.runtime.sendMessage({
    action: "native",
    command,
    ...params
  })

  if (response && response.success) {
    return response.data as T
  }

  throw new Error(response?.error || `Native command "${command}" failed`)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get subscription status from App Group shared storage.
 * This is fast — no StoreKit initialization, just reads UserDefaults.
 */
export async function getSubscriptionStatus(): Promise<AppStoreSubscriptionStatus> {
  return sendNativeMessage<AppStoreSubscriptionStatus>("getSubscriptionStatus")
}

/**
 * Get extension settings from the native app (font size, theme).
 */
export async function getAppSettings(): Promise<AppStoreSettings> {
  return sendNativeMessage<AppStoreSettings>("getSettings")
}

/**
 * Check if there's an active subscription via the native bridge.
 * Returns false if the bridge is not available (e.g., Chrome).
 */
export async function checkNativeSubscription(): Promise<boolean> {
  try {
    const status = await getSubscriptionStatus()
    return status.isSubscribed === true
  } catch {
    return false
  }
}

/**
 * Open the App Store subscription management page.
 */
export function openManageSubscriptions(): void {
  window.open("https://apps.apple.com/account/subscriptions", "_blank")
}

/**
 * Open the ContextFlow native app for subscription purchase.
 * Uses a custom URL scheme registered by the app.
 * @param plan - Optional plan hint: "byok" or "pro". Passed as ?plan= query param.
 */
export function openAppForSubscription(plan?: string): void {
  const url = plan
    ? `contextflow://subscribe?plan=${encodeURIComponent(plan)}`
    : "contextflow://subscribe"
  window.open(url, "_blank")
}

// ── Account sync ─────────────────────────────────────────────────────────

/**
 * Sync user email to shared storage so the native app can display it.
 * Call this after login/signup. Pass null/undefined to clear on logout.
 */
export async function syncUserInfo(email: string | null): Promise<void> {
  try {
    await sendNativeMessage("syncUserInfo", { email: email ?? "" })
  } catch {
    // Non-critical — native app just won't show email
    console.warn("[ContextFlow] Failed to sync user info:", email)
  }
}

/**
 * Sync trial usage count to shared storage so the native app shows
 * accurate "X of 5 requests remaining". Call after incrementTrialUsage().
 */
export async function syncTrialUsage(count: number): Promise<void> {
  try {
    await sendNativeMessage("syncTrialUsage", { count })
  } catch {
    // Non-critical — native app will just show stale count
  }
}

// ── API Key (BYOK) ──────────────────────────────────────────────────────

/**
 * Get API key from shared storage (set in native app or extension).
 */
export async function getNativeApiKey(): Promise<string> {
  try {
    const result = await sendNativeMessage<{ apiKey: string }>("getApiKey")
    return result.apiKey || ""
  } catch {
    return ""
  }
}

/**
 * Set API key in shared storage (accessible by both app and extension).
 */
export async function setNativeApiKey(apiKey: string): Promise<void> {
  await sendNativeMessage("setApiKey", { apiKey })
}

// ── Health check ─────────────────────────────────────────────────────────

/**
 * Ping the native handler to verify the messaging bridge works.
 */
export async function pingNative(): Promise<boolean> {
  try {
    const result = await sendNativeMessage<{ pong: boolean }>("ping")
    return result.pong === true
  } catch {
    return false
  }
}

