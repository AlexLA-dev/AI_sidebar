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
  // How many answers this one counts as (a long page, weight.mts); 1 when absent.
  amount?: number
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
/** One of the install's free answers in the guided first request (2.6, tour.mts): true while it had one left. */
export const takeTourAnswer = (installId: string, max: number) => rpc<boolean>("cf_tour_take", { p_install: installId, p_max: max })
/** The guided answer didn't come (refused, failed): it's the install's again. */
export const giveTourAnswerBack = (installId: string) => rpc<null>("cf_tour_give_back", { p_install: installId })

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

/** The install hit the free daily limit on an earlier UTC day (cf_limited_before): the Pro offer code
 * is shown to it once more when the panel opens. */
export const limitedBefore = (installId: string) => rpc<boolean>("cf_limited_before", { p_install: installId })

/** Usage analytics for the last `days` days (see cf_usage_report in supabase/migrations). */
export const usageReport = (days: number) => rpc<Record<string, unknown>>("cf_usage_report", { p_days: days })
/** New users' way from opening the app to paying, by day (cf_setup_funnel). */
export const setupFunnel = (days: number) => rpc<Record<string, unknown>[]>("cf_setup_funnel", { p_days: days })
/** Subscribers' device, language and country, new vs returning users' requests, conversion to subscribers,
 * requests per user per day and install sources (cf_owner_insights). */
export const ownerInsights = (days: number) => rpc<Record<string, unknown>>("cf_owner_insights", { p_days: days })
/** Whether any limit keeps getting in users' way: per limit, answers and users it touched (cf_limits_report). */
export const limitsReport = (days: number) => rpc<Record<string, unknown>>("cf_limits_report", { p_days: days })
/** Organizing the chats (2.5): suggestions shown, taken, turned down and undone; promotions; turning it on (cf_organize_report). */
export const organizeReport = (days: number) => rpc<Record<string, unknown>>("cf_organize_report", { p_days: days })
/** New people's way to the first answer, one row each, by the day they first showed up (cf_onboarding). */
export const onboarding = (days: number) => rpc<Record<string, unknown>>("cf_onboarding", { p_days: days })
/** By day: new users, how many of them ran out of free answers that day, Pro bought (cf_new_user_outcomes). */
export const newUserOutcomes = (days: number) => rpc<Record<string, unknown>[]>("cf_new_user_outcomes", { p_days: days })
/** Per feature: people, where they came from, what they did next; sessions (cf_features). `base` says who could
 * have used each feature (src/shared/usage.ts). */
export const features = (days: number, base: Record<string, unknown>) =>
  rpc<Record<string, unknown>>("cf_features", { p_days: days, p_base: base })
/** Feature funnels: who reached each step after the one before (cf_feature_funnels). */
export const featureFunnels = (days: number) => rpc<Record<string, unknown>[]>("cf_feature_funnels", { p_days: days })
/** People who ran out of free answers and what they did next; paying installs and their last day (cf_after_limit). */
export const afterLimit = (days: number) => rpc<Record<string, unknown>>("cf_after_limit", { p_days: days })

/** When App Review approved each app version, for the version lines on the daily charts (cf_releases). */
export const releases = () => rpc<Array<Record<string, unknown>>>("cf_releases", {})

export async function logEvent(kind: string, installId: string | null, data: Record<string, unknown>): Promise<void> {
  try {
    await rpc<null>("cf_log", { p_kind: kind, p_install: installId, p_data: { ...data, ...testMark(data) } })
  } catch (err) {
    console.error("[cf] log failed:", err instanceof Error ? err.message : err)
  }
}

// Deploy previews, branch deploys and `netlify dev` write to the same database as production, and so do
// our own scripts ("dev-check", "calibrate"): such rows are marked as tests, which every report leaves out
// (with the install or app they came from).
const OUR_VERSIONS = new Set(["dev-check", "calibrate"])

function testMark(data: Record<string, unknown>): Record<string, unknown> {
  const deploy = (globalThis as { Netlify?: { context?: { deploy?: { context?: string } } | null } }).Netlify?.context?.deploy?.context ??
    process.env.CONTEXT
  if (deploy && deploy !== "production") return { audience: "test", deploy: deploy.slice(0, 20) }
  return OUR_VERSIONS.has(String(data.version ?? "")) ? { audience: "test" } : {}
}

// Retention cleanup is optional (the function needs a one-time owner approval
// to be created); missing function is not an error.
export async function maybeCleanup(): Promise<void> {
  if (Math.random() > 0.005) return
  await db().rpc("cf_cleanup").then(() => undefined, () => undefined)
}
