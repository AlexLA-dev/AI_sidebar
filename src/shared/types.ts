// Messages exchanged between the content script (UI) and the background worker.

export type Plan = "free" | "pro" | "byok"
export type Platform = "ios" | "ipados" | "macos" | "chrome" | "other"

export interface Usage {
  used: number
  limit: number
  period: "day" | "week"
  resetsAt: string
}

export interface StatusInfo {
  plan: Plan
  usage: Usage | null
  // What the device's App Store account says (may be ahead of the server).
  store: { active: boolean; productId: string | null; expiresAt: string | null } | null
  hasOwnKey: boolean
  ownKeyProvider: "openai" | "anthropic" | null
  offline: boolean
}

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface AskPayload {
  messages: ChatTurn[]
  page: { kind: "page" | "selection"; title: string; url: string; text: string } | null
  action?: string
  // "google": answer with Google Search grounding (always through our server).
  mode?: "google"
}

export interface GroundingSource {
  title: string
  url: string
}

/** What a Google-grounded answer comes with; Google's terms require showing it with the answer. */
export interface Grounding {
  sources: GroundingSource[]
  // Google's "Search Suggestions" snippet (HTML + CSS), rendered as provided.
  suggestions: string
  queries: string[]
}

/** Outcome of an answer with the user's own key, reported to our server for analytics (counters only). */
export interface OwnKeyUsage {
  provider: "openai" | "anthropic"
  model: string
  ok: boolean
  error?: ErrorCode | "STOPPED"
  promptTokens: number
  completionTokens: number
}

export type StreamEvent =
  | { type: "meta"; plan: Plan; usage: Usage | null; viaOwnKey: boolean }
  | { type: "delta"; text: string }
  // Sent once before "done" for Google answers: the final text with citation links, and its sources.
  | { type: "grounding"; text: string; grounding: Grounding }
  | { type: "done"; usage: Usage | null }
  | { type: "error"; code: ErrorCode; message?: string; usage?: Usage | null; plan?: Plan }

export type ErrorCode =
  | "LIMIT_REACHED"
  | "BUSY"
  | "UPSTREAM"
  | "NETWORK"
  | "STREAM"
  | "EMPTY"
  | "BAD_KEY"
  | "UNAVAILABLE"
  | "BAD_REQUEST"
  | "SEARCH_LIMIT"
  | "SEARCH_UNAVAILABLE"

export type BackgroundRequest =
  | { type: "status"; refresh?: boolean; platform?: Platform }
  | { type: "openApp"; target: "subscribe" | "manage" | "home" }
  | { type: "inject" }
  | { type: "setOwnKey"; key: string }
  | { type: "openUrl"; url: string }

export type ContentRequest = { type: "toggle" } | { type: "open"; selection?: boolean }

export const STORAGE = {
  installId: "cf:installId",
  settings: "cf:settings",
  chats: "cf:chats",
  consent: "cf:consent",
  ownKey: "cf:ownKey",
  // Provider model lists for the own key ({ openai?: { ids, at }, anthropic?: { models, at } }).
  ownKeyModels: "cf:ownKeyModels",
  platform: "cf:platform"
} as const

export interface Settings {
  fab: "auto" | "on" | "off"
  fabHiddenSites: string[]
  fabSide: "left" | "right"
  fabY: number // percent of viewport height
  selectionButton: boolean
  textSize: "normal" | "large"
  theme: "auto" | "light" | "dark"
  aboutMe: string
  // Model class used with the user's own key: newest Haiku / GPT mini or newest Sonnet / GPT.
  ownKeyModel: "fast" | "smart"
}

export const DEFAULT_SETTINGS: Settings = {
  fab: "auto",
  fabHiddenSites: [],
  fabSide: "right",
  fabY: 72,
  selectionButton: true,
  textSize: "normal",
  theme: "auto",
  aboutMe: "",
  ownKeyModel: "smart"
}
