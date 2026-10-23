import { createHmac, timingSafeEqual } from "node:crypto"

import type { Context } from "@netlify/functions"

import { logEvent } from "../shared/db.mts"
import { json } from "../shared/http.mts"

/**
 * /.netlify/functions/stripe-webhook
 *
 * ContextFlow is sold through the App Store only; Stripe checkout is no longer
 * offered. The endpoint stays so that any remaining Stripe events (renewals or
 * cancellations of old web subscriptions) are acknowledged and recorded in
 * contextflow.events instead of failing and being retried for days.
 */
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? ""
  const payload = await req.text()
  const header = req.headers.get("stripe-signature") ?? ""

  if (!secret || !verifyStripeSignature(payload, header, secret)) {
    return json({ error: "Invalid signature" }, 400)
  }

  let event: { id?: string; type?: string; livemode?: boolean; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return json({ error: "Invalid JSON" }, 400)
  }
  const object = event.data?.object ?? {}
  await logEvent("stripe", null, {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    object_id: object.id,
    status: object.status,
    customer: object.customer
  })
  return json({ received: true })
}

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]))
  const timestamp = Number(parts.t)
  const signatures = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3))
  if (!timestamp || signatures.length === 0) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest()
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
