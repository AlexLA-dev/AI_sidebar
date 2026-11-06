// The site counter on context-flow.app (site/visit.js → /api/v2/site): which source brought a visit to
// which page, and which App Store button was tapped. Only these values are accepted; nothing about the
// visitor, and not the address of the page they came from.

// "site": a move between our own pages (left out of the source reports); "direct": no referrer and no utm.
export const SITE_SOURCES = ["chatgpt", "perplexity", "copilot", "gemini", "claude", "bing", "google", "duckduckgo", "other", "direct", "site"] as const
// The indexable pages (sitemap.xml); /analytics is not counted.
export const SITE_PAGES = ["home", "features", "safari_ai", "notes", "compare", "support", "privacy", "terms", "cases", "case_fill", "case_study", "case_shop", "case_plan"] as const
// The ct labels of the App Store buttons (the Smart App Banner reports no taps).
export const SITE_LABELS = ["site_hero", "site_pricing", "site_footer", "page_features", "page_safari_ai", "page_notes", "page_compare", "site_cases", "site_case_fill", "site_case_study", "site_case_shop", "site_case_plan"] as const

export type SiteSource = (typeof SITE_SOURCES)[number]

const has = (list: readonly string[], value: unknown): value is string => typeof value === "string" && list.includes(value)

export const isSiteSource = (value: unknown): value is SiteSource => has(SITE_SOURCES, value)
export const isSitePage = (value: unknown): value is (typeof SITE_PAGES)[number] => has(SITE_PAGES, value)
export const isSiteLabel = (value: unknown): value is (typeof SITE_LABELS)[number] => has(SITE_LABELS, value)
