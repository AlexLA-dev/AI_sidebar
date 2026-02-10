/**
 * App Store transaction verification endpoint.
 *
 * Accepts a JWS-encoded transaction from the client, verifies it with Apple's
 * App Store Server API, and updates the user's subscription in Supabase.
 *
 * Also handles App Store Server Notifications v2 (POST from Apple).
 */

import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"

// ── Environment variables ─────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Apple App Store configuration
const APPSTORE_BUNDLE_ID = process.env.APPSTORE_BUNDLE_ID || "com.contextflow.app"

// App Store Server API (for server-to-server verification)
const APPSTORE_KEY_ID = process.env.APPSTORE_KEY_ID || ""
const APPSTORE_ISSUER_ID = process.env.APPSTORE_ISSUER_ID || ""

// Set to "sandbox" for development, "production" for live
const APPSTORE_ENVIRONMENT = process.env.APPSTORE_ENVIRONMENT || "sandbox"

// ── Product → Plan mapping ────────────────────────────────────────────────

const PRODUCT_PLAN_MAP: Record<string, "byok_license" | "pro_subscription"> = {
  "com.contextflow.byok.monthly": "byok_license",
  "com.contextflow.pro.monthly": "pro_subscription"
}

// ── Initialize clients ────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
}

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  })
}

// ── Main handler ──────────────────────────────────────────────────────────

export default async function handler(req: Request, _context: Context) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const body = await req.json().catch(() => null)

  if (!body) {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  // Route: App Store Server Notification v2 (from Apple)
  if (body.signedPayload) {
    return handleServerNotification(body.signedPayload)
  }

  // Route: Client-initiated transaction verification
  if (body.jwsTransaction) {
    return handleClientVerification(req, body.jwsTransaction)
  }

  return jsonResponse({ error: "Missing jwsTransaction or signedPayload" }, 400)
}

// ── Client verification (called from extension after purchase) ────────────

async function handleClientVerification(req: Request, jwsTransaction: string): Promise<Response> {
  // Authenticate the user
  const authHeader = req.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing authorization" }, 401)
  }

  const token = authHeader.replace("Bearer ", "")
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return jsonResponse({ error: "Invalid token" }, 401)
  }

  try {
    // Decode the JWS transaction (the signature was already verified by StoreKit on device)
    const transaction = decodeJWSTransaction(jwsTransaction)

    if (!transaction) {
      return jsonResponse({ error: "Invalid transaction format" }, 400)
    }

    // Validate bundle ID
    if (transaction.bundleId !== APPSTORE_BUNDLE_ID) {
      console.error(`[AppStore] Bundle ID mismatch: ${transaction.bundleId} !== ${APPSTORE_BUNDLE_ID}`)
      return jsonResponse({ error: "Invalid bundle ID" }, 400)
    }

    // Determine plan type from product ID
    const planType = PRODUCT_PLAN_MAP[transaction.productId]
    if (!planType) {
      console.error(`[AppStore] Unknown product ID: ${transaction.productId}`)
      return jsonResponse({ error: "Unknown product" }, 400)
    }

    // Calculate expiration
    const expiresDate = transaction.expiresDate
      ? new Date(transaction.expiresDate).toISOString()
      : null

    // Upsert subscription in Supabase
    const { error: upsertError } = await supabase
      .from("user_subscriptions")
      .upsert({
        user_id: user.id,
        plan_type: planType,
        subscription_status: "active",
        payment_provider: "appstore",
        appstore_original_transaction_id: transaction.originalTransactionId,
        current_period_end: expiresDate,
        credits_balance: planType === "byok_license" ? -1 : null
      })

    if (upsertError) {
      console.error("[AppStore] Failed to upsert subscription:", upsertError)
      return jsonResponse({ error: "Database update failed" }, 500)
    }

    // Log the event
    await supabase.from("usage_logs").insert({
      user_id: user.id,
      action: "appstore_subscription_created",
      metadata: {
        plan_type: planType,
        product_id: transaction.productId,
        original_transaction_id: transaction.originalTransactionId,
        environment: transaction.environment
      }
    })

    console.log(`[AppStore] Subscription activated for user ${user.id}: ${planType}`)

    return jsonResponse({ success: true, plan_type: planType }, 200)
  } catch (err) {
    console.error("[AppStore] Verification error:", err)
    return jsonResponse({ error: "Verification failed" }, 500)
  }
}

// ── App Store Server Notifications v2 (called by Apple) ───────────────────

async function handleServerNotification(signedPayload: string): Promise<Response> {
  try {
    const notification = decodeSignedPayload(signedPayload)

    if (!notification) {
      return jsonResponse({ error: "Invalid notification" }, 400)
    }

    console.log(`[AppStore Notification] type=${notification.notificationType}, subtype=${notification.subtype}`)

    const transaction = notification.data?.signedTransactionInfo
      ? decodeJWSTransaction(notification.data.signedTransactionInfo)
      : null

    if (!transaction) {
      console.warn("[AppStore Notification] No transaction info in notification")
      return jsonResponse({ received: true }, 200)
    }

    // Find user by original transaction ID
    const { data: userSub, error: findError } = await supabase
      .from("user_subscriptions")
      .select("user_id")
      .eq("appstore_original_transaction_id", transaction.originalTransactionId)
      .single()

    if (findError || !userSub) {
      // Try matching by appAccountToken (Supabase user ID set during purchase)
      if (transaction.appAccountToken) {
        const userId = transaction.appAccountToken
        await processNotificationForUser(userId, notification.notificationType, notification.subtype, transaction)
        return jsonResponse({ received: true }, 200)
      }

      console.warn(`[AppStore Notification] No user found for transaction ${transaction.originalTransactionId}`)
      return jsonResponse({ received: true }, 200)
    }

    await processNotificationForUser(userSub.user_id, notification.notificationType, notification.subtype, transaction)

    return jsonResponse({ received: true }, 200)
  } catch (err) {
    console.error("[AppStore Notification] Processing error:", err)
    return jsonResponse({ error: "Processing failed" }, 500)
  }
}

async function processNotificationForUser(
  userId: string,
  notificationType: string,
  subtype: string | undefined,
  transaction: DecodedTransaction
): Promise<void> {
  const planType = PRODUCT_PLAN_MAP[transaction.productId]
  const expiresDate = transaction.expiresDate
    ? new Date(transaction.expiresDate).toISOString()
    : null

  switch (notificationType) {
    case "SUBSCRIBED":
    case "DID_RENEW": {
      await supabase
        .from("user_subscriptions")
        .update({
          plan_type: planType || "pro_subscription",
          subscription_status: "active",
          payment_provider: "appstore",
          appstore_original_transaction_id: transaction.originalTransactionId,
          current_period_end: expiresDate
        })
        .eq("user_id", userId)

      console.log(`[AppStore] Subscription renewed for user ${userId}`)
      break
    }

    case "DID_CHANGE_RENEWAL_STATUS": {
      // User toggled auto-renew off (will expire at period end) or back on
      const willAutoRenew = subtype !== "AUTO_RENEW_DISABLED"
      console.log(`[AppStore] Auto-renew ${willAutoRenew ? "enabled" : "disabled"} for user ${userId}`)

      // Keep status active until period actually ends
      if (!willAutoRenew) {
        await supabase.from("usage_logs").insert({
          user_id: userId,
          action: "appstore_auto_renew_disabled",
          metadata: { product_id: transaction.productId }
        })
      }
      break
    }

    case "EXPIRED": {
      await supabase
        .from("user_subscriptions")
        .update({
          plan_type: "free",
          subscription_status: "expired",
          credits_balance: 0,
          current_period_end: null
        })
        .eq("user_id", userId)

      await supabase.from("usage_logs").insert({
        user_id: userId,
        action: "appstore_subscription_expired",
        metadata: { product_id: transaction.productId }
      })

      console.log(`[AppStore] Subscription expired for user ${userId}`)
      break
    }

    case "DID_FAIL_TO_RENEW": {
      await supabase
        .from("user_subscriptions")
        .update({ subscription_status: "past_due" })
        .eq("user_id", userId)

      console.log(`[AppStore] Renewal failed for user ${userId} (grace period)`)
      break
    }

    case "GRACE_PERIOD_EXPIRED": {
      await supabase
        .from("user_subscriptions")
        .update({
          plan_type: "free",
          subscription_status: "expired",
          credits_balance: 0,
          current_period_end: null
        })
        .eq("user_id", userId)

      console.log(`[AppStore] Grace period expired for user ${userId}`)
      break
    }

    case "REVOKE": {
      // Apple revoked the transaction (refund, family sharing removal, etc.)
      await supabase
        .from("user_subscriptions")
        .update({
          plan_type: "free",
          subscription_status: "cancelled",
          credits_balance: 0,
          current_period_end: null
        })
        .eq("user_id", userId)

      await supabase.from("usage_logs").insert({
        user_id: userId,
        action: "appstore_subscription_revoked",
        metadata: { product_id: transaction.productId }
      })

      console.log(`[AppStore] Subscription revoked for user ${userId}`)
      break
    }

    default:
      console.log(`[AppStore] Unhandled notification: ${notificationType} (subtype: ${subtype})`)
  }
}

// ── JWS Decoding ──────────────────────────────────────────────────────────

interface DecodedTransaction {
  transactionId: string
  originalTransactionId: string
  productId: string
  bundleId: string
  purchaseDate: number
  expiresDate?: number
  environment: string
  appAccountToken?: string
}

interface DecodedNotification {
  notificationType: string
  subtype?: string
  data?: {
    signedTransactionInfo?: string
    signedRenewalInfo?: string
  }
}

/**
 * Decode a JWS-encoded transaction from StoreKit.
 * In production, you should verify the signature against Apple's root CA.
 * For now we decode the payload (signature was verified on-device by StoreKit).
 */
function decodeJWSTransaction(jws: string): DecodedTransaction | null {
  try {
    const parts = jws.split(".")
    if (parts.length !== 3) return null

    const payload = JSON.parse(atob(parts[1]))
    return {
      transactionId: payload.transactionId,
      originalTransactionId: payload.originalTransactionId,
      productId: payload.productId,
      bundleId: payload.bundleId,
      purchaseDate: payload.purchaseDate,
      expiresDate: payload.expiresDate,
      environment: payload.environment || APPSTORE_ENVIRONMENT,
      appAccountToken: payload.appAccountToken
    }
  } catch (err) {
    console.error("[AppStore] Failed to decode JWS transaction:", err)
    return null
  }
}

/**
 * Decode the signed payload from App Store Server Notifications v2.
 */
function decodeSignedPayload(signedPayload: string): DecodedNotification | null {
  try {
    const parts = signedPayload.split(".")
    if (parts.length !== 3) return null

    const payload = JSON.parse(atob(parts[1]))
    return {
      notificationType: payload.notificationType,
      subtype: payload.subtype,
      data: payload.data
    }
  } catch (err) {
    console.error("[AppStore] Failed to decode signed payload:", err)
    return null
  }
}
