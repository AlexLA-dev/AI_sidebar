import OpenAI from "openai"

import { storage, STORAGE_KEYS } from "./storage"

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

export async function streamChatResponse(
  messages: Message[],
  pageContext: string | null,
  apiKey: string,
  callbacks: StreamCallbacks,
  contextType: ContextType = "page"
): Promise<void> {
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

// Storage helpers for API key (using Plasmo Storage)
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
