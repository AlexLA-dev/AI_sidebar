declare const __API_BASE__: string
declare const __VERSION__: string
declare const __TARGET__: "safari" | "chrome"

export const API_BASE = __API_BASE__
export const VERSION = __VERSION__
export const TARGET = __TARGET__

export const SITE = "https://aisidebar.netlify.app"
export const LINKS = {
  privacy: `${SITE}/privacy`,
  terms: `${SITE}/terms`,
  support: `${SITE}/support`,
  appStore: "https://apps.apple.com/app/id6759115793",
  review: "https://apps.apple.com/app/id6759115793?action=write-review",
  // Shared answers end with this link (no storefront, so it opens the reader's own App Store).
  appStoreShare: "https://apps.apple.com/app/contextflow-ai-web-assistant/id6759115793",
  manageSubscriptions: "https://apps.apple.com/account/subscriptions",
  openAiKeys: "https://platform.openai.com/api-keys",
  anthropicKeys: "https://platform.claude.com/settings/keys"
}

// Matches the products in App Store Connect.
export const PRODUCTS = {
  pro: ["com.contextflow.pro.monthly", "com.contextflow.pro.yearly"],
  byok: ["com.contextflow.byok.monthly"]
} as const
