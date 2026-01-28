import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// Restricted URL prefixes where content scripts cannot run
const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "moz-extension://",
  "devtools://"
]

export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  shouldRetry?: boolean
  isRestrictedPage?: boolean
}

export async function sendMessageToActiveTab<TPayload, TResponse>(
  payload: TPayload
): Promise<MessageResponse<TResponse>> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    })

    if (!activeTab?.id) {
      return {
        success: false,
        error: "No active tab available"
      }
    }

    // Check for restricted URLs
    const tabUrl = activeTab.url || ""
    const isRestricted = RESTRICTED_URL_PREFIXES.some(prefix =>
      tabUrl.startsWith(prefix)
    )

    if (isRestricted) {
      return {
        success: false,
        error: "Cannot access system pages",
        isRestrictedPage: true
      }
    }

    // Check if tab is still loading
    if (activeTab.status !== "complete") {
      return {
        success: false,
        error: "Page is still loading",
        shouldRetry: true
      }
    }

    // Attempt to send message
    const response = await chrome.tabs.sendMessage<TPayload, TResponse>(
      activeTab.id,
      payload
    )

    return {
      success: true,
      data: response
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    // Check for content script not ready error
    if (
      errorMessage.includes("Receiving end does not exist") ||
      errorMessage.includes("Could not establish connection")
    ) {
      return {
        success: false,
        error: "Content script not ready. Try refreshing the page.",
        shouldRetry: true
      }
    }

    return {
      success: false,
      error: errorMessage
    }
  }
}
