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
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers })
  }

  try {
    // 1. Auth
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401)
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401)
    }

    const userId = user.id

    // 2. Get subscription
    const { data: subscription, error: subError } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (subError) {
      console.error(`[chat-proxy] Subscription not found for ${userId}`)
      return jsonResponse({ error: "Subscription not found" }, 403)
    }

    const plan = subscription.plan_type || "free"

    // 3. Enforce limits
    if (plan === "pro_subscription") {
      // Weekly reset check
      const lastReset = new Date(subscription.last_reset_at || 0)
      const now = new Date()
      const diffDays = (now.getTime() - lastReset.getTime()) / (1000 * 3600 * 24)

      if (diffDays > 7) {
        await supabase
          .from("user_subscriptions")
          .update({ usage_count: 0, last_reset_at: now.toISOString() })
          .eq("user_id", userId)
      } else if (subscription.usage_count >= 375) {
        return jsonResponse({ error: "Weekly limit reached (375 req/week)", code: "WEEKLY_LIMIT_REACHED" }, 429)
      }

      // Increment usage (RPC with fallback)
      const { error: rpcError } = await supabase.rpc("increment_usage", { user_id_input: userId })
      if (rpcError) {
        await supabase
          .from("user_subscriptions")
          .update({ usage_count: (subscription.usage_count || 0) + 1 })
          .eq("user_id", userId)
      }
    } else {
      // Free tier
      if ((subscription.credits_balance || 0) <= 0) {
        return jsonResponse({ error: "Trial credits exhausted", code: "CREDITS_EXHAUSTED" }, 402)
      }

      const { error: rpcError } = await supabase.rpc("deduct_credit", { user_id_input: userId })
      if (rpcError) {
        const { error: updateError } = await supabase
          .from("user_subscriptions")
          .update({ credits_balance: subscription.credits_balance - 1 })
          .eq("user_id", userId)

        if (updateError) {
          console.error("[chat-proxy] Credit deduction failed:", updateError)
          return jsonResponse({ error: "Database error" }, 500)
        }
      }
    }

    // 4. Parse request
    let body: { messages?: Array<{ role: string; content: string }>; context?: string }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400)
    }

    const { messages, context } = body
    if (!messages || !Array.isArray(messages)) {
      return jsonResponse({ error: "Messages array is required" }, 400)
    }

    // 5. OpenAI request
    const systemMessage = {
      role: "system" as const,
      content: `You are a helpful AI assistant. Context: ${context ? context.substring(0, 10000) : "No context"}`
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemMessage, ...messages],
      stream: true
    })

    // 6. Stream response
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content
            if (content) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`))
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch (error) {
          console.error("[chat-proxy] Stream error:", error)
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
    console.error("[chat-proxy] Error:", error)
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500
    )
  }
}
