import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { config } from "./config.mts"

// All ContextFlow data lives in the isolated `contextflow` schema of the shared
// Supabase project and is reachable only through the service-role `cf_*` RPCs
// (see supabase/migrations). Nothing here touches Baby Sleep Well tables.

let client: SupabaseClient | null = null

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  }
  return client
}

export interface Counter {
  subject: string
  period: "day" | "week"
  limit: number | null
}

export interface CounterState extends Counter {
  n: number
}

export interface ConsumeResult {
  allowed: boolean
  blocked: string | null
  counters: CounterState[]
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

export const consume = (items: Counter[]) => rpc<ConsumeResult>("cf_consume", { p_items: items })
export const refund = (items: Counter[]) => rpc<null>("cf_refund", { p_items: items })
export const peek = (items: Counter[]) => rpc<CounterState[]>("cf_peek", { p_items: items })

export function touchInstall(installId: string, platform: string, version: string, locale: string, requests = 0) {
  return rpc<null>("cf_touch_install", {
    p_install: installId, p_platform: platform || null, p_version: version || null, p_locale: locale || null, p_requests: requests
  })
}

export interface EntitlementRow {
  original_transaction_id: string
  product_id: string
  environment: string
  expires_at: string | null
  revoked_at: string | null
  app_account_token: string | null
}

export const upsertEntitlement = (row: Record<string, unknown>) => rpc<EntitlementRow>("cf_entitlement_upsert", { p: row })
export const getEntitlement = (originalTransactionId: string) =>
  rpc<EntitlementRow | null>("cf_entitlement_get", { p_original_transaction_id: originalTransactionId })
export const entitlementByToken = (token: string) => rpc<EntitlementRow | null>("cf_entitlement_by_token", { p_token: token })

/** Usage analytics for the last `days` days (see cf_usage_report in supabase/migrations). */
export const usageReport = (days: number) => rpc<Record<string, unknown>>("cf_usage_report", { p_days: days })

export async function logEvent(kind: string, installId: string | null, data: Record<string, unknown>): Promise<void> {
  try {
    await rpc<null>("cf_log", { p_kind: kind, p_install: installId, p_data: data })
  } catch (err) {
    console.error("[cf] log failed:", err instanceof Error ? err.message : err)
  }
}

// Retention cleanup is optional (the function needs a one-time owner approval
// to be created); missing function is not an error.
export async function maybeCleanup(): Promise<void> {
  if (Math.random() > 0.005) return
  await db().rpc("cf_cleanup").then(() => undefined, () => undefined)
}
