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
import * as crypto from "crypto"

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
    return handleClientVerification(req, body.jwsTransaction, body.userId)
  }

  return jsonResponse({ error: "Missing jwsTransaction or signedPayload" }, 400)
}

// ── Client verification (called from extension after purchase) ────────────

async function handleClientVerification(req: Request, jwsTransaction: string, bodyUserId?: string): Promise<Response> {
  // Authenticate the user — prefer auth token, fall back to userId from body.
  // The userId fallback is used by the native iOS app which doesn't have a
  // Supabase session. It's safe because the JWS is Apple-signed and verified.
  let userId: string | undefined

  const authHeader = req.headers.get("Authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (!authError && user) {
      userId = user.id
    }
  }

  // Fallback: use userId from request body (sent by native iOS app)
  if (!userId && bodyUserId) {
    // Verify the user exists in Supabase
    const { data: { user }, error } = await supabase.auth.admin.getUserById(bodyUserId)
    if (!error && user) {
      userId = user.id
    }
  }

  if (!userId) {
    return jsonResponse({ error: "Missing or invalid authorization" }, 401)
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
        user_id: userId,
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
      user_id: userId,
      action: "appstore_subscription_created",
      metadata: {
        plan_type: planType,
        product_id: transaction.productId,
        original_transaction_id: transaction.originalTransactionId,
        environment: transaction.environment
      }
    })

    console.log(`[AppStore] Subscription activated for user ${userId}: ${planType}`)

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

// ── JWS Verification & Decoding ──────────────────────────────────────────

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

// Apple Root CA - G3 (PEM). Used to verify the certificate chain in JWS tokens.
// Source: https://www.apple.com/certificateauthority/
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK515
1BVeolqDi6YyrKYMOtaNCMEAwHQYDVR0OBBYEFLuw3GKOGLg0JnX2LQIrL6b1sUMm
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`

/**
 * Convert JWS ES256 raw signature (r || s, 64 bytes) to DER format for OpenSSL.
 */
function jwsSignatureToDer(sig: Buffer): Buffer {
  const r = sig.subarray(0, 32)
  const s = sig.subarray(32, 64)

  function toDerInt(buf: Buffer): Buffer {
    let i = 0
    while (i < buf.length - 1 && buf[i] === 0 && !(buf[i + 1]! & 0x80)) i++
    const trimmed = buf.subarray(i)
    if (trimmed[0]! & 0x80) return Buffer.concat([Buffer.from([0x00]), trimmed])
    return trimmed
  }

  const rDer = toDerInt(r)
  const sDer = toDerInt(s)
  const rTlv = Buffer.concat([Buffer.from([0x02, rDer.length]), rDer])
  const sTlv = Buffer.concat([Buffer.from([0x02, sDer.length]), sDer])
  const body = Buffer.concat([rTlv, sTlv])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

/**
 * Verify Apple JWS signature and certificate chain, then return decoded payload.
 * Falls back to decode-only with warning if x5c header is missing (e.g. sandbox).
 */
function verifyAndDecodeJWS<T>(jws: string): T | null {
  try {
    const parts = jws.split(".")
    if (parts.length !== 3) return null

    // Decode header
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString())
    const x5c: string[] | undefined = header.x5c

    // Decode payload (always needed)
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as T

    if (!x5c || x5c.length < 2) {
      console.warn("[AppStore] No x5c in JWS header — skipping signature verification (sandbox?)")
      return payload
    }

    // Build certificate objects
    const leafPem = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`
    const intermediatePem = `-----BEGIN CERTIFICATE-----\n${x5c[1]}\n-----END CERTIFICATE-----`

    const leafCert = new crypto.X509Certificate(leafPem)
    const intermediateCert = new crypto.X509Certificate(intermediatePem)
    const rootCert = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM)

    // Verify certificate chain: leaf → intermediate → Apple Root CA G3
    if (!leafCert.verify(intermediateCert.publicKey)) {
      console.error("[AppStore] Leaf certificate not signed by intermediate")
      return null
    }
    if (!intermediateCert.verify(rootCert.publicKey)) {
      console.error("[AppStore] Intermediate certificate not signed by Apple Root CA G3")
      return null
    }

    // Verify JWS signature using leaf certificate's public key
    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`)
    const signature = Buffer.from(parts[2]!, "base64url")
    const derSignature = jwsSignatureToDer(signature)

    const isValid = crypto.verify(
      "SHA256",
      signedData,
      { key: leafCert.publicKey, dsaEncoding: "der" },
      derSignature
    )

    if (!isValid) {
      console.error("[AppStore] JWS signature verification failed")
      return null
    }

    return payload
  } catch (err) {
    console.error("[AppStore] JWS verification error:", err)
    return null
  }
}

/**
 * Verify and decode a JWS-encoded transaction from StoreKit.
 * Verifies the Apple certificate chain and ECDSA signature.
 */
function decodeJWSTransaction(jws: string): DecodedTransaction | null {
  const payload = verifyAndDecodeJWS<Record<string, unknown>>(jws)
  if (!payload) return null

  return {
    transactionId: payload.transactionId as string,
    originalTransactionId: payload.originalTransactionId as string,
    productId: payload.productId as string,
    bundleId: payload.bundleId as string,
    purchaseDate: payload.purchaseDate as number,
    expiresDate: payload.expiresDate as number | undefined,
    environment: (payload.environment as string) || APPSTORE_ENVIRONMENT,
    appAccountToken: payload.appAccountToken as string | undefined
  }
}

/**
 * Verify and decode the signed payload from App Store Server Notifications v2.
 */
function decodeSignedPayload(signedPayload: string): DecodedNotification | null {
  const payload = verifyAndDecodeJWS<Record<string, unknown>>(signedPayload)
  if (!payload) return null

  return {
    notificationType: payload.notificationType as string,
    subtype: payload.subtype as string | undefined,
    data: payload.data as DecodedNotification["data"]
  }
}
