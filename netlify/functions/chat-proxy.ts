import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"
import OpenAI from "openai"

// Environment variables (set in Netlify dashboard)
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!

// Constants
const PRO_MODEL = "gpt-4o-mini"
const PRO_MAX_TOKENS = 2048
const WEEKLY_LIMIT = 375
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Initialize Supabase with service role key (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

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

interface ChatRequest {
  messages: Array<{
    role: "user" | "assistant" | "system"
    content: string
  }>
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
    // ── Step 1: Auth ──────────────────────────────────────────
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid authorization header" }, 401)
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return jsonResponse({ error: "Invalid or expired token" }, 401)
    }

    // ── Step 2: Fetch subscription ────────────────────────────
    let { data: sub, error: subError } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .single()

    if (subError || !sub) {
      // Auto-create for new users
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

      if (createError || !newSub) {
        console.error("Failed to create subscription:", createError)
        return jsonResponse({ error: "Failed to initialize user" }, 500)
      }
      sub = newSub
    }

    const planType = sub.plan_type as string
    console.log(`[chat-proxy] User ${user.id}: plan=${planType}, credits=${sub.credits_balance}, usage=${sub.usage_count}`)

    // ── Step 3: Enforce limits & update DB (BEFORE OpenAI call) ──

    if (planType === "byok_license") {
      return jsonResponse(
        { error: "BYOK users should use their own API key", code: "USE_OWN_KEY" },
        403
      )
    }

    if (planType === "pro_subscription") {
      if (sub.subscription_status !== "active") {
        return jsonResponse(
          { error: "Subscription is not active", code: "SUBSCRIPTION_INACTIVE" },
          403
        )
      }

      // Weekly reset check
      const lastReset = sub.last_reset_at
        ? new Date(sub.last_reset_at).getTime()
        : 0

      if (Date.now() - lastReset > WEEK_MS) {
        const { error: resetErr } = await supabase.rpc("reset_weekly_usage", {
          user_id_input: user.id
        })
        if (resetErr) {
          console.error("Weekly reset failed:", resetErr)
        } else {
          console.log(`[Pro] Weekly reset for user ${user.id}`)
          sub.usage_count = 0
        }
      }

      // Check limit
      if ((sub.usage_count || 0) >= WEEKLY_LIMIT) {
        return jsonResponse(
          {
            error: "Weekly request limit reached (375/week). Resets every 7 days.",
            code: "WEEKLY_LIMIT_REACHED",
            usage_count: sub.usage_count,
            limit: WEEKLY_LIMIT
          },
          429
        )
      }

      // Atomic increment via RPC
      const { data: newCount, error: incErr } = await supabase.rpc("increment_usage", {
        user_id_input: user.id
      })

      if (incErr) {
        console.error("increment_usage RPC failed:", incErr)
        return jsonResponse({ error: "Failed to track usage" }, 500)
      }

      console.log(`[Pro] User ${user.id}: usage_count is now ${newCount}`)
    }

    if (planType === "free") {
      if ((sub.credits_balance || 0) <= 0) {
        return jsonResponse(
          { error: "Trial credits exhausted", code: "CREDITS_EXHAUSTED", credits_remaining: 0 },
          403
        )
      }

      // Atomic deduct via RPC
      const { data: remaining, error: deductErr } = await supabase.rpc("deduct_credit", {
        user_id_input: user.id
      })

      if (deductErr) {
        console.error("deduct_credit RPC failed:", deductErr)
        return jsonResponse({ error: "Failed to track usage" }, 500)
      }

      // -1 means no row was updated (credits were already 0, race condition)
      if (remaining === -1) {
        return jsonResponse(
          { error: "Trial credits exhausted", code: "CREDITS_EXHAUSTED", credits_remaining: 0 },
          403
        )
      }

      console.log(`[Free] User ${user.id}: credits_balance is now ${remaining}`)
    }

    // ── Step 4: Parse request body ────────────────────────────
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

    // ── Step 5: Call OpenAI (ONLY after DB update succeeded) ──
    // Note: tokens_used tracking is skipped for now because it requires
    // parsing the final stream chunk, which complicates the proxy.
    // usage_count / credits_balance are the primary economic safeguards.

    const stream = await openai.chat.completions.create({
      model: PRO_MODEL,
      messages,
      max_tokens: PRO_MAX_TOKENS,
      stream: true
    })

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()

        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content
            if (content) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content })}\n\n`)
              )
            }
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
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
        Connection: "keep-alive"
      }
    })
  } catch (error) {
    console.error("Chat proxy error:", error)
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500
    )
  }
}
