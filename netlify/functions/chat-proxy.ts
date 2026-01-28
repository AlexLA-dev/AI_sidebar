import type { Context } from "@netlify/functions"
import { createClient } from "@supabase/supabase-js"
import OpenAI from "openai"

// Environment variables (set in Netlify dashboard)
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

type PlanType = "free" | "byok_license" | "pro_subscription"

interface UserSubscription {
  user_id: string
  plan_type: PlanType
  credits_balance: number
  subscription_status: string
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

export default async function handler(req: Request, context: Context) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  try {
    // Extract and verify JWT token
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const token = authHeader.replace("Bearer ", "")

    // Verify user with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
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
        .insert({ user_id: user.id, plan_type: "free", credits_balance: 5 })
        .select()
        .single()

      if (createError) {
        return new Response(
          JSON.stringify({ error: "Failed to create user subscription" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }

      return handleChatRequest(req, newSub as UserSubscription, user.id)
    }

    return handleChatRequest(req, subscription as UserSubscription, user.id)
  } catch (error) {
    console.error("Chat proxy error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
}

async function handleChatRequest(
  req: Request,
  subscription: UserSubscription,
  userId: string
): Promise<Response> {
  const { plan_type, credits_balance, subscription_status } = subscription

  // Check plan type and access
  if (plan_type === "byok_license") {
    // BYOK users should call OpenAI directly from client
    return new Response(
      JSON.stringify({
        error: "BYOK users should use their own API key",
        code: "USE_OWN_KEY"
      }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  if (plan_type === "pro_subscription") {
    // Check if subscription is active
    if (subscription_status !== "active") {
      return new Response(
        JSON.stringify({
          error: "Subscription is not active",
          code: "SUBSCRIPTION_INACTIVE",
          status: subscription_status
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }
    // Pro subscribers get unlimited access with our key
  }

  if (plan_type === "free") {
    // Check credits balance
    if (credits_balance <= 0) {
      return new Response(
        JSON.stringify({
          error: "Trial credits exhausted",
          code: "CREDITS_EXHAUSTED",
          credits_remaining: 0
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

  // Parse request body
  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  const { messages, model = "gpt-4o-mini", max_tokens = 2048 } = body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "Messages array is required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

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
              // Send as SSE format
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
        metadata: { model, messages_count: messages.length }
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

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to process chat request"
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
}
