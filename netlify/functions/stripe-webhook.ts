import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"
import Stripe from "stripe"

// Environment variables
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Initialize clients
const stripe = new Stripe(STRIPE_SECRET_KEY)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Product IDs mapped to plan types (configure these in Stripe)
const PRODUCT_PLAN_MAP: Record<string, "byok_license" | "pro_subscription"> = {
  // Set your Stripe Product IDs here
  // "prod_xxx": "byok_license",
  // "prod_yyy": "pro_subscription",
}

export default async function handler(req: Request, context: Context) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  const signature = req.headers.get("stripe-signature")
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 })
  }

  let event: Stripe.Event

  try {
    const body = await req.text()
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error("Webhook signature verification failed:", err)
    return new Response(
      `Webhook Error: ${err instanceof Error ? err.message : "Unknown error"}`,
      { status: 400 }
    )
  }

  console.log(`Received Stripe event: ${event.type}`)

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break

      case "invoice.payment_succeeded":
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice)
        break

      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  } catch (error) {
    console.error("Error processing webhook:", error)
    return new Response(
      JSON.stringify({ error: "Webhook processing failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  console.log("Processing checkout.session.completed:", session.id)

  // client_reference_id should be the Supabase User ID
  const userId = session.client_reference_id
  if (!userId) {
    console.error("No client_reference_id in checkout session")
    return
  }

  const customerId = session.customer as string
  const subscriptionId = session.subscription as string | undefined

  // Determine plan type from metadata or line items
  let planType: "byok_license" | "pro_subscription" = "byok_license"

  if (session.metadata?.plan_type) {
    planType = session.metadata.plan_type as typeof planType
  } else if (session.mode === "subscription") {
    planType = "pro_subscription"
  }

  // Get subscription details if it's a subscription
  let currentPeriodEnd: Date | null = null
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      currentPeriodEnd = new Date(subscription.current_period_end * 1000)
    } catch (error) {
      console.error("Failed to retrieve subscription:", error)
    }
  }

  // Update user subscription in Supabase
  const { error } = await supabase
    .from("user_subscriptions")
    .upsert({
      user_id: userId,
      plan_type: planType,
      subscription_status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId || null,
      current_period_end: currentPeriodEnd?.toISOString() || null,
      credits_balance: planType === "byok_license" ? -1 : null // -1 = unlimited for BYOK
    })

  if (error) {
    console.error("Failed to update user subscription:", error)
    throw error
  }

  console.log(`Updated subscription for user ${userId}: ${planType}`)

  // Log the event
  await supabase.from("usage_logs").insert({
    user_id: userId,
    action: "subscription_created",
    metadata: {
      plan_type: planType,
      stripe_session_id: session.id,
      stripe_customer_id: customerId
    }
  })
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  console.log("Processing subscription update:", subscription.id)

  const customerId = subscription.customer as string

  // Find user by Stripe customer ID
  const { data: userSub, error: findError } = await supabase
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .single()

  if (findError || !userSub) {
    console.error("Could not find user for customer:", customerId)
    return
  }

  // Map Stripe status to our status
  const statusMap: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    unpaid: "past_due",
    trialing: "active"
  }

  const status = statusMap[subscription.status] || subscription.status
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000)

  const { error: updateError } = await supabase
    .from("user_subscriptions")
    .update({
      subscription_status: status,
      stripe_subscription_id: subscription.id,
      current_period_end: currentPeriodEnd.toISOString()
    })
    .eq("user_id", userSub.user_id)

  if (updateError) {
    console.error("Failed to update subscription:", updateError)
    throw updateError
  }

  console.log(`Updated subscription status for user ${userSub.user_id}: ${status}`)
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  console.log("Processing subscription deletion:", subscription.id)

  const customerId = subscription.customer as string

  // Find user by Stripe customer ID
  const { data: userSub, error: findError } = await supabase
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .single()

  if (findError || !userSub) {
    console.error("Could not find user for customer:", customerId)
    return
  }

  // Downgrade to free tier with 0 credits (trial used)
  const { error: updateError } = await supabase
    .from("user_subscriptions")
    .update({
      plan_type: "free",
      subscription_status: "cancelled",
      credits_balance: 0,
      stripe_subscription_id: null,
      current_period_end: null
    })
    .eq("user_id", userSub.user_id)

  if (updateError) {
    console.error("Failed to update subscription:", updateError)
    throw updateError
  }

  // Log the cancellation
  await supabase.from("usage_logs").insert({
    user_id: userSub.user_id,
    action: "subscription_cancelled",
    metadata: { stripe_subscription_id: subscription.id }
  })

  console.log(`Subscription cancelled for user ${userSub.user_id}`)
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  console.log("Payment succeeded for invoice:", invoice.id)

  const customerId = invoice.customer as string
  const subscriptionId = invoice.subscription as string | undefined

  if (!subscriptionId) {
    // One-time payment, not a subscription renewal
    return
  }

  // Find user and update status to active
  const { data: userSub, error: findError } = await supabase
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .single()

  if (findError || !userSub) {
    console.error("Could not find user for customer:", customerId)
    return
  }

  // Get updated subscription period
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000)

  const { error: updateError } = await supabase
    .from("user_subscriptions")
    .update({
      subscription_status: "active",
      current_period_end: currentPeriodEnd.toISOString()
    })
    .eq("user_id", userSub.user_id)

  if (updateError) {
    console.error("Failed to update subscription:", updateError)
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  console.log("Payment failed for invoice:", invoice.id)

  const customerId = invoice.customer as string

  // Find user and update status
  const { data: userSub, error: findError } = await supabase
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .single()

  if (findError || !userSub) {
    console.error("Could not find user for customer:", customerId)
    return
  }

  const { error: updateError } = await supabase
    .from("user_subscriptions")
    .update({ subscription_status: "past_due" })
    .eq("user_id", userSub.user_id)

  if (updateError) {
    console.error("Failed to update subscription:", updateError)
  }

  // Log the failure
  await supabase.from("usage_logs").insert({
    user_id: userSub.user_id,
    action: "payment_failed",
    metadata: { stripe_invoice_id: invoice.id }
  })

  console.log(`Payment failed for user ${userSub.user_id}`)
}
