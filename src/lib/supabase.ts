import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.PLASMO_PUBLIC_SUPABASE_URL || ""
const SUPABASE_ANON_KEY = process.env.PLASMO_PUBLIC_SUPABASE_ANON_KEY || ""

let client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error(
        "Supabase configuration missing. Check PLASMO_PUBLIC_SUPABASE_URL and PLASMO_PUBLIC_SUPABASE_ANON_KEY."
      )
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        // Extensions don't have URL-based redirects
        detectSessionInUrl: false,
        // Use chrome.storage.local for session persistence
        storage: {
          getItem: async (key) => {
            try {
              const result = await chrome.storage.local.get(key)
              return result[key] || null
            } catch {
              return localStorage.getItem(key)
            }
          },
          setItem: async (key, value) => {
            try {
              await chrome.storage.local.set({ [key]: value })
            } catch {
              localStorage.setItem(key, value)
            }
          },
          removeItem: async (key) => {
            try {
              await chrome.storage.local.remove(key)
            } catch {
              localStorage.removeItem(key)
            }
          }
        }
      }
    })
  }
  return client
}

/**
 * Initialize the Supabase client from a shared auth session (App Group).
 * Called on Safari extension load to pick up a session written by the native app.
 * Returns true if a valid session was set.
 */
export async function initFromSharedSession(): Promise<boolean> {
  try {
    const { isSafari } = await import("./platform")
    if (!isSafari()) return false

    const { getSharedAuthSession } = await import("./appstore")
    const shared = await getSharedAuthSession()
    if (!shared || !shared.access_token || !shared.refresh_token) return false

    const supabase = getSupabaseClient()

    // Check if we already have a valid session
    const { data: { session: existing } } = await supabase.auth.getSession()
    if (existing?.access_token) return true

    // Set session from shared tokens — SDK will auto-refresh if expired
    const { error } = await supabase.auth.setSession({
      access_token: shared.access_token,
      refresh_token: shared.refresh_token
    })

    if (error) {
      console.warn("[ContextFlow] Failed to set shared session:", error.message)
      return false
    }

    return true
  } catch (err) {
    console.warn("[ContextFlow] initFromSharedSession error:", err)
    return false
  }
}
