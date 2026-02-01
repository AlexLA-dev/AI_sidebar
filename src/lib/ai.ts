import OpenAI from "openai"

import {
  getTrialInfo,
  incrementTrialUsage,
  getStoredApiKey,
  setStoredApiKey,
  type TrialInfo
} from "./storage"
import { proxyChatRequest } from "./api-client"

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

// Check if user can make a request
async function checkAccessPermission(): Promise<{ allowed: boolean; trialInfo: TrialInfo }> {
  const trialInfo = await getTrialInfo()

  // Licensed users have unlimited access
  if (trialInfo.hasLicense) {
    return { allowed: true, trialInfo }
  }

  // Trial users: check remaining requests
  if (trialInfo.remaining > 0) {
    return { allowed: true, trialInfo }
  }

  // Trial expired
  return { allowed: false, trialInfo }
}

export async function streamChatResponse(
  messages: Message[],
  pageContext: string | null,
  apiKey: string,
  callbacks: StreamCallbacks,
  contextType: ContextType = "page"
): Promise<void> {
  // Check access permission (gatekeeper)
  const { allowed, trialInfo } = await checkAccessPermission()

  if (!allowed) {
    callbacks.onError(new LimitReachedError())
    return
  }

  const messagesWithContext = buildMessagesWithContext(messages, pageContext, contextType)

  // If user has their own API key, use it directly via OpenAI
  if (apiKey) {
    await streamWithDirectKey(apiKey, messagesWithContext, trialInfo, callbacks)
    return
  }

  // No API key — use the Netlify proxy (trial / pro users)
  try {
    await proxyChatRequest(messagesWithContext, {
      onChunk: callbacks.onChunk,
      onComplete: async () => {
        if (!trialInfo.hasLicense) {
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
  callbacks: StreamCallbacks
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
    if (!trialInfo.hasLicense) {
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
export { getStoredApiKey, setStoredApiKey, getTrialInfo, type TrialInfo }
