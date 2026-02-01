import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

import { getSupabaseClient } from "./supabase"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// Stripe Payment Link environment variables
const STRIPE_LINKS: Record<string, string | undefined> = {
  basic: process.env.PLASMO_PUBLIC_STRIPE_LINK_BASIC,
  pro: process.env.PLASMO_PUBLIC_STRIPE_LINK_PRO
}

export type PlanId = "basic" | "pro"

export interface PaymentLinkResult {
  success: boolean
  url?: string
  error?: string
}

/**
 * Get a Stripe Payment Link URL for a given plan.
 * Appends client_reference_id if the user is logged in via Supabase.
 */
export async function getPaymentLink(plan: PlanId): Promise<PaymentLinkResult> {
  const baseUrl = STRIPE_LINKS[plan]

  if (!baseUrl) {
    return {
      success: false,
      error: `Payment link not configured for "${plan}" plan. Check PLASMO_PUBLIC_STRIPE_LINK_${plan.toUpperCase()}.`
    }
  }

  try {
    const supabase = getSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (user) {
      // Append user ID so Stripe webhook can link payment to account
      const separator = baseUrl.includes("?") ? "&" : "?"
      return {
        success: true,
        url: `${baseUrl}${separator}client_reference_id=${user.id}`
      }
    }

    // No authenticated user — still return the link (Stripe will handle it)
    return { success: true, url: baseUrl }
  } catch {
    // Supabase not configured or unavailable — return link without user ID
    return { success: true, url: baseUrl }
  }
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
  payload: TPayload,
  maxRetries = 3
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

    // Retry loop — content script may not be injected yet
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
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

        const isNotReady =
          errorMessage.includes("Receiving end does not exist") ||
          errorMessage.includes("Could not establish connection") ||
          errorMessage.includes("message channel closed") ||
          errorMessage.includes("message port closed")

        if (isNotReady && attempt < maxRetries) {
          // Wait before retry: 500ms, 1000ms, 1500ms
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
          continue
        }

        if (isNotReady) {
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

    return {
      success: false,
      error: "Failed to connect to content script",
      shouldRetry: true
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: errorMessage
    }
  }
}
