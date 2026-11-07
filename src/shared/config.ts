declare const __API_BASE__: string
declare const __VERSION__: string
declare const __TARGET__: "safari" | "chrome"

export const API_BASE = __API_BASE__
export const VERSION = __VERSION__
export const TARGET = __TARGET__

declare const __SHADOW_MODE__: ShadowRootMode | undefined
/** The panel's shadow roots are closed: no page script can read what's in them (Copied, the chats, the answers).
 * Only a test build (CF_OPEN_SHADOW=1, never with the production API) leaves them open for its checks. */
export const SHADOW_MODE: ShadowRootMode = typeof __SHADOW_MODE__ === "string" ? __SHADOW_MODE__ : "closed"

export const SITE = "https://context-flow.app"
export const LINKS = {
  privacy: `${SITE}/privacy`,
  terms: `${SITE}/terms`,
  support: `${SITE}/support`,
  x: "https://x.com/ContextFlowApp",
  threads: "https://www.threads.com/@contextflowapp",
  appStore: "https://apps.apple.com/app/id6759115793",
  review: "https://apps.apple.com/app/id6759115793?action=write-review",
  // Shared answers end with this link (no storefront, so it opens the reader's own App Store).
  appStoreShare: "https://apps.apple.com/app/contextflow-ai-web-assistant/id6759115793",
  manageSubscriptions: "https://apps.apple.com/account/subscriptions",
  openAiKeys: "https://platform.openai.com/api-keys",
  anthropicKeys: "https://platform.claude.com/settings/keys"
}

// Matches the products in App Store Connect (src/shared/plan.ts: Ultra, Pro and Own key, monthly and yearly).
export { PLAN_PRODUCTS as PRODUCTS } from "./plan"
