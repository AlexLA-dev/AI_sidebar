/**
 * App Store (StoreKit 2) bridge for Safari Web Extension.
 *
 * Communication flow:
 * 1. Extension JS → browser.runtime.sendNativeMessage() → SafariWebExtensionHandler
 * 2. SafariWebExtensionHandler → StoreKit 2 API → App Store
 * 3. SafariWebExtensionHandler → response → Extension JS
 *
 * The extension target must implement NSExtensionRequestHandling in
 * SafariWebExtensionHandler.swift to route StoreKit commands.
 */

import { getSupabaseClient } from "./supabase"
import { isNativeStoreKitAvailable } from "./platform"

// ── Product IDs (must match App Store Connect configuration) ──────────────

export const APPSTORE_PRODUCT_IDS = {
  basic: "com.contextflow.byok.monthly",
  pro: "com.contextflow.pro.monthly"
} as const

export type AppStoreProductId = (typeof APPSTORE_PRODUCT_IDS)[keyof typeof APPSTORE_PRODUCT_IDS]

// ── Types ─────────────────────────────────────────────────────────────────

export interface AppStoreProduct {
  id: string
  displayName: string
  description: string
  displayPrice: string
  /** Price in the user's local currency (number) */
  price: number
  /** ISO 4217 currency code */
  currencyCode: string
}

export interface AppStorePurchaseResult {
  success: boolean
  transactionId?: string
  originalTransactionId?: string
  productId?: string
  error?: string
  /** JWS-encoded transaction for server verification */
  jwsTransaction?: string
}

export interface AppStoreSubscriptionStatus {
  isSubscribed: boolean
  productId?: string
  expirationDate?: string
  isInGracePeriod?: boolean
  willAutoRenew?: boolean
}

// ── Native bridge ─────────────────────────────────────────────────────────

/**
 * Send a message to the native SafariWebExtensionHandler and wait for a response.
 * Uses browser.runtime.sendNativeMessage() — the standard Safari Web Extension
 * native messaging API.
 */
async function sendNativeMessage<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!isNativeStoreKitAvailable()) {
    throw new Error("StoreKit bridge is not available. Ensure you are running the App Store build of ContextFlow.")
  }

  const browser = (globalThis as any).browser
  const message = { command, ...params }

  const response = await browser.runtime.sendNativeMessage(
    "com.contextflow.app.Extension",
    message
  )

  if (response && response.success) {
    return response.data as T
  }

  throw new Error(response?.error || `StoreKit command "${command}" failed`)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch available products from StoreKit.
 * Returns localized pricing for the user's App Store region.
 */
export async function fetchProducts(): Promise<AppStoreProduct[]> {
  const productIds = Object.values(APPSTORE_PRODUCT_IDS)
  return sendNativeMessage<AppStoreProduct[]>("fetchProducts", { productIds })
}

/**
 * Initiate a StoreKit purchase for the given product.
 * This triggers the native payment sheet (Face ID / password confirmation).
 */
export async function purchase(productId: AppStoreProductId): Promise<AppStorePurchaseResult> {
  // Get the Supabase user ID to pass as appAccountToken for server-side linking
  let appAccountToken: string | undefined
  try {
    const supabase = getSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    appAccountToken = user?.id
  } catch {
    // Continue without token; server will try to match by other means
  }

  const result = await sendNativeMessage<AppStorePurchaseResult>("purchase", {
    productId,
    appAccountToken
  })

  // If we got a JWS transaction, verify it on our server and link to Supabase user
  if (result.success && result.jwsTransaction) {
    await verifyTransactionOnServer(result.jwsTransaction)
  }

  return result
}

/**
 * Restore previous purchases (e.g. after reinstall or on a new device).
 */
export async function restorePurchases(): Promise<AppStoreSubscriptionStatus> {
  return sendNativeMessage<AppStoreSubscriptionStatus>("restorePurchases")
}

/**
 * Get the current subscription status from StoreKit.
 */
export async function getSubscriptionStatus(): Promise<AppStoreSubscriptionStatus> {
  return sendNativeMessage<AppStoreSubscriptionStatus>("getSubscriptionStatus")
}

/**
 * Open the App Store subscription management page.
 */
export async function openManageSubscriptions(): Promise<void> {
  return sendNativeMessage<void>("manageSubscriptions")
}

// ── Server-side verification ──────────────────────────────────────────────

const API_BASE_URL = process.env.PLASMO_PUBLIC_API_URL || "/.netlify/functions"

/**
 * Send the JWS-encoded transaction to our backend for verification.
 * The backend validates the signature with Apple, then updates the
 * user_subscriptions table in Supabase.
 */
async function verifyTransactionOnServer(jwsTransaction: string): Promise<void> {
  try {
    const supabase = getSupabaseClient()
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.access_token) {
      console.warn("[AppStore] No auth session, skipping server verification")
      return
    }

    const response = await fetch(`${API_BASE_URL}/appstore-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ jwsTransaction })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      console.error("[AppStore] Server verification failed:", error)
    }
  } catch (err) {
    console.error("[AppStore] Failed to verify transaction on server:", err)
  }
}
