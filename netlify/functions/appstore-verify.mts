import type { Context } from "@netlify/functions"

import { decodeTransaction, JwsError, verifyAppleJws, type AppleTransaction } from "../shared/apple.mts"
import { config } from "../shared/config.mts"
import { logEvent, upsertEntitlement } from "../shared/db.mts"
import { json, preflight, readJson } from "../shared/http.mts"

/**
 * /.netlify/functions/appstore-verify (URL registered in App Store Connect)
 *
 * 1. App Store Server Notifications V2 from Apple: { signedPayload } — keeps
 *    renewals, refunds and revocations in contextflow.entitlements.
 * 2. Legacy container app (build <= 40) after a purchase: { jwsTransaction, userId }.
 */
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const body = await readJson(req, 500_000)
  if (!body) return json({ error: "Invalid JSON body" }, 400)

  if (typeof body.signedPayload === "string") return handleNotification(body.signedPayload)
  if (typeof body.jwsTransaction === "string") return handleClientTransaction(body.jwsTransaction)
  return json({ error: "Missing signedPayload or jwsTransaction" }, 400)
}

interface NotificationPayload {
  notificationType: string
  subtype?: string
  notificationUUID?: string
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string }
}

async function handleNotification(signedPayload: string): Promise<Response> {
  let notification: NotificationPayload
  try {
    notification = verifyAppleJws<NotificationPayload>(signedPayload)
  } catch (err) {
    console.warn("[appstore] rejected notification:", err instanceof Error ? err.message : err)
    return json({ error: "Invalid signature" }, 400)
  }

  const { notificationType: type, subtype, data } = notification
  if (data?.bundleId && data.bundleId !== config.appStoreBundleId) return json({ received: true, ignored: "bundle" })
  if (!data?.signedTransactionInfo) {
    await logEvent("appstore_notification", null, { type, subtype, uuid: notification.notificationUUID })
    return json({ received: true })
  }

  let tx: AppleTransaction
  try {
    tx = decodeTransaction(data.signedTransactionInfo)
  } catch (err) {
    console.warn("[appstore] bad transaction in notification:", err instanceof Error ? err.message : err)
    return json({ received: true, ignored: err instanceof JwsError ? err.message : "invalid" })
  }

  const revoked = type === "REFUND" || type === "REVOKE"
  const revokedAt = revoked ? new Date(tx.revocationDate ?? Date.now()).toISOString() : null
  await upsertEntitlement({
    original_transaction_id: String(tx.originalTransactionId),
    product_id: tx.productId,
    environment: tx.environment,
    expires_at: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
    revoked_at: revokedAt,
    app_account_token: tx.appAccountToken ?? null,
    last_transaction_id: String(tx.transactionId),
    last_notification: subtype ? `${type}:${subtype}` : type
  })
  await logEvent("appstore_notification", null, {
    type, subtype, product: tx.productId, environment: tx.environment, uuid: notification.notificationUUID
  })
  return json({ received: true })
}

async function handleClientTransaction(jws: string): Promise<Response> {
  let tx: AppleTransaction
  try {
    tx = decodeTransaction(jws)
  } catch (err) {
    return json({ error: "Invalid transaction", reason: err instanceof Error ? err.message : "invalid" }, 400)
  }
  await upsertEntitlement({
    original_transaction_id: String(tx.originalTransactionId),
    product_id: tx.productId,
    environment: tx.environment,
    expires_at: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
    app_account_token: tx.appAccountToken ?? null,
    last_transaction_id: String(tx.transactionId)
  })
  await logEvent("appstore_client_tx", null, { product: tx.productId, environment: tx.environment })
  const planType = tx.productId.includes("byok") ? "byok_license" : "pro_subscription"
  return json({ success: true, plan_type: planType })
}
