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
