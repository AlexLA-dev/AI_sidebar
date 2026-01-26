import OpenAI from "openai"

export type Message = {
  role: "user" | "assistant" | "system"
  content: string
}

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
  pageContext: string | null
): Message[] {
  const systemMessage: Message = {
    role: "system",
    content: pageContext
      ? `${SYSTEM_PROMPT}\n\n--- PAGE_CONTEXT ---\n${pageContext.slice(0, 12000)}\n--- END PAGE_CONTEXT ---`
      : SYSTEM_PROMPT
  }

  return [systemMessage, ...messages]
}

export async function streamChatResponse(
  messages: Message[],
  pageContext: string | null,
  apiKey: string,
  callbacks: StreamCallbacks
): Promise<void> {
  if (!apiKey) {
    callbacks.onError(new Error("API key is required"))
    return
  }

  const client = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true
  })

  const messagesWithContext = buildMessagesWithContext(messages, pageContext)

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

// Storage helpers for API key
const API_KEY_STORAGE_KEY = "contextflow_openai_key"

export function getStoredApiKey(): string {
  if (typeof window === "undefined") return ""
  return localStorage.getItem(API_KEY_STORAGE_KEY) || ""
}

export function setStoredApiKey(key: string): void {
  if (typeof window === "undefined") return
  if (key) {
    localStorage.setItem(API_KEY_STORAGE_KEY, key)
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY)
  }
}
