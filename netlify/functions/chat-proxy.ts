import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"
import OpenAI from "openai"

// Initialize clients outside handler for reuse
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// CORS headers
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
}

function jsonResponse(body: object | string, status: number): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  })
}

export default async function handler(req: Request, _context: Context) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers })
  }

  try {
    // 1. Get User ID from Authorization header
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      console.error("[Proxy] Missing Authorization header")
      return jsonResponse("Missing Authorization header", 401)
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      console.error("[Proxy] Auth Error:", authError)
      return jsonResponse("Unauthorized", 401)
    }

    const userId = user.id
    console.log(`[Proxy] User identified: ${userId}`)

    // 2. Get subscription (Admin query - bypasses RLS)
    const { data: subscription, error: subError } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (subError) {
      console.error(`[Proxy] Subscription error for ${userId}:`, subError)
      return jsonResponse("Subscription not found", 403)
    }

    // 3. Limit logic
    const plan = subscription.plan_type || "free"
    console.log(`[Proxy] Plan: ${plan}, Usage: ${subscription.usage_count}, Credits: ${subscription.credits_balance}`)

    // --- PRO LOGIC ---
    if (plan === "pro_subscription") {
      // Check weekly reset
      const lastReset = new Date(subscription.last_reset_at || 0)
      const now = new Date()
      const diffDays = (now.getTime() - lastReset.getTime()) / (1000 * 3600 * 24)

      if (diffDays > 7) {
        console.log(`[Proxy] Resetting weekly limit for ${userId}`)
        const { error: resetError } = await supabase
          .from("user_subscriptions")
          .update({
            usage_count: 0,
            last_reset_at: now.toISOString()
          })
          .eq("user_id", userId)

        if (resetError) {
          console.error(`[Proxy] Reset error:`, resetError)
        } else {
          console.log(`[Proxy] Weekly reset successful for ${userId}`)
        }
      } else if (subscription.usage_count >= 375) {
        console.log(`[Proxy] Weekly limit reached for ${userId}`)
        return jsonResponse({ error: "Weekly limit reached (375 req/week)", code: "WEEKLY_LIMIT_REACHED" }, 429)
      }

      // Atomic increment via RPC
      console.log(`[Proxy] Calling increment_usage for ${userId}...`)
      const { data: newCount, error: rpcError } = await supabase.rpc("increment_usage", {
        user_id_input: userId
      })

      if (rpcError) {
        console.error("[Proxy] RPC Error (Pro):", rpcError)
        // Fallback: direct update
        console.log(`[Proxy] Trying direct update fallback...`)
        const { error: updateError } = await supabase
          .from("user_subscriptions")
          .update({ usage_count: (subscription.usage_count || 0) + 1 })
          .eq("user_id", userId)

        if (updateError) {
          console.error("[Proxy] Fallback update also failed:", updateError)
        } else {
          console.log(`[Proxy] Fallback update succeeded`)
        }
      } else {
        console.log(`[Proxy] increment_usage returned: ${newCount}`)
      }
    }

    // --- FREE/TRIAL LOGIC ---
    else {
      if ((subscription.credits_balance || 0) <= 0) {
        console.log(`[Proxy] Credits exhausted for ${userId}`)
        return jsonResponse({ error: "Trial credits exhausted", code: "CREDITS_EXHAUSTED" }, 402)
      }

      // Atomic deduction via RPC
      console.log(`[Proxy] Calling deduct_credit for ${userId}...`)
      const { data: remaining, error: rpcError } = await supabase.rpc("deduct_credit", {
        user_id_input: userId
      })

      if (rpcError) {
        console.error("[Proxy] RPC Error (Free):", rpcError)
        // Fallback: direct update
        console.log(`[Proxy] Trying direct update fallback...`)
        const { error: updateError } = await supabase
          .from("user_subscriptions")
          .update({ credits_balance: subscription.credits_balance - 1 })
          .eq("user_id", userId)

        if (updateError) {
          console.error("[Proxy] Fallback update also failed:", updateError)
          return jsonResponse("Database error during credit deduction", 500)
        } else {
          console.log(`[Proxy] Fallback update succeeded`)
        }
      } else {
        console.log(`[Proxy] deduct_credit returned: ${remaining}`)
      }
    }

    // 4. Parse request body
    let body: { messages?: Array<{ role: string; content: string }>; context?: string }
    try {
      body = await req.json()
    } catch {
      return jsonResponse("Invalid JSON body", 400)
    }

    const { messages, context } = body
    if (!messages || !Array.isArray(messages)) {
      return jsonResponse("Messages array is required", 400)
    }

    // 5. OpenAI request (GPT-4o-mini)
    const systemMessage = {
      role: "system" as const,
      content: `You are a helpful AI assistant. Context: ${context ? context.substring(0, 10000) : "No context"}`
    }

    console.log(`[Proxy] Calling OpenAI for ${userId} with ${messages.length} messages...`)

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemMessage, ...messages],
      stream: true
    })

    // 6. Stream response (SSE format for client compatibility)
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content
            if (content) {
              // SSE format: data: {"content": "..."}\n\n
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content })}\n\n`)
              )
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
          console.log(`[Proxy] Stream completed for ${userId}`)
        } catch (error) {
          console.error("[Proxy] Stream error:", error)
          controller.error(error)
        }
      }
    })

    return new Response(readable, {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    })
  } catch (error) {
    console.error("[Proxy] Fatal Error:", error)
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500
    )
  }
}
