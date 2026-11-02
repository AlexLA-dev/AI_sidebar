import type { Attachment, MediaKind } from "./attachments.ts"
import type { ChatDigest } from "./history.ts"
// Messages exchanged between the content script (UI) and the background worker.

export type Plan = "free" | "pro" | "byok"
export type Platform = "ios" | "ipados" | "macos" | "chrome" | "other"

export interface Usage {
  used: number
  limit: number
  period: "day" | "week"
  resetsAt: string
}

// The App Store offer code for Pro the server gives a free user who ran out of answers.
export interface ProOffer {
  code: string
  // Percent off the first month.
  discount: number
}

export interface StatusInfo {
  plan: Plan
  usage: Usage | null
  // A free install that ran out of free answers on an earlier day, and the offer for it (from the server).
  limitedBefore: boolean
  offer: ProOffer | null
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
  // attachments: the video's transcript and the PDFs, apart from the text (reading them is Pro);
  // skipped: the page has them but they weren't read (not Pro). media: the text already includes them.
  page: {
    kind: "page" | "selection"
    title: string
    url: string
    text: string
    changed?: boolean
    media?: "video" | "pdf"
    attachments?: Attachment[]
    skipped?: MediaKind[]
  } | null
  action?: string
  // "google": answer with Google Search grounding (always through our server).
  mode?: "google"
  // "chat": the whole conversation with the user's notes, and the text of its other pages.
  // "history": "Ask your chats" (Pro) — answered from a digest of all the chats, without a page.
  context?: "chat" | "history"
  pages?: Array<{ title: string; url: string; text: string }>
  history?: ChatDigest[]
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
  | { type: "error"; code: ErrorCode; message?: string; usage?: Usage | null; plan?: Plan; offer?: ProOffer | null }

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
  // A Pro feature asked for without Pro (AI search, "Ask your chats").
  | "PRO_ONLY"
  // No consent for the current text yet: nothing was sent.
  | "CONSENT"

export type BackgroundRequest =
  | { type: "status"; refresh?: boolean; fresh?: boolean; platform?: Platform }
  // feature "ai": the Pro screen opens on AI search and "Ask your chats".
  | { type: "openApp"; target: "subscribe" | "manage" | "home"; feature?: "ai" }
  // The line under a free answer that skipped the page's video or PDFs: shown, or its "Try Pro" tapped.
  | { type: "mediaNotice"; action: "shown" | "pro"; media: MediaKind[] }
  | { type: "inject" }
  | { type: "setOwnKey"; key: string }
  | { type: "openUrl"; url: string }
  // A page of the chat: its tab if it's open, else a new tab.
  | { type: "openPage"; url: string }
  // The panel opened: sync threads with iCloud (Safari); answers { changed }.
  | { type: "syncThreads" }
  // AI search over the chats (Pro); answers a FindReply.
  | { type: "find"; query: string; chats: ChatDigest[] }
  // The text of a PDF (read on the device); answers a PdfResult.
  | { type: "pdfText"; url: string }
  // The same for a PDF the page fetched itself (base64; behind a sign-in).
  | { type: "pdfBytes"; url: string; data: string }

/** A PDF's text, or why there is none ("none": nothing to read, e.g. scanned pages). */
export type PdfResult =
  | { ok: true; text: string; pages: number; title: string }
  | { ok: false; reason: "none" | "failed"; error: string }

export type ContentRequest = { type: "toggle" } | { type: "open"; selection?: boolean }

export const STORAGE = {
  installId: "cf:installId",
  settings: "cf:settings",
  // Per-page chats of 2.0 / 2.1, and the single running conversation of 2.2: read once to seed the threads.
  chats: "cf:chats",
  conversation: "cf:conversation",
  // Chats as threads (Threads by id) and the one this device shows ({ id, at }).
  threads: "cf:threads",
  activeThread: "cf:activeThread",
  // iCloud sync: CloudKit change token, and the time of each thread's copy in iCloud.
  syncToken: "cf:syncToken",
  syncedThreads: "cf:syncedThreads",
  // The ContextFlow app's copy of the chats (App Group): the time of each thread it has.
  mirroredThreads: "cf:mirroredThreads",
  mirroredAt: "cf:mirroredAt",
  // When the settings last changed here (ms), to merge with the app's copy.
  settingsUpdatedAt: "cf:settingsUpdatedAt",
  // Successful answers so far; the app asks for an App Store rating after a few.
  valueMoments: "cf:valueMoments",
  consent: "cf:consent",
  // The first-session tour of the panel was seen (finished or skipped).
  tourSeen: "cf:tourSeen",
  // The "first time here" hints already shown (chats, video, pdf).
  hintsSeen: "cf:hintsSeen",
  // Recent pages' text on this device ({ [url]: { title, text, at } }) for "whole chat" answers.
  pageTexts: "cf:pageTexts",
  // How many times the hint about writing notes with the send button was shown, or -1 once used.
  noteHint: "cf:noteHint",
  // How many page visits showed the hint about the question field and Note by a selection, or -1 once used.
  selHint: "cf:selHint",
  // false from install until the server heard that the extension was switched on (the funnel's step
  // after "app opened"); missing for installs from before 2.4, which never report it.
  extOnPending: "cf:extOnPending",
  // How many times the Pro offer card for installs that ran out of free answers before was shown,
  // or -1 once it was answered.
  offerCard: "cf:offerCard",
  ownKey: "cf:ownKey",
  // Provider model lists for the own key ({ openai?: { ids, at }, anthropic?: { models, at } }).
  ownKeyModels: "cf:ownKeyModels",
  platform: "cf:platform"
} as const

export interface Settings {
  // "auto" (2.0 / 2.1 default, iPhone and iPad only) is read as "on".
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
  // Keep the chats in the user's iCloud to continue them on their other devices (Safari).
  syncChats: boolean
  // The chat list in groups by tag, like folders (a chat with two tags is in both).
  groupByTags: boolean
  // Answer with the whole chat in mind (all messages, notes, its other pages), not just the last messages.
  wholeChat: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fab: "on",
  fabHiddenSites: [],
  fabSide: "right",
  fabY: 72,
  selectionButton: true,
  textSize: "normal",
  theme: "auto",
  aboutMe: "",
  ownKeyModel: "smart",
  syncChats: true,
  groupByTags: false,
  wholeChat: false
}

/** AI search's answer: the matching chats with a reason, or why there are none. */
export type FindReply =
  | { ok: true; results: Array<{ id: string; why: string }>; usage: Usage | null }
  | { ok: false; code: ErrorCode; usage?: Usage | null; offer?: ProOffer | null }
