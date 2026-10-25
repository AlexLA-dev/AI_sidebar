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
  // Model per plan. "auto:smart" / "auto:fast" pick the newest full-size / mini GPT model from
  // OpenAI's model list (refreshed every few hours); any other value pins that model id.
  proModel: env("OPENAI_MODEL_PRO") ?? "auto:smart",
  freeModel: env("OPENAI_MODEL_FREE") ?? "auto:fast",
  // Tried in order when the model above is unavailable or the model list can't be fetched.
  fallbackModels: (env("OPENAI_MODEL") ?? "gpt-5-mini,gpt-4.1-mini").split(",").map((m) => m.trim()).filter(Boolean),
  maxOutputTokens: int("OPENAI_MAX_TOKENS", 1500),

  // "Google in ContextFlow": Gemini with Grounding with Google Search. Without a key the mode
  // answers SEARCH_UNAVAILABLE. "auto" picks the newest stable Gemini Flash from the model list.
  // Trimmed: a key pasted into the Netlify UI easily picks up a trailing space or newline.
  geminiKey: (env("GEMINI_API_KEY") ?? "").trim(),
  geminiModel: env("GEMINI_MODEL") ?? "auto",
  geminiFallbackModels: (env("GEMINI_FALLBACK_MODELS") ?? "gemini-3.8-flash,gemini-3.6-flash,gemini-2.5-flash").split(",").map((m) => m.trim()).filter(Boolean),
  geminiMaxOutputTokens: int("GEMINI_MAX_TOKENS", 4096),
  // Google answers also count against the plan's normal allowance; these cap the search share
  // (each grounded answer is billed per search query on top of tokens).
  searchFreeDailyLimit: int("SEARCH_FREE_DAILY_LIMIT", 3),
  searchProWeeklyLimit: int("SEARCH_PRO_WEEKLY_LIMIT", 100),
  searchGlobalDailyLimit: int("SEARCH_GLOBAL_DAILY_LIMIT", 1500),

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

  ipPepper: env("CF_IP_PEPPER") ?? "contextflow-ip-v1",

  // Bearer token for GET /api/v2/admin/usage (the /analytics page). Unset = endpoint disabled.
  adminToken: (env("ADMIN_TOKEN") ?? "").trim(),
  // Own-key usage reports accepted per install per day (they only feed analytics).
  ownKeyReportDailyLimit: int("OWN_KEY_REPORT_DAILY_LIMIT", 1000)
}

export const PRODUCTS = {
  "com.contextflow.pro.monthly": "pro",
  "com.contextflow.pro.yearly": "pro",
  "com.contextflow.byok.monthly": "byok"
} as const

export type PaidPlan = (typeof PRODUCTS)[keyof typeof PRODUCTS]
export type Plan = "free" | PaidPlan
