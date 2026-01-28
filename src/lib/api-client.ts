import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js"

// Environment configuration
// In production, these would be injected at build time or from extension config
const SUPABASE_URL = process.env.PLASMO_PUBLIC_SUPABASE_URL || ""
const SUPABASE_ANON_KEY = process.env.PLASMO_PUBLIC_SUPABASE_ANON_KEY || ""
const API_BASE_URL = process.env.PLASMO_PUBLIC_API_URL || "/.netlify/functions"

// Types
export type PlanType = "free" | "byok_license" | "pro_subscription"

export interface UserSubscription {
  user_id: string
  plan_type: PlanType
  credits_balance: number
  subscription_status: string
  stripe_customer_id?: string
  current_period_end?: string
}

export interface ChatMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onComplete: () => void
  onError: (error: Error) => void
}

// API Error types
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export class CreditsExhaustedError extends ApiError {
  constructor() {
    super("Trial credits exhausted", "CREDITS_EXHAUSTED", 403)
  }
}

export class SubscriptionInactiveError extends ApiError {
  constructor(status: string) {
    super(`Subscription is ${status}`, "SUBSCRIPTION_INACTIVE", 403)
  }
}

export class UseOwnKeyError extends ApiError {
  constructor() {
    super("BYOK users should use their own API key", "USE_OWN_KEY", 403)
  }
}

// Supabase client singleton
let supabaseClient: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Supabase configuration missing")
    }
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        storage: {
          // Use Chrome storage for session persistence
          getItem: async (key) => {
            const result = await chrome.storage.local.get(key)
            return result[key] || null
          },
          setItem: async (key, value) => {
            await chrome.storage.local.set({ [key]: value })
          },
          removeItem: async (key) => {
            await chrome.storage.local.remove(key)
          }
        }
      }
    })
  }
  return supabaseClient
}

// Auth functions
export async function signInWithEmail(
  email: string,
  password: string
): Promise<User> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  })

  if (error) {
    throw new ApiError(error.message, "AUTH_ERROR", 401)
  }

  return data.user
}

export async function signUpWithEmail(
  email: string,
  password: string
): Promise<User> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password
  })

  if (error) {
    throw new ApiError(error.message, "AUTH_ERROR", 400)
  }

  if (!data.user) {
    throw new ApiError("Failed to create user", "AUTH_ERROR", 400)
  }

  return data.user
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient()
  await supabase.auth.signOut()
}

export async function getCurrentUser(): Promise<User | null> {
  const supabase = getSupabaseClient()
  const { data } = await supabase.auth.getUser()
  return data.user
}

export async function getSession(): Promise<string | null> {
  const supabase = getSupabaseClient()
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token || null
}

// Subscription functions
export async function getUserSubscription(): Promise<UserSubscription | null> {
  const supabase = getSupabaseClient()
  const user = await getCurrentUser()

  if (!user) {
    return null
  }

  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .single()

  if (error) {
    console.error("Failed to get subscription:", error)
    return null
  }

  return data as UserSubscription
}

// Chat proxy function - calls Netlify function with streaming
export async function proxyChatRequest(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  model = "gpt-4o-mini",
  maxTokens = 2048
): Promise<void> {
  const token = await getSession()

  if (!token) {
    callbacks.onError(new ApiError("Not authenticated", "AUTH_REQUIRED", 401))
    return
  }

  try {
    const response = await fetch(`${API_BASE_URL}/chat-proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages,
        model,
        max_tokens: maxTokens
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorCode = errorData.code || "API_ERROR"
      const errorMessage = errorData.error || "Request failed"

      // Handle specific error codes
      switch (errorCode) {
        case "CREDITS_EXHAUSTED":
          callbacks.onError(new CreditsExhaustedError())
          return
        case "SUBSCRIPTION_INACTIVE":
          callbacks.onError(new SubscriptionInactiveError(errorData.status || "inactive"))
          return
        case "USE_OWN_KEY":
          callbacks.onError(new UseOwnKeyError())
          return
        default:
          callbacks.onError(new ApiError(errorMessage, errorCode, response.status))
          return
      }
    }

    // Handle SSE streaming response
    const reader = response.body?.getReader()
    if (!reader) {
      callbacks.onError(new ApiError("No response body", "NO_BODY", 500))
      return
    }

    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE messages
      const lines = buffer.split("\n")
      buffer = lines.pop() || "" // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim()

          if (data === "[DONE]") {
            callbacks.onComplete()
            return
          }

          try {
            const parsed = JSON.parse(data)
            if (parsed.content) {
              callbacks.onChunk(parsed.content)
            }
          } catch {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    }

    callbacks.onComplete()
  } catch (error) {
    callbacks.onError(
      error instanceof Error
        ? error
        : new ApiError("Network error", "NETWORK_ERROR", 0)
    )
  }
}

// Stripe checkout - creates a checkout session
export async function createCheckoutSession(
  planType: "byok_license" | "pro_subscription"
): Promise<string> {
  const token = await getSession()
  const user = await getCurrentUser()

  if (!token || !user) {
    throw new ApiError("Not authenticated", "AUTH_REQUIRED", 401)
  }

  // In a real implementation, you'd call a Netlify function to create the checkout session
  // For now, we'll construct the Stripe checkout URL directly
  const priceId =
    planType === "byok_license"
      ? process.env.PLASMO_PUBLIC_STRIPE_BYOK_PRICE_ID
      : process.env.PLASMO_PUBLIC_STRIPE_PRO_PRICE_ID

  if (!priceId) {
    throw new ApiError("Stripe price not configured", "CONFIG_ERROR", 500)
  }

  // This would typically be a call to your backend to create a secure checkout session
  // The backend would use Stripe.checkout.sessions.create() with client_reference_id: user.id
  const checkoutUrl = `https://checkout.stripe.com/pay/${priceId}?client_reference_id=${user.id}`

  return checkoutUrl
}

// Customer portal - for managing subscriptions
export async function createPortalSession(): Promise<string> {
  const subscription = await getUserSubscription()

  if (!subscription?.stripe_customer_id) {
    throw new ApiError("No active subscription", "NO_SUBSCRIPTION", 400)
  }

  // This would call a backend function to create a Stripe Customer Portal session
  // For now, return a placeholder
  throw new ApiError("Portal not implemented", "NOT_IMPLEMENTED", 501)
}
