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

import { isNativeStoreKitAvailable } from "./platform"

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
 */
export function openAppForSubscription(): void {
  window.open("contextflow://subscribe", "_blank")
}
