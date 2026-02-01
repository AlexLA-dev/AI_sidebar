import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"
import OpenAI from "openai"
import { Resend } from "resend"

// Environment variables (set in Netlify dashboard)
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const RESEND_API_KEY = process.env.RESEND_API_KEY || ""
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "top10resource@gmail.com"

// Constants
const PRO_MODEL = "gpt-4o-mini"
const PRO_MAX_TOKENS = 2048
const WEEKLY_LIMIT = 375
const ALERT_THRESHOLD = 300 // 80% of 375
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

type PlanType = "free" | "byok_license" | "pro_subscription"

interface UserSubscription {
  user_id: string
  plan_type: PlanType
  credits_balance: number
  subscription_status: string
  usage_count: number
  last_reset_at: string | null
}

interface ChatRequest {
  messages: Array<{
    role: "user" | "assistant" | "system"
    content: string
  }>
  model?: string
  max_tokens?: number
}

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

// Send admin alert email (fire-and-forget)
async function sendAdminAlert(userId: string, usageCount: number): Promise<void> {
  if (!resend) {
    console.warn("RESEND_API_KEY not configured, skipping admin alert")
    return
  }

  try {
    await resend.emails.send({
      from: "ContextFlow <alerts@contextflow.app>",
      to: [ADMIN_EMAIL],
      subject: `⚠️ High Usage Alert: User ${userId.slice(0, 8)}...`,
      text: [
        `User ${userId} has used ${usageCount}/${WEEKLY_LIMIT} requests this week.`,
        `This is ${Math.round((usageCount / WEEKLY_LIMIT) * 100)}% of their weekly limit.`,
        "",
        `Timestamp: ${new Date().toISOString()}`
      ].join("\n")
    })
    console.log(`Admin alert sent for user ${userId}`)
  } catch (err) {
    // Never block a request because email failed
    console.error("Failed to send admin alert:", err)
  }
}

// Check and reset weekly usage if needed
async function checkWeeklyReset(
  subscription: UserSubscription,
  userId: string
): Promise<{ usageCount: number; wasReset: boolean }> {
  const lastReset = subscription.last_reset_at
    ? new Date(subscription.last_reset_at).getTime()
    : 0
  const now = Date.now()

  if (now - lastReset > WEEK_MS) {
    // Reset usage counter
    const { error } = await supabase
      .from("user_subscriptions")
      .update({ usage_count: 0, last_reset_at: new Date().toISOString() })
      .eq("user_id", userId)

    if (error) {
      console.error("Failed to reset weekly usage:", error)
      // Continue with current count on error
      return { usageCount: subscription.usage_count || 0, wasReset: false }
    }

    return { usageCount: 0, wasReset: true }
  }

  return { usageCount: subscription.usage_count || 0, wasReset: false }
}

export default async function handler(req: Request, _context: Context) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  try {
    // Extract and verify JWT token
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid authorization header" }, 401)
    }

    const token = authHeader.replace("Bearer ", "")

    // Verify user with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return jsonResponse({ error: "Invalid or expired token" }, 401)
    }

    // Get user subscription
    const { data: subscription, error: subError } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .single()

    if (subError || !subscription) {
      // Create default subscription if not exists
      const { data: newSub, error: createError } = await supabase
        .from("user_subscriptions")
        .insert({
          user_id: user.id,
          plan_type: "free",
          credits_balance: 5,
          usage_count: 0,
          last_reset_at: new Date().toISOString()
        })
        .select()
        .single()

      if (createError) {
        return jsonResponse({ error: "Failed to create user subscription" }, 500)
      }

      return handleChatRequest(req, newSub as UserSubscription, user.id)
    }

    return handleChatRequest(req, subscription as UserSubscription, user.id)
  } catch (error) {
    console.error("Chat proxy error:", error)
    return jsonResponse({ error: "Internal server error" }, 500)
  }
}

async function handleChatRequest(
  req: Request,
  subscription: UserSubscription,
  userId: string
): Promise<Response> {
  const { plan_type, credits_balance, subscription_status } = subscription
  console.log(`[chat-proxy] User ${userId}: plan_type=${plan_type}, status=${subscription_status}, credits=${credits_balance}, usage_count=${subscription.usage_count}`)

  // === BYOK users should call OpenAI directly ===
  if (plan_type === "byok_license") {
    return jsonResponse(
      { error: "BYOK users should use their own API key", code: "USE_OWN_KEY" },
      403
    )
  }

  // === Pro Subscription: weekly limit enforcement ===
  if (plan_type === "pro_subscription") {
    if (subscription_status !== "active") {
      return jsonResponse(
        { error: "Subscription is not active", code: "SUBSCRIPTION_INACTIVE", status: subscription_status },
        403
      )
    }

    // Check weekly reset
    const { usageCount, wasReset } = await checkWeeklyReset(subscription, userId)
    console.log(`[Pro] User ${userId}: usage=${usageCount}, wasReset=${wasReset}, last_reset_at=${subscription.last_reset_at}`)

    // Check weekly limit
    if (usageCount >= WEEKLY_LIMIT) {
      return jsonResponse(
        {
          error: "Weekly request limit reached (375/week). Resets every 7 days.",
          code: "WEEKLY_LIMIT_REACHED",
          usage_count: usageCount,
          limit: WEEKLY_LIMIT
        },
        429
      )
    }

    // Increment usage count
    const newUsageCount = usageCount + 1
    const { error: incError, data: incData } = await supabase
      .from("user_subscriptions")
      .update({ usage_count: newUsageCount })
      .eq("user_id", userId)
      .select("usage_count")

    if (incError) {
      console.error(`[Pro] Failed to increment usage for ${userId}:`, incError)
    } else {
      console.log(`[Pro] User ${userId}: usage_count updated to ${newUsageCount}, DB returned:`, incData)
    }

    // Send admin alert at threshold (fire-and-forget, don't await)
    if (newUsageCount === ALERT_THRESHOLD) {
      sendAdminAlert(userId, newUsageCount)
    }
  }

  // === Free tier: credits-based ===
  if (plan_type === "free") {
    if (credits_balance <= 0) {
      return jsonResponse(
        { error: "Trial credits exhausted", code: "CREDITS_EXHAUSTED", credits_remaining: 0 },
        403
      )
    }

    // Decrement credits before processing
    const { error: updateError } = await supabase
      .from("user_subscriptions")
      .update({ credits_balance: credits_balance - 1 })
      .eq("user_id", userId)

    if (updateError) {
      console.error("Failed to decrement credits:", updateError)
    }
  }

  // === Parse request body ===
  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  const { messages } = body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: "Messages array is required" }, 400)
  }

  // Enforce model and max_tokens for all proxy requests
  const model = PRO_MODEL
  const max_tokens = PRO_MAX_TOKENS

  try {
    // Create streaming response
    const stream = await openai.chat.completions.create({
      model,
      messages,
      max_tokens,
      stream: true
    })

    // Create a ReadableStream to pipe the OpenAI response
    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()

        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content
            if (content) {
              const data = JSON.stringify({ content })
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            }
          }

          // Send done signal
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch (error) {
          console.error("Streaming error:", error)
          controller.error(error)
        }
      }
    })

    // Log usage (async, don't wait)
    supabase
      .from("usage_logs")
      .insert({
        user_id: userId,
        action: "chat_request",
        metadata: { model, messages_count: messages.length, plan_type }
      })
      .then(() => {})
      .catch(console.error)

    return new Response(readableStream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    })
  } catch (error) {
    console.error("OpenAI API error:", error)

    // If we decremented credits for free user, restore them on error
    if (plan_type === "free") {
      await supabase
        .from("user_subscriptions")
        .update({ credits_balance: credits_balance })
        .eq("user_id", userId)
    }

    // If we incremented usage for pro user, restore on error
    if (plan_type === "pro_subscription") {
      await supabase
        .from("user_subscriptions")
        .update({ usage_count: (subscription.usage_count || 0) })
        .eq("user_id", userId)
    }

    return jsonResponse(
      { error: error instanceof Error ? error.message : "Failed to process chat request" },
      500
    )
  }
}
