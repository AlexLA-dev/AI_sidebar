import OpenAI from "openai"

import {
  getTrialInfo,
  incrementTrialUsage,
  getAnonymousTrialInfo,
  incrementAnonymousUsage,
  syncSubscriptionFromServer,
  syncSubscriptionFromNative,
  getStoredApiKey,
  setStoredApiKey,
  type TrialInfo
} from "./storage"
import { proxyChatRequest, getSession } from "./api-client"

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

// Custom error for limit reached
export class LimitReachedError extends Error {
  code = "LIMIT_REACHED" as const

  constructor() {
    super("Trial limit reached. Please subscribe to continue.")
    this.name = "LimitReachedError"
  }
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

// Check if user can make a request.
// Returns `isAnonymous: true` when there's no active session (user hasn't signed in).
async function checkAccessPermission(): Promise<{ allowed: boolean; trialInfo: TrialInfo; isAnonymous: boolean }> {
  // If user is logged in, use full subscription-based logic
  const token = await getSession()

  if (token) {
    let trialInfo = await getTrialInfo()

    if (trialInfo.hasLicense) {
      return { allowed: true, trialInfo, isAnonymous: false }
    }

    // Fallback: check native App Store bridge (Safari only)
    try {
      trialInfo = await syncSubscriptionFromNative()
      if (trialInfo.hasLicense) {
        return { allowed: true, trialInfo, isAnonymous: false }
      }
    } catch {
      // Native bridge not available
    }

    if (trialInfo.remaining > 0) {
      return { allowed: true, trialInfo, isAnonymous: false }
    }

    return { allowed: false, trialInfo, isAnonymous: false }
  }

  // Anonymous user (not signed in): local-only trial tracking
  const anonInfo = await getAnonymousTrialInfo()
  return {
    allowed: anonInfo.remaining > 0,
    trialInfo: anonInfo,
    isAnonymous: true
  }
}

export async function streamChatResponse(
  messages: Message[],
  pageContext: string | null,
  apiKey: string,
  callbacks: StreamCallbacks,
  contextType: ContextType = "page"
): Promise<void> {
  // Check access permission (gatekeeper)
  const { allowed, trialInfo, isAnonymous } = await checkAccessPermission()

  if (!allowed) {
    callbacks.onError(new LimitReachedError())
    return
  }

  const messagesWithContext = buildMessagesWithContext(messages, pageContext, contextType)

  // If user has their own API key, use it directly via OpenAI
  if (apiKey) {
    await streamWithDirectKey(apiKey, messagesWithContext, trialInfo, callbacks, isAnonymous)
    return
  }

  // No API key — use the Netlify proxy (trial / pro / anonymous users)
  const apiUrl = process.env.PLASMO_PUBLIC_API_URL
  if (!apiUrl) {
    callbacks.onError(
      new Error(
        "Backend proxy is not configured. Please set PLASMO_PUBLIC_API_URL in .env.local, or enter your own OpenAI API key in Settings."
      )
    )
    return
  }

  try {
    await proxyChatRequest(messagesWithContext, {
      onChunk: callbacks.onChunk,
      onComplete: async () => {
        if (isAnonymous) {
          await incrementAnonymousUsage()
        } else if (!trialInfo.hasLicense) {
          await incrementTrialUsage()
        }
        callbacks.onComplete()
      },
      onError: callbacks.onError
    })
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error("Unknown error occurred"))
  }
}

async function streamWithDirectKey(
  apiKey: string,
  messagesWithContext: Message[],
  trialInfo: TrialInfo,
  callbacks: StreamCallbacks,
  isAnonymous = false
): Promise<void> {
  const client = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true
  })

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

    // Increment usage counter for trial users (after successful completion)
    if (isAnonymous) {
      await incrementAnonymousUsage()
    } else if (!trialInfo.hasLicense) {
      await incrementTrialUsage()
    }

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

// Re-export storage helpers
export { getStoredApiKey, setStoredApiKey, getTrialInfo, getAnonymousTrialInfo, syncSubscriptionFromServer, type TrialInfo }
