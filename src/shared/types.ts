import type { Attachment, MediaKind } from "./attachments.ts"
import type { ChatDigest } from "./history.ts"
import type { OrganizeConfig } from "./organize.ts"
import type { RenewalReason } from "./renewal.ts"
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
  // An Own key subscriber can move to Pro at this discount (the app asks the server to sign the offer).
  upgradeOffer: { discount: number } | null
  // Google search allowances (free a day, Pro a week), for what the panel tells Own key subscribers.
  searchLimits: { freeDaily: number; proWeekly: number }
  // What the device's App Store account says (may be ahead of the server).
  // autoRenew: false when the user turned auto-renew off (null: not known); period and renewalAsked: the
  // question "what was missing" is asked once per subscription period, in the app or the panel.
  // byokRefusedAt: an Own key subscriber's first refusal (a limit, or a Pro-only feature) in this period, in the
  // app or the panel; a day later Pro at a discount is offered, once per period (byokOfferShown).
  store: {
    active: boolean; productId: string | null; expiresAt: string | null; autoRenew: boolean | null; period: string | null; renewalAsked: boolean
    byokRefusedAt: number | null; byokOfferShown: boolean
  } | null
  hasOwnKey: boolean
  ownKeyProvider: "openai" | "anthropic" | null
  offline: boolean
  // Organizing the chats (2.5): switched on on the server, the vector space and the thresholds; null offline.
  organize: { on: boolean; space: string; config: OrganizeConfig } | null
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
  // How big the chat is (its messages and pages) and how many chats this device keeps: no text, for
  // /analytics to show whether the limits on them get in the way.
  stats?: ChatStats
}

/** Where an Own key subscriber met Pro: a refusal (answers, Google, a Pro-only feature), the discount card, Settings. */
export type UpsellWhere = "limit" | "search" | "pro_only" | "offer" | "settings"

export interface ChatStats {
  turns: number
  pages: number
  chats: number
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
  // weight: the page is long and the answers left don't cover it (2.5).
  | { type: "error"; code: ErrorCode; message?: string; usage?: Usage | null; plan?: Plan; offer?: ProOffer | null; weight?: number }

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
  // feature "organize": on organizing the chats (2.5).
  | { type: "openApp"; target: "subscribe" | "manage" | "home"; feature?: "ai" | "organize" }
  // The line under a free answer that skipped the page's video or PDFs: shown, or its "Try Pro" tapped.
  | { type: "mediaNotice"; action: "shown" | "pro"; media: MediaKind[] }
  // An Own key subscriber and Pro: a refusal (starts the day before the discount), the discount card shown, a tap.
  | { type: "byokUpsell"; action: "refused" | "shown" | "tap"; where: UpsellWhere; period: string | null; discount?: boolean }
  // A Pro user with auto-renew off answered "what was missing" (or put it off): logged, not asked again this period.
  | { type: "renewalAnswer"; reason: RenewalReason; period: string; productId: string | null; expiresAt: string | null }
  | { type: "inject" }
  | { type: "setOwnKey"; key: string }
  | { type: "openUrl"; url: string }
  // A page of the chat: its tab if it's open, else a new tab.
  | { type: "openPage"; url: string }
  // The panel opened: sync threads with iCloud (Safari); answers { changed }.
  | { type: "syncThreads" }
  // AI search over the chats (Pro); answers a FindReply.
  | { type: "find"; query: string; chats: ChatDigest[] }
  // Organizing (2.5, Pro, with suggestions on): the suggestions for a chat now; answers an OrganizeReply.
  | { type: "organize"; chat: string }
  // Organizing: a suggestion shown, taken, turned down or undone; a promotion shown or tapped; suggestions
  // switched on or declined. Counts only, never text.
  | { type: "organizeEvent"; event: OrganizeEvent }
  // The text of a PDF (read on the device); answers a PdfResult.
  | { type: "pdfText"; url: string }
  // The same for a PDF the page fetched itself (base64; behind a sign-in).
  | { type: "pdfBytes"; url: string; data: string }
  // A reminder on an answer or a note (2.5): a local notification on this device (Safari); answers
  // { outcome: "scheduled" | "denied" | "not-asked" | "failed" | "unavailable" }. `at` null: cancel it.
  | { type: "remind"; chat: string; message: string; at: number | null; title?: string; body?: string; url?: string; ask?: boolean }
  // Chat UX counts (2.5), no text: see UX_KINDS in netlify/functions/v2-event.mts.
  | { type: "uxEvent"; kind: "ux_mark" | "ux_pin" | "ux_delete" | "ux_remind" | "ux_menu" | "ux_later"; action: string; what?: string; how?: string; preset?: string; n_remind?: number; n_watch?: number }

/** A PDF's text, or why there is none ("none": nothing to read, e.g. scanned pages). */
export type PdfResult =
  | { ok: true; text: string; pages: number; title: string }
  | { ok: false; reason: "none" | "failed"; error: string }

export type ContentRequest = { type: "toggle" } | { type: "open"; selection?: boolean }

/** What organizing suggests for a chat now: a move (to a chat, or a new one) and a tag per message. */
export type OrganizeReply =
  | {
      ok: true
      move: { start: number; end: number; to: string | null; toName: string; why: "page" | "site" | "topic" | "apart"; count: number } | null
      // A suggested tag for the message at `index` (its key, to check it's still that message).
      tags: Array<{ index: number; key: string; tag: string }>
    }
  | { ok: false; code: "OFF" | "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" }

/** Organizing events for /api/v2/event (src/background/organize.ts sends them). */
export type OrganizeEvent =
  | { kind: "organize"; action: "shown" | "accepted" | "dismissed" | "undone"; what: "move" | "new" | "tag"; why?: "page" | "site" | "topic" | "apart" }
  | { kind: "organize_promo"; action: "shown" | "tap"; where: "pro_card" | "inchat_mess" | "third_tag" | "first_win" | "settings" }
  | { kind: "organize_optin"; action: "accepted" | "declined"; from: "card" | "settings" }

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
  // The subscription period the auto-renew question was last asked in (also kept in the app for both).
  renewalAsked: "cf:renewalAsked",
  // Own key: the first refusal in a subscription period ({period, at}) and the period the discount was shown in.
  byokRefused: "cf:byokRefused",
  byokOfferShown: "cf:byokOfferShown",
  ownKey: "cf:ownKey",
  // Provider model lists for the own key ({ openai?: { ids, at }, anthropic?: { models, at } }).
  ownKeyModels: "cf:ownKeyModels",
  platform: "cf:platform",
  // Organizing (2.5), this device only: a vector per message ({space, v: {[entryKey]: "textKey:packed"}}),
  // the tag checks' answers ({[hash]: tags}), and the cards about it already shown or closed.
  orgVectors: "cf:orgVectors",
  orgVerdicts: "cf:orgVerdicts",
  orgCards: "cf:orgCards"
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
  // Suggestions (2.5, Pro): a better chat for a block, one of the user's tags. Off until the user turns them on:
  // turning them on is the consent to send the messages' text for it.
  organize: boolean
  // Sharing an answer from the panel (text only): its highlights wrapped in **…** (2.5). Off: plain text.
  shareMarks: boolean
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
  wholeChat: false,
  organize: false,
  shareMarks: false
}

/** AI search's answer: the matching chats with a reason, or why there are none. */
export type FindReply =
  | { ok: true; results: Array<{ id: string; why: string }>; usage: Usage | null }
  | { ok: false; code: ErrorCode; usage?: Usage | null; offer?: ProOffer | null }
