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
  // Answers go to Claude first; OpenAI (below) answers when Claude can't: no key, CLAUDE_ANSWERS=off,
  // an error before the first word (auth, credits, rate limit, overload, timeout) or a refusal.
  anthropicKey: (env("ANTHROPIC_API_KEY") ?? "").trim(),
  claudeEnabled: (env("CLAUDE_ANSWERS") ?? "on").trim() !== "off",
  // Claude only answers app builds whose consent screen names Anthropic (2.4 build 67 and later);
  // older builds, and requests without a build number, told their users about OpenAI only. 0: no check.
  claudeMinBuild: int("CLAUDE_MIN_BUILD", 67),
  claude: {
    free: {
      model: env("ANTHROPIC_MODEL_FREE") ?? "claude-sonnet-5-5",
      // "low": thinks only when a question needs it, so simple questions cost the least.
      effort: env("ANTHROPIC_EFFORT_FREE") ?? "low",
      maxTokens: int("ANTHROPIC_MAX_TOKENS_FREE", 3000)
    },
    pro: {
      model: env("ANTHROPIC_MODEL_PRO") ?? "claude-sonnet-5-5",
      // "medium": thinks briefly before answering, for deeper and more detailed answers.
      effort: env("ANTHROPIC_EFFORT_PRO") ?? "medium",
      maxTokens: int("ANTHROPIC_MAX_TOKENS_PRO", 8000)
    }
  },
  // No first word from Claude by then: OpenAI answers instead.
  claudeFirstTokenMs: int("ANTHROPIC_FIRST_TOKEN_MS", 20_000),
  // USD per million tokens, for the spend in the logs (Claude Sonnet 5.5 list prices).
  claudePriceIn: Number(env("ANTHROPIC_PRICE_IN") ?? 2),
  claudePriceOut: Number(env("ANTHROPIC_PRICE_OUT") ?? 10),

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
  ownKeyReportDailyLimit: int("OWN_KEY_REPORT_DAILY_LIMIT", 1000),
  // Funnel events (app opened, extension switched on) accepted per id per day.
  eventDailyLimit: int("EVENT_DAILY_LIMIT", 30),
  // App Store offer code for free users who ran out of answers (Pro, first month off; set up in App Store
  // Connect on pro.monthly). PRO_OFFER_CODE=off stops offering it; PRO_OFFER_DISCOUNT is what the panel says.
  proOfferCode: (env("PRO_OFFER_CODE") ?? "CONTEXTFLOW50").trim(),
  proOfferDiscount: int("PRO_OFFER_DISCOUNT", 50),
  // Own key → Pro at a discount: a promotional offer on pro.monthly (App Store Connect) that the server signs
  // with an In-App Purchase key. Until all three are set, Own-key users are offered Pro at full price only.
  // PROMO_DISCOUNT is what the panel and the app say (the App Store shows the real price before paying).
  promoOfferId: (env("PROMO_OFFER_ID") ?? "").trim(),
  promoKeyId: (env("PROMO_KEY_ID") ?? "").trim(),
  // The key's .p8 text (PEM); newlines may come as "\n".
  promoPrivateKey: (env("PROMO_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n").trim(),
  promoDiscount: int("PROMO_DISCOUNT", 50),
  promoProductId: (env("PROMO_PRODUCT_ID") ?? "com.contextflow.pro.monthly").trim(),
  // Apps that may ask for a signature (the iOS and macOS apps share one bundle id).
  appBundleIds: (env("APP_BUNDLE_IDS") ?? "com.contextflow.app").split(",").map((s) => s.trim()).filter(Boolean)
}

export const PRODUCTS = {
  "com.contextflow.pro.monthly": "pro",
  "com.contextflow.pro.yearly": "pro",
  "com.contextflow.byok.monthly": "byok"
} as const

export type PaidPlan = (typeof PRODUCTS)[keyof typeof PRODUCTS]
export type Plan = "free" | PaidPlan
