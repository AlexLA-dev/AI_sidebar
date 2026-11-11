// Runtime configuration. Every value can be overridden from the Netlify UI
// (Project configuration → Environment variables) without a code change.

import { organizeConfig } from "../../src/shared/organize.ts"
import { PLAN_PRODUCTS, ULTRA_DEFAULTS, type PaidPlan } from "../../src/shared/plan.ts"

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name)
  return fromNetlify ?? process.env[name]
}

function parsed(raw: string | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
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
  // Answers in the guided first request that don't count against the free ones, per install, ever (2.6, tour.mts).
  tourFreeAnswers: int("TOUR_FREE_ANSWERS", 3),
  freeIpDailyLimit: int("FREE_IP_DAILY_LIMIT", 40),
  freeGlobalDailyLimit: int("FREE_GLOBAL_DAILY_LIMIT", 3000),
  proWeeklyLimit: int("PRO_WEEKLY_LIMIT", 375),
  // Ultra (2.6): everything in Pro (its answers, the same weekly allowance unless set apart) and read aloud,
  // find similar and more watched pages. Read aloud counts seconds of audio, find similar counts searches, a week
  // per subscription (Monday, UTC); the global caps only stop runaway spend (nobody sees them).
  ultra: {
    weeklyLimit: int("ULTRA_WEEKLY_LIMIT", int("PRO_WEEKLY_LIMIT", 375)),
    speakWeeklySeconds: int("ULTRA_SPEAK_WEEKLY_SECONDS", ULTRA_DEFAULTS.speakWeeklySeconds),
    // Room over the week's minutes for a text that's already playing (its later parts), so it never ends in another voice.
    speakFinishSeconds: int("ULTRA_SPEAK_FINISH_SECONDS", 300),
    speakGlobalDailySeconds: int("SPEAK_GLOBAL_DAILY_SECONDS", 200_000),
    // Audio made a week per subscription, as a share of the allowance (build 92: the allowance counts what's heard;
    // parts made ahead, never heard, repeats and hand-offs are ours, up to this).
    speakMadePercent: int("ULTRA_SPEAK_MADE_PERCENT", 150),
    // Find similar's daily safety caps (per install, for everyone) belong to its engine (config.similar, /api/v2/similar).
    similarWeekly: int("ULTRA_SIMILAR_WEEKLY", ULTRA_DEFAULTS.similarWeekly)
  },
  // Read aloud (2.6, Ultra): Gemini TTS through our server with GEMINI_API_KEY, streamed as headerless PCM.
  // "auto" picks the newest stable model of the kind from the model list (like GEMINI_MODEL); Flash-Lite speaks
  // ~100 languages, the full Flash TTS the rest (TTS_FULL_LANGS, ISO 639-1/-3 codes Flash-Lite lacks).
  speak: {
    liteModel: (env("TTS_MODEL") ?? "auto").trim(),
    fullModel: (env("TTS_FULL_MODEL") ?? "auto").trim(),
    liteFallback: (env("TTS_FALLBACK_MODELS") ?? "gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview").split(",").map((m) => m.trim()).filter(Boolean),
    fullFallback: (env("TTS_FULL_FALLBACK_MODELS") ?? "gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview").split(",").map((m) => m.trim()).filter(Boolean),
    fullLangs: (env("TTS_FULL_LANGS") ?? "ba,bem,bjn,crh,dyu,dz,fi,gn,ig,kab,lb,lt,ltg,min,my,oc,pag,sd,sl,so,ss,st,sv,sw,tg,th,ti,als,ug").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean),
    voice: (env("TTS_VOICE") ?? "Kore").trim(),
    // Characters per request: the client sends a long text in parts (a first short one, for a quick start).
    maxChars: int("TTS_MAX_CHARS", 3000),
    // USD per million tokens, for the spend in the logs. Google doubles them from 2027-01-01 (see TTS_PRICES_2027).
    prices: {
      lite: { text: Number(env("TTS_PRICE_TEXT") ?? 0.5), audio: Number(env("TTS_PRICE_AUDIO") ?? 6) },
      full: { text: Number(env("TTS_FULL_PRICE_TEXT") ?? 0.5), audio: Number(env("TTS_FULL_PRICE_AUDIO") ?? 9) }
    },
    pricesFrom2027: (env("TTS_PRICES_2027") ?? "on").trim() !== "off",
    // Text for listening (/api/v2/speak-script, the owner's note): Claude Haiku rewrites tables, lists, code and
    // symbols into speech before the voice reads it. SPEAK_SCRIPT=off: the device's own rules only. The caps only stop
    // runaway clients (characters a request; requests a day per subscription and for everyone).
    scriptEnabled: (env("SPEAK_SCRIPT") ?? "on").trim() !== "off",
    scriptModel: (env("SPEAK_SCRIPT_MODEL") ?? "claude-haiku-5-5").trim(),
    scriptMaxChars: int("SPEAK_SCRIPT_MAX_CHARS", 6000),
    scriptDaily: int("SPEAK_SCRIPT_DAILY", 400),
    scriptGlobalDaily: int("SPEAK_SCRIPT_GLOBAL_DAILY", 60_000)
  },
  // Quick insert's AI (Claude Haiku 5.5): marking a template's blanks, filling them from the page, finding a
  // template by meaning. The owner's choice: Free fills its blanks with AI 5 times a day (apart from the 5
  // answers), Pro and Own key without a limit; marking and search have no limit for anyone. The caps
  // marked "safety" only stop abuse and runaway clients, nobody sees them.
  insert: {
    model: env("INSERT_MODEL") ?? "claude-haiku-5-5",
    fillFreeDaily: int("INSERT_FILL_FREE_DAILY", 5),
    // Safety: AI fills a day per paid subscription, marks and searches a day per install, and all of them a day.
    fillPaidDaily: int("INSERT_FILL_PAID_DAILY", 1000),
    markDaily: int("INSERT_MARK_DAILY", 300),
    ipDaily: int("INSERT_IP_DAILY", 1000),
    globalDaily: int("INSERT_GLOBAL_DAILY", 60_000),
    // Quick insert's counters accepted per install a day (apart from the funnel's).
    eventDaily: int("INSERT_EVENT_DAILY", 300),
    // USD per million tokens, for the spend in the logs (Claude Haiku 5.5 list prices up to 100K tokens).
    priceIn: Number(env("INSERT_PRICE_IN") ?? 0.1),
    priceOut: Number(env("INSERT_PRICE_OUT") ?? 0.5)
  },
  // Page watch's AI (2.5, the same Haiku as quick insert, INSERT_MODEL): a plan when a watch is made, a judge
  // after a change. The owner's choice: not counted against answers; these caps only stop runaway clients.
  watch: {
    planDaily: int("WATCH_PLAN_DAILY", 100),
    judgeDaily: int("WATCH_JUDGE_DAILY", 30),
    ipDaily: int("WATCH_IP_DAILY", 1000),
    globalDaily: int("WATCH_GLOBAL_DAILY", 40_000)
  },
  // "Find similar" (2.6, Ultra; /api/v2/similar). SIMILAR_ENGINES says which engines people can reach in
  // production: "" (the default: none, the endpoint answers UNAVAILABLE), "a" (ours, checked), "b" (Google,
  // Gemini grounding, shown as is) or "a,b". Off production (deploy previews, `netlify dev`) the evaluation
  // script (tools/similar/eval.mts) reaches both with a token derived from the service key; nothing else does.
  similar: {
    engines: (env("SIMILAR_ENGINES") ?? "").split(",").map((s) => s.trim()).filter((s) => s === "a" || s === "b"),
    planModel: (env("SIMILAR_PLAN_MODEL") ?? "claude-haiku-5-5").trim(),
    searchModel: (env("SIMILAR_SEARCH_MODEL") ?? "claude-haiku-5-5").trim(),
    // Empty: web_search_20260209 (dynamic filtering) on Sonnet and Opus, web_search_20250305 on Haiku.
    searchTool: (env("SIMILAR_SEARCH_TOOL") ?? "").trim(),
    writeModel: (env("SIMILAR_WRITE_MODEL") ?? "claude-sonnet-5-5").trim(),
    // Candidate pages opened per search, and the whole run's time (the function has a minute).
    maxPages: int("SIMILAR_MAX_PAGES", 12),
    // 2.6 speed-up: items streamed to the panel as each passes the checks, and at most two follow-up searches for
    // items named without their own page. Searching stays one call ("single"): the parallel calls ("parallel", one
    // per search) were faster but brought more list pages, and in the 48-page comparison 7 items named from them
    // weren't really on them (0 before), so that part was rolled back.
    searchMode: (env("SIMILAR_SEARCH_MODE") ?? "single").trim() === "parallel" ? "parallel" as const : "single" as const,
    followUps: int("SIMILAR_FOLLOW_UPS", 2),
    // Build 93: what reviewers say about the top items (a review search for those without a rating of their own).
    reviews: (env("SIMILAR_REVIEWS") ?? "on").trim() !== "off",
    // Build 94: before saying an item lacks something, the brand's other models on its site (SIMILAR_SIBLINGS=off: none).
    siblings: (env("SIMILAR_SIBLINGS") ?? "on").trim() !== "off",
    streamItems: (env("SIMILAR_STREAM") ?? "on").trim() !== "off",
    // Near them: a shop abroad's delivery page is read before it's offered; one that ships only elsewhere is dropped.
    // Off by default (SIMILAR_SHIP_CHECK=on: read). `shipsTo` now reads refusals and country names in any form, but on
    // delivery pages it hadn't seen it still said "ships there" wrongly about one time in eight (shops' service tiers,
    // boilerplate, navigation text): not reliable enough to tell a person a shop delivers.
    shipCheck: (env("SIMILAR_SHIP_CHECK") ?? "off").trim() === "on",
    // A second search call beside the plan's, from the start, for things of the same kind (one search), instead of a
    // later round when few were found (SIMILAR_ALT_SEARCH=off: the later round).
    altSearch: (env("SIMILAR_ALT_SEARCH") ?? "on").trim() !== "off",
    budgetMs: int("SIMILAR_BUDGET_MS", 52_000),
    // Pages a site won't open to servers may fill a list that has fewer than 3 checked items (marked "not opened").
    allowUnchecked: (env("SIMILAR_ALLOW_UNCHECKED") ?? "on").trim() !== "off",
    // Safety caps (the Ultra allowance itself comes with the Ultra plan): per install a day, and for everyone.
    installDaily: int("SIMILAR_INSTALL_DAILY", 40),
    globalDaily: int("SIMILAR_GLOBAL_DAILY", 5_000),
    // USD, for the spend in the logs: Anthropic web search per search; Gemini 3.8 Flash per million tokens
    // (to 2026-12-31; $1.50/$7.50 from 2027) and Google Search grounding per query (after 5,000 free a month).
    searchPrice: Number(env("SIMILAR_SEARCH_PRICE") ?? 0.01),
    geminiPriceIn: Number(env("GEMINI_PRICE_IN") ?? 0.75),
    geminiPriceOut: Number(env("GEMINI_PRICE_OUT") ?? 3.75),
    groundingPrice: Number(env("GEMINI_GROUNDING_PRICE") ?? 0.014)
  },
  legacyIpDailyLimit: int("LEGACY_IP_DAILY_LIMIT", 10),

  ipPepper: env("CF_IP_PEPPER") ?? "contextflow-ip-v1",

  // Bearer token for GET /api/v2/admin/usage (the /analytics page). Unset = endpoint disabled.
  adminToken: (env("ADMIN_TOKEN") ?? "").trim(),
  // Own-key usage reports accepted per install per day (they only feed analytics).
  ownKeyReportDailyLimit: int("OWN_KEY_REPORT_DAILY_LIMIT", 1000),
  // Funnel events (app opened, extension switched on) accepted per id per day.
  eventDailyLimit: int("EVENT_DAILY_LIMIT", 30),
  // Requests with feature steps ("use", one step or a batch of up to 25) accepted per id per day.
  useEventDailyLimit: int("USE_EVENT_DAILY", 1000),
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
  appBundleIds: (env("APP_BUNDLE_IDS") ?? "com.contextflow.app").split(",").map((s) => s.trim()).filter(Boolean),

  // Organizing the chats (2.5, Pro, by consent): /api/v2/organize turns message texts into vectors and checks
  // tag candidates, and keeps nothing; /api/v2/status gives the panel and the app the thresholds below.
  // ORGANIZE=off switches the suggestions off everywhere (the devices stop asking).
  organize: {
    enabled: (env("ORGANIZE") ?? "on").trim() !== "off",
    embedModel: (env("ORGANIZE_EMBED_MODEL") ?? "text-embedding-3-small").trim(),
    dims: int("ORGANIZE_DIMS", 256),
    // The tag check: Claude Haiku 5.5, and OpenAI's smallest model when Claude can't answer.
    judgeModel: (env("ORGANIZE_JUDGE_MODEL") ?? "claude-haiku-5-5").trim(),
    judgeFallback: (env("ORGANIZE_JUDGE_FALLBACK") ?? "gpt-5-nano").trim(),
    // Requests a Pro subscriber may make a day (vectors go in batches of up to 128 texts), and all together.
    embedDaily: int("ORGANIZE_EMBED_DAILY", 150),
    tagsDaily: int("ORGANIZE_TAGS_DAILY", 300),
    // Names by topic (2.6): "Name by topic", and checks of a chat's name as its topic changes.
    nameDaily: int("ORGANIZE_NAME_DAILY", 200),
    globalDaily: int("ORGANIZE_GLOBAL_DAILY", 100_000),
    // Calibrating the thresholds (tools/organize/calibrate.mts) on a deploy preview: this token stands in for
    // Pro there, never in production. Set it for the Deploy Previews context only.
    evalToken: (env("ORGANIZE_EVAL_TOKEN") ?? "").trim(),
    // The quality thresholds (src/shared/organize.ts): JSON with any of them, e.g. {"moveT":0.5}.
    thresholds: organizeConfig(parsed(env("ORGANIZE_THRESHOLDS"))),
    // USD per million tokens, for the spend in the logs (text-embedding-3-small; Claude Haiku 5.5 up to 100K).
    embedPrice: Number(env("ORGANIZE_EMBED_PRICE") ?? 0.02),
    judgePriceIn: Number(env("ORGANIZE_JUDGE_PRICE_IN") ?? 0.1),
    judgePriceOut: Number(env("ORGANIZE_JUDGE_PRICE_OUT") ?? 0.5)
  },
  // Site counter (/api/v2/site): visits and App Store taps accepted per address per day, and in all per day.
  siteDailyLimit: int("SITE_DAILY_LIMIT", 300),
  siteGlobalDailyLimit: int("SITE_GLOBAL_DAILY_LIMIT", 20000)
}

/** Product id → plan, for every product we sell (src/shared/plan.ts; the app and App Store Connect match it). */
export const PRODUCTS: Readonly<Record<string, PaidPlan>> = Object.fromEntries(
  (Object.keys(PLAN_PRODUCTS) as PaidPlan[]).flatMap((plan) => PLAN_PRODUCTS[plan].map((id) => [id, plan]))
)

export type { PaidPlan, Plan } from "../../src/shared/plan.ts"
