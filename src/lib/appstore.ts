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
  aboutMe?: string
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
 * First writes the desired plan to SharedDefaults via the native bridge
 * (reliable cross-process communication), then opens the app via URL scheme.
 * The app checks SharedDefaults on appear and auto-starts the purchase flow.
 * @param plan - Optional plan hint: "byok" or "pro".
 */
export async function openAppForSubscription(plan?: string): Promise<void> {
  // Write pending plan to SharedDefaults so the app knows what to do
  // even if the URL scheme deep link doesn't trigger .onOpenURL.
  try {
    await sendNativeMessage("setPendingSubscribe", { plan: plan || "" })
  } catch {
    // Non-critical — deep link may still work
  }

  const url = plan
    ? `contextflow://subscribe?plan=${encodeURIComponent(plan)}`
    : "contextflow://subscribe"
  // Use location.href instead of window.open — custom URL schemes
  // are not handled correctly by window.open in Safari extensions on iOS.
  window.location.href = url
}

// ── Account sync ─────────────────────────────────────────────────────────

/**
 * Sync user email and Supabase user ID to shared storage so the native app
 * can display the account and link App Store purchases to the correct user.
 * Call this after login/signup. Pass null/undefined to clear on logout.
 */
export async function syncUserInfo(email: string | null, userId?: string | null): Promise<void> {
  try {
    await sendNativeMessage("syncUserInfo", {
      email: email ?? "",
      userId: userId ?? ""
    })
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

// ── Data Sharing Consent ─────────────────────────────────────────────────

export async function syncDataConsent(given: boolean): Promise<void> {
  try {
    await sendNativeMessage("syncDataConsent", { given })
  } catch {
    // Non-critical
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

// ── About Me ─────────────────────────────────────────────────────────────

export async function syncAboutMe(aboutMe: string): Promise<void> {
  try {
    await sendNativeMessage("syncAboutMe", { aboutMe })
  } catch {
    // Non-critical
  }
}

// ── Logout sync (app → extension) ────────────────────────────────────────

/**
 * Check if the native app set a pending logout flag.
 * The extension should sign out from Supabase and clear the flag.
 */
export async function getPendingLogout(): Promise<boolean> {
  try {
    const result = await sendNativeMessage<{ pendingLogout: boolean }>("getPendingLogout")
    return result.pendingLogout === true
  } catch {
    return false
  }
}

/**
 * Clear the pending logout flag after signing out from Supabase.
 */
export async function clearPendingLogout(): Promise<void> {
  try {
    await sendNativeMessage("clearPendingLogout")
  } catch {
    // Non-critical
  }
}

// ── Auth session sync (shared between native app and extension) ──────────

export interface SharedAuthSession {
  access_token: string
  refresh_token: string
  expires_at: number
  user_id: string
  email: string
}

/**
 * Read the shared Supabase auth session from SharedDefaults (App Group).
 * Returns null if no session is stored.
 */
export async function getSharedAuthSession(): Promise<SharedAuthSession | null> {
  try {
    const result = await sendNativeMessage<Record<string, unknown>>("getAuthSession")
    if (result && typeof result.access_token === "string" && result.access_token) {
      return result as unknown as SharedAuthSession
    }
    return null
  } catch {
    return null
  }
}

/**
 * Write the current Supabase auth session to SharedDefaults so the native
 * app can display the user's account and link App Store purchases.
 * Call this after sign-in or token refresh in the extension.
 */
export async function setSharedAuthSession(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  userId: string,
  email: string
): Promise<void> {
  try {
    await sendNativeMessage("setAuthSession", {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      user_id: userId,
      email: email
    })
  } catch {
    // Non-critical on Chrome or if native bridge unavailable
  }
}

/**
 * Clear the shared auth session (on sign-out).
 */
export async function clearSharedAuthSession(): Promise<void> {
  try {
    await sendNativeMessage("clearAuthSession")
  } catch {
    // Non-critical
  }
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

