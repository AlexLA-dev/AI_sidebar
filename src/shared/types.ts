import type { Attachment, MediaKind } from "./attachments.ts"
import { COPIED_DEFAULT_ON } from "./copied.ts"
import type { ChatDigest } from "./history.ts"
import type { OrganizeConfig } from "./organize.ts"
import type { RenewalReason } from "./renewal.ts"
// Messages exchanged between the content script (UI) and the background worker.

import type { PaidPlan, Period, Plan } from "./plan.ts"
import type { OrgState } from "./threads.ts"
export type { Plan } from "./plan.ts"
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
  // Build 93: the country the server saw the request come from (two letters), for Find similar's "near me".
  country?: string
  usage: Usage | null
  // A free install that ran out of free answers on an earlier day, and the offer for it (from the server).
  limitedBefore: boolean
  offer: ProOffer | null
  // An Own key subscriber can move to Pro at this discount (the app asks the server to sign the offer).
  upgradeOffer: { discount: number } | null
  // Google search allowances (free a day, Pro a week), for what the panel tells Own key subscribers.
  searchLimits: { freeDaily: number; proWeekly: number }
  // 2.6: an Ultra subscriber's week of read aloud (seconds) and find similar (searches); null for other plans or
  // offline. plans: the allowances the plans sheet names, from the server (defaults offline).
  ultra: { speak: Usage | null; similar: Usage | null } | null
  plans: PlanFacts
  // What the device's App Store account says (may be ahead of the server).
  // autoRenew: false when the user turned auto-renew off (null: not known); period and renewalAsked: the
  // question "what was missing" is asked once per subscription period, in the app or the panel.
  // byokRefusedAt: an Own key subscriber's first refusal (a limit, or a Pro-only feature) in this period, in the
  // app or the panel; a day later Pro at a discount is offered, once per period (byokOfferShown).
  store: {
    active: boolean; productId: string | null; expiresAt: string | null; autoRenew: boolean | null; period: string | null; renewalAsked: boolean
    byokRefusedAt: number | null; byokOfferShown: boolean
    // The App Store's prices on this device (product id → "$12.99"), as the app last loaded them; {} until it has.
    prices: Record<string, string>
    // Build 90: the last plan that started on this device (bought, upgraded, changed at renewal), for onboarding to
    // its features; null when none was seen.
    planChange: { from: string; to: string; productId: string; at: number } | null
  } | null
  hasOwnKey: boolean
  ownKeyProvider: "openai" | "anthropic" | null
  offline: boolean
  // Organizing the chats (2.5): switched on on the server, the vector space and the thresholds; null offline.
  organize: { on: boolean; space: string; config: OrganizeConfig } | null
}

/** What each plan gives, for the plans sheet (2.6): the server's numbers. */
export interface PlanFacts {
  freeDaily: number
  proWeekly: number
  ultraWeekly: number
  searchProWeekly: number
  speakWeeklySeconds: number
  similarWeekly: number
  watch: Record<Plan, number>
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
  // Asked during the guided first request (2.6): not counted against the free answers, for an install's first few.
  tour?: true
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
  // An Ultra feature asked for without Ultra (Find similar; read aloud has its own channel).
  | "ULTRA_ONLY"
  // No consent for the current text yet: nothing was sent.
  | "CONSENT"

export type BackgroundRequest =
  | { type: "status"; refresh?: boolean; fresh?: boolean; platform?: Platform }
  // 2.6 (91): a Tips clip from the app (App Group) for the clip page.
  | { type: "tipClip"; name: string; lang: string }
  // Build 91: the jobs the background is running now (ids), to follow one again after the panel was closed.
  | { type: "liveJobs" }
  // …and the panel showed this chat: its jobs' outcomes were seen (the chats list's and the floating button's dot go).
  | { type: "jobsSeen"; thread: string }
  // feature "ai": the Pro screen opens on AI search and "Ask your chats".
  // feature "organize": on organizing the chats (2.5).
  // plan, period (2.6): what was chosen in the panel's plans sheet; the app opens on it.
  | { type: "openApp"; target: "subscribe" | "manage" | "home"; feature?: "ai" | "organize" | "listen" | "watch"; plan?: PaidPlan; period?: Period }
  // Read aloud on iPhone and iPad (2.6): the parts go to the app (App Group), which plays them with the screen
  // locked; answers { url } (contextflow://listen?id=…) for the page to follow, or { url: null } (no app).
  // text, script (2.6): the raw text and whether the app should write it for the ear first (parts: when it can't).
  // id: made by the panel, so the contextflow:// link can be followed during the tap itself (build 91).
  | { type: "listenInApp"; id: string; parts: string[]; text: string; script: boolean; lang: string; what: "answer" | "page"; title: string; url: string }
  // "Delete all chats": the audio and the texts for listening kept on this device go too.
  | { type: "speechClear" }
  // Notifications for ContextFlow on this device (Safari: "authorized", "denied", "notDetermined"…; elsewhere none).
  | { type: "notifStatus" }
  // Read aloud playing in the panel on iPhone and iPad (2.6): what the app needs to carry on from the same second
  // ("state", as it plays), the page went away ("away": the notification now), came back ("back"), or it stopped.
  | { type: "listenHandoff"; op: "state" | "away" | "back" | "stop"; id: string; at?: number; starts?: number[]; parts?: string[]; complete?: boolean; speed?: number; title?: string; body?: string }
  // Back on the page after a hand-off (build 93): whether the app sent the person back for this text ("Back to Safari",
  // or notifications just turned on: then `play` it here), and whether the app has taken it over.
  | { type: "listenReturn"; id: string }
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
  // "Name by topic" (2.6, with suggestions on): a name for the chat by its topic; answers an OrganizeNameReply.
  | { type: "organizeName"; chat: string }
  // The chats list (2.6, Pro, with suggestions on): how many open suggestions each chat has; answers an OrganizeCountsReply.
  | { type: "organizeCounts" }
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
  | { type: "uxEvent"; kind: "ux_mark" | "ux_pin" | "ux_delete" | "ux_remind"; action: string; what?: string; how?: string; preset?: string }
  // A step for the feature counters: the analytics registry's "use" kind (src/shared/usage.ts), named values only.
  | { type: "useEvent"; f: "menu" | "later" | "tour" | "bubble" | "listen" | "plans" | "chat_plans"; a: string; what?: string; via?: string; reminders?: string; watches?: string; plan?: string; period?: string; heard_s?: number; cache_s?: number; icloud_s?: number; server_s?: number; charged_s?: number; cur?: string; sf?: string }

/** A PDF's text, or why there is none ("none": nothing to read, e.g. scanned pages). */
export type PdfResult =
  | { ok: true; text: string; pages: number; title: string }
  | { ok: false; reason: "none" | "failed"; error: string }

export type ContentRequest = { type: "toggle" } | { type: "open"; selection?: boolean }

/** What organizing suggests for a chat now: a move (to a chat, or a new one) and a tag per message. */
export type OrganizeReply =
  | {
      ok: true
      // `match`: how well it fits there, in % (a move by topic or site, 2.6 (93)).
      move: { start: number; end: number; to: string | null; toName: string; why: "page" | "site" | "topic" | "apart"; count: number; match?: number } | null
      // A suggested tag for the message at `index` (its key, to check it's still that message).
      tags: Array<{ index: number; key: string; tag: string }>
      // 2.6: the chat's name no longer fits its topic (and the user didn't type it): this one would. A suggestion, like a
      // tag or a move (2.6 (91): the owner wants to OK each rename).
      name?: string
      // 2.6 (93): what was worked out, for the panel to keep with the chat (it syncs with it: other devices show it at
      // once, and know what was turned down).
      org?: OrgState
    }
  | { ok: false; code: "OFF" | "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" }

export type OrganizeCountsReply = { ok: true; counts: Record<string, number> } | { ok: false; code: "OFF" | "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" }

export type OrganizeNameReply = { ok: true; name: string } | { ok: false; code: "OFF" | "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" }

/** Organizing events for /api/v2/event (src/background/organize.ts sends them). */
export type OrganizeEvent =
  | { kind: "organize"; action: "shown" | "accepted" | "dismissed" | "undone"; what: "move" | "new" | "tag"; why?: "page" | "site" | "topic" | "apart" }
  // 2.6: the chat named by its topic: "Name by topic" (asked), or a suggested name ("drift": its name no longer fit)
  // shown, taken, turned down; either undone.
  | { kind: "organize"; action: "shown" | "accepted" | "dismissed" | "undone"; what: "name"; why: "asked" | "drift" }
  // 2.6: "N recommendations" on a chat in the list, shown (once per chat) and tapped.
  | { kind: "organize"; action: "shown" | "tap"; what: "badge" }
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
  // Build 91: the questions the background is answering, and how the last ones ended (Jobs by question id, jobs.ts).
  jobs: "cf:jobs",
  // Build 92: the app's last answer about the subscription ({ value, at }), for when the app doesn't answer.
  lastEntitlement: "cf:lastEntitlement",
  // Build 91: the free chats that had the memory message once (chat ids, the latest last).
  memoryOffered: "cf:memoryOffered",
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
  // 2.6: the plan the panel saw last (an upgrade from it starts that plan's tour) and the plans whose tour was shown.
  planLast: "cf:planLast",
  planTours: "cf:planTours",
  // The "first time here" hints already shown (chats, video, pdf).
  hintsSeen: "cf:hintsSeen",
  // Read aloud's speed (build 90): 1, 1.2, 1.5 or 2.
  listenSpeed: "cf:listenSpeed",
  // The Settings line about switching to yearly, hidden until then (ms).
  yearlyHiddenUntil: "cf:yearlyHiddenUntil",
  // "Not now" to notifications at Listen (iPhone, iPad): Listen opens the app without asking until this time.
  listenNotifyLater: "cf:listenNotifyLater",
  // The App Store's prices the last time the app's side gave them (build 92): the plans sheet's when none come.
  lastPrices: "cf:lastPrices",
  // Notifications on for ContextFlow, as the app's side last said (build 92): Listen decides from it inside the tap.
  notifyOn: "cf:notifyOn",
  // iPhone, iPad (build 93): the last hand-off of Listen to the app, so coming back from it ("Back to Safari", or once
  // notifications are on) brings the panel back as it was.
  listenBack: "cf:listenBack",
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
  // Answer with the whole chat in mind (all messages, notes, its other pages), not just the last messages. Before
  // build 91 the switch itself; read no more (it was off by default, so it can't tell who chose off).
  wholeChat: boolean
  // Build 91: the whole chat is Pro's memory, on unless the person turns it off (Pro and Ultra; free answers see the
  // last messages, and the switch offers Pro).
  chatMemory: boolean
  // Build 93: where Find similar looks — anywhere, or near them (their country); asked the first time, then kept.
  similarRegion?: "world" | "local"
  // Suggestions (2.5, Pro): a better chat for a block, one of the user's tags. Off until the user turns them on:
  // turning them on is the consent to send the messages' text for it.
  organize: boolean
  // Sharing an answer from the panel (text only): its highlights wrapped in **…** (2.5). Off: plain text.
  shareMarks: boolean
  // Quick insert's two switches, shown in the app too ("On web pages"): the button by fields (iPhone and iPad)
  // and keeping what's copied on pages for its list. Its other settings stay on this device (cf:insert).
  insertButton: boolean
  keepCopied: boolean
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
  chatMemory: true,
  organize: false,
  shareMarks: false,
  insertButton: true,
  keepCopied: COPIED_DEFAULT_ON
}

/** AI search's answer: the matching chats with a reason, or why there are none. */
export type FindReply =
  | { ok: true; results: Array<{ id: string; why: string }>; usage: Usage | null }
  | { ok: false; code: ErrorCode; usage?: Usage | null; offer?: ProOffer | null }
