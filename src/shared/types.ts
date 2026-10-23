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
}

export type StreamEvent =
  | { type: "meta"; plan: Plan; usage: Usage | null; viaOwnKey: boolean }
  | { type: "delta"; text: string }
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
}

export const DEFAULT_SETTINGS: Settings = {
  fab: "auto",
  fabHiddenSites: [],
  fabSide: "right",
  fabY: 72,
  selectionButton: true,
  textSize: "normal",
  theme: "auto",
  aboutMe: ""
}
