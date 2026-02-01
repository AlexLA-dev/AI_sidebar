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

// Initialize clients — db.auth.admin bypasses RLS
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})
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
    const { error } = await supabase
      .from("user_subscriptions")
      .update({ usage_count: 0, last_reset_at: new Date().toISOString() })
      .eq("user_id", userId)

    if (error) {
      console.error("Failed to reset weekly usage:", error)
      return { usageCount: subscription.usage_count || 0, wasReset: false }
    }

    console.log(`[Pro] Weekly reset for user ${userId}`)
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
        console.error("Failed to create subscription:", createError)
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
  console.log(`[chat-proxy] User ${userId}: plan=${plan_type}, status=${subscription_status}, credits=${credits_balance}, usage=${subscription.usage_count}`)

  // Collect debug info to send in SSE stream
  const debug: Record<string, unknown> = {
    plan_type,
    subscription_status,
    credits_balance_before: credits_balance,
    usage_count_before: subscription.usage_count,
    user_id_short: userId.slice(0, 8)
  }

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
    console.log(`[Pro] User ${userId}: usage=${usageCount}, wasReset=${wasReset}`)

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

    // Increment usage count BEFORE processing (optimistic)
    const newUsageCount = usageCount + 1
    const { data: updatedRows, error: incError } = await supabase
      .from("user_subscriptions")
      .update({ usage_count: newUsageCount })
      .eq("user_id", userId)
      .select("usage_count")

    debug.pro_update_target = newUsageCount
    debug.pro_update_error = incError ? JSON.stringify(incError) : null
    debug.pro_update_returned = updatedRows

    // Send admin alert at threshold
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

    const newCredits = credits_balance - 1
    const { data: updatedCredits, error: updateError } = await supabase
      .from("user_subscriptions")
      .update({ credits_balance: newCredits })
      .eq("user_id", userId)
      .select("credits_balance")

    debug.free_update_target = newCredits
    debug.free_update_error = updateError ? JSON.stringify(updateError) : null
    debug.free_update_returned = updatedCredits
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

  // Enforce model and max_tokens
  const model = PRO_MODEL
  const max_tokens = PRO_MAX_TOKENS

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages,
      max_tokens,
      stream: true,
      stream_options: { include_usage: true }
    })

    // Track token usage from stream
    let totalTokens = 0

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

            // Capture usage from final chunk
            if (chunk.usage) {
              totalTokens = chunk.usage.total_tokens || 0
            }
          }

          // Send debug info as SSE event (client ignores non-content fields)
          debug.tokens_used = totalTokens || null
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ debug })}\n\n`))

          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()

          // Log usage with token count (fire-and-forget)
          supabase
            .from("usage_logs")
            .insert({
              user_id: userId,
              action: "chat_request",
              tokens_used: totalTokens || null,
              metadata: { model, messages_count: messages.length, plan_type, debug }
            })
            .then(({ error }) => {
              if (error) console.error("Failed to log usage:", error)
            })
        } catch (error) {
          console.error("Streaming error:", error)
          controller.error(error)
        }
      }
    })

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

    // Rollback on error
    if (plan_type === "free") {
      await supabase
        .from("user_subscriptions")
        .update({ credits_balance: credits_balance })
        .eq("user_id", userId)
    }

    if (plan_type === "pro_subscription") {
      await supabase
        .from("user_subscriptions")
        .update({ usage_count: subscription.usage_count || 0 })
        .eq("user_id", userId)
    }

    return jsonResponse(
      { error: error instanceof Error ? error.message : "Failed to process chat request" },
      500
    )
  }
}
