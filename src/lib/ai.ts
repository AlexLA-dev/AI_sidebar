import OpenAI from "openai"

import { storage, STORAGE_KEYS, SUBSCRIPTION_CONFIG, getNextPeriodEnd, type UserMode } from "./storage"

export type Message = {
  role: "user" | "assistant" | "system"
  content: string
}

export type ContextType = "page" | "selection"

export type StreamCallbacks = {
  onChunk: (chunk: string) => void
  onComplete: () => void
  onError: (error: Error) => void
}

export type UsageInfo = {
  used: number
  limit: number
  periodEnd: string | null
  isSubscription: boolean
}

const SYSTEM_PROMPT = `You are ContextFlow, an AI browser assistant. You help users understand and interact with web pages.

When PAGE_CONTEXT is provided, use it to answer the user's questions accurately and concisely.
- Be helpful and direct
- Use markdown formatting when appropriate
- If the answer isn't in the context, say so honestly
- Keep responses focused and relevant`

export function buildMessagesWithContext(
  messages: Message[],
  pageContext: string | null,
  contextType: ContextType = "page"
): Message[] {
  let contextSection = ""

  if (pageContext) {
    if (contextType === "selection") {
      contextSection = `\n\n--- USER SELECTED TEXT ---\n${pageContext.slice(0, 8000)}\n--- END SELECTED TEXT ---\n\nFocus your answer on the selected text above.`
    } else {
      contextSection = `\n\n--- PAGE_CONTEXT ---\n${pageContext.slice(0, 12000)}\n--- END PAGE_CONTEXT ---`
    }
  }

  const systemMessage: Message = {
    role: "system",
    content: SYSTEM_PROMPT + contextSection
  }

  return [systemMessage, ...messages]
}

// Check and reset usage period if needed
async function checkAndResetUsagePeriod(): Promise<void> {
  const periodEnd = await storage.get<string>(STORAGE_KEYS.USAGE_PERIOD_END)

  if (periodEnd && new Date() > new Date(periodEnd)) {
    // Period has ended, reset counter
    await storage.set(STORAGE_KEYS.USAGE_COUNTER, 0)
    await storage.set(STORAGE_KEYS.USAGE_PERIOD_END, getNextPeriodEnd())
  }
}

// Get current usage info
export async function getUsageInfo(): Promise<UsageInfo> {
  const userMode = await storage.get<UserMode>(STORAGE_KEYS.USER_MODE)
  const isSubscription = userMode === "subscription"

  if (!isSubscription) {
    return {
      used: 0,
      limit: 0,
      periodEnd: null,
      isSubscription: false
    }
  }

  await checkAndResetUsagePeriod()

  const usageCounter = await storage.get<number>(STORAGE_KEYS.USAGE_COUNTER) || 0
  const periodEnd = await storage.get<string>(STORAGE_KEYS.USAGE_PERIOD_END) || null

  return {
    used: usageCounter,
    limit: SUBSCRIPTION_CONFIG.WEEKLY_LIMIT,
    periodEnd,
    isSubscription: true
  }
}

// Check if usage limit is reached (for subscription mode)
async function checkUsageLimit(): Promise<{ allowed: boolean; error?: string }> {
  const userMode = await storage.get<UserMode>(STORAGE_KEYS.USER_MODE)

  // BYOK mode - no limits
  if (userMode === "byok") {
    return { allowed: true }
  }

  // Subscription mode - check limits
  if (userMode === "subscription") {
    const subscriptionActive = await storage.get<boolean>(STORAGE_KEYS.SUBSCRIPTION_ACTIVE)

    if (!subscriptionActive) {
      return { allowed: false, error: "Subscription is not active" }
    }

    await checkAndResetUsagePeriod()

    const usageCounter = await storage.get<number>(STORAGE_KEYS.USAGE_COUNTER) || 0

    if (usageCounter >= SUBSCRIPTION_CONFIG.WEEKLY_LIMIT) {
      const periodEnd = await storage.get<string>(STORAGE_KEYS.USAGE_PERIOD_END)
      const resetDate = periodEnd ? new Date(periodEnd).toLocaleDateString() : "soon"
      return {
        allowed: false,
        error: `Weekly limit reached (${SUBSCRIPTION_CONFIG.WEEKLY_LIMIT}/${SUBSCRIPTION_CONFIG.WEEKLY_LIMIT}). Resets on ${resetDate}. Switch to BYOK for unlimited usage.`
      }
    }

    return { allowed: true }
  }

  return { allowed: false, error: "Please complete onboarding first" }
}

// Increment usage counter (for subscription mode)
async function incrementUsageCounter(): Promise<void> {
  const userMode = await storage.get<UserMode>(STORAGE_KEYS.USER_MODE)

  if (userMode === "subscription") {
    const currentCount = await storage.get<number>(STORAGE_KEYS.USAGE_COUNTER) || 0
    await storage.set(STORAGE_KEYS.USAGE_COUNTER, currentCount + 1)
  }
}

export async function streamChatResponse(
  messages: Message[],
  pageContext: string | null,
  apiKey: string,
  callbacks: StreamCallbacks,
  contextType: ContextType = "page"
): Promise<void> {
  // Check usage limits first
  const usageCheck = await checkUsageLimit()
  if (!usageCheck.allowed) {
    callbacks.onError(new Error(usageCheck.error || "Usage limit reached"))
    return
  }

  if (!apiKey) {
    callbacks.onError(new Error("API key is required"))
    return
  }

  const client = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true
  })

  const messagesWithContext = buildMessagesWithContext(messages, pageContext, contextType)

  try {
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesWithContext,
      stream: true,
      max_tokens: 2048
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        callbacks.onChunk(content)
      }
    }

    // Increment usage counter on successful completion
    await incrementUsageCounter()

    callbacks.onComplete()
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        callbacks.onError(new Error("Invalid API key. Please check your OpenAI API key."))
      } else if (error.status === 429) {
        callbacks.onError(new Error("Rate limit exceeded. Please wait and try again."))
      } else {
        callbacks.onError(new Error(`API error: ${error.message}`))
      }
    } else {
      callbacks.onError(error instanceof Error ? error : new Error("Unknown error occurred"))
    }
  }
}

// Storage helpers (using Plasmo Storage)
export async function getStoredApiKey(): Promise<string> {
  const key = await storage.get<string>(STORAGE_KEYS.OPENAI_API_KEY)
  return key || ""
}

export async function setStoredApiKey(key: string): Promise<void> {
  if (key) {
    await storage.set(STORAGE_KEYS.OPENAI_API_KEY, key)
  } else {
    await storage.remove(STORAGE_KEYS.OPENAI_API_KEY)
  }
}

export async function getUserMode(): Promise<UserMode> {
  return await storage.get<UserMode>(STORAGE_KEYS.USER_MODE) || null
}

export async function setUserMode(mode: UserMode): Promise<void> {
  if (mode) {
    await storage.set(STORAGE_KEYS.USER_MODE, mode)
  } else {
    await storage.remove(STORAGE_KEYS.USER_MODE)
  }
}
