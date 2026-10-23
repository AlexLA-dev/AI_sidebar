// Runtime configuration. Every value can be overridden from the Netlify UI
// (Project configuration → Environment variables) without a code change.

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name)
  return fromNetlify ?? process.env[name]
}

function int(name: string, fallback: number): number {
  const raw = env(name)
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(value) ? value : fallback
}

export const config = {
  supabaseUrl: env("SUPABASE_URL") ?? "",
  supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  openaiKey: env("OPENAI_API_KEY") ?? "",
  // First model is tried first; the next ones are used only if the previous is unavailable.
  models: (env("OPENAI_MODEL") ?? "gpt-4.1-mini,gpt-4o-mini").split(",").map((m) => m.trim()).filter(Boolean),
  maxOutputTokens: int("OPENAI_MAX_TOKENS", 1500),

  appStoreBundleId: env("APPSTORE_BUNDLE_ID") ?? "com.contextflow.app",
  // Sandbox purchases are what App Review and TestFlight use, so they must be accepted in production too.
  acceptSandbox: (env("APPSTORE_ACCEPT_SANDBOX") ?? "true") !== "false",
  // Extra time after expiresDate before a subscription stops working on the server
  // (covers clock skew and the billing grace period while the device refreshes).
  entitlementLeewayMs: int("ENTITLEMENT_LEEWAY_HOURS", 48) * 3600_000,

  freeDailyLimit: int("FREE_DAILY_LIMIT", 5),
  freeIpDailyLimit: int("FREE_IP_DAILY_LIMIT", 40),
  freeGlobalDailyLimit: int("FREE_GLOBAL_DAILY_LIMIT", 3000),
  proWeeklyLimit: int("PRO_WEEKLY_LIMIT", 375),
  legacyIpDailyLimit: int("LEGACY_IP_DAILY_LIMIT", 10),

  ipPepper: env("CF_IP_PEPPER") ?? "contextflow-ip-v1"
}

export const PRODUCTS = {
  "com.contextflow.pro.monthly": "pro",
  "com.contextflow.pro.yearly": "pro",
  "com.contextflow.byok.monthly": "byok"
} as const

export type PaidPlan = (typeof PRODUCTS)[keyof typeof PRODUCTS]
export type Plan = "free" | PaidPlan
