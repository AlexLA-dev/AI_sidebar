import { Fragment, type ComponentChildren, type VNode } from "preact"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"

import { composePage, readsMedia, type MediaKind } from "../shared/attachments"
import { LINKS, PRODUCTS, SHADOW_MODE, TARGET } from "../shared/config"
import { RENEWAL_REASONS, type RenewalReason } from "../shared/renewal"
import { t, uiLanguage, type MessageKey } from "../shared/i18n"
import {
  DEFAULT_SETTINGS,
  type AskPayload,
  type ErrorCode,
  type Grounding,
  type Platform,
  type Plan,
  type ProOffer,
  type Settings,
  type UpsellWhere,
  type FindReply,
  type StatusInfo,
  type StreamEvent,
  type Usage
} from "../shared/types"
import * as Icon from "./icons"
import { FREE_MEMORY, historyForModel, isQuestion, lastPage, otherPages, pageHasChanged, pageRef, pageWhen, savedPages, selectionNote, stamped, type Entry, type SourceNote } from "../shared/conversation"
import { Markdown } from "./markdown"
import { MAX_OTHER_PAGES, MAX_PAGE_CHARS } from "../shared/prompt"
import { answerWeight } from "../shared/pagefit"
import { answerShareText, chatLanguage, noteCopyText, noteShareText, pickedShareText, textLanguage, toPlainText, type ShareLinks } from "../shared/share"
import type { PageRead, PageSource } from "./context"
import {
  followLink,
  forgetSelection,
  HOST_TAG,
  isTouch,
  MIN_SELECTION_WORDS,
  openAppFromTap,
  privateBrowsing,
  readSelection,
  recentSelection,
  rememberSelection,
  trackSelection,
  type SelectionInfo
} from "./page"
import { Hint } from "./Hint"
import { OrganizeCard, OrganizeRow, panelSelectionStart, type OrganizeMove } from "./Organize"
import { UndoBar } from "./UndoBar"
import { barDeadline, deadlineAfterHold, goesOnWork, type BarKind } from "./undoClock"
import { moveBlock, organizeCards, setOrganizeCards, undoBlockMove, type OrganizeCards } from "./store"
import { DEFAULT_ORGANIZE, looksMixed } from "../shared/organize"
import { entryKey } from "../shared/conversation"
import type { OrganizeCountsReply, OrganizeEvent, OrganizeNameReply, OrganizeReply } from "../shared/types"
import { ProUpsell } from "./ProUpsell"
import { shownPrice, SimilarIcon, SimilarList, SimilarPicker, SimilarUpsell } from "./similar/Similar"
import { factsFrom, SIMILAR_SELECTION_MAX, similarAllowed, similarMarkdown, type SimilarAnswer, type SimilarItem, type SimilarStep, type SimilarStreamEvent } from "../shared/similar"
import { structured } from "../shared/watch/extract"
import { conditionFor } from "./watch/draft"
import { openWatchSheet } from "./watch/WatchSheet"
import { PlansSheet } from "./Plans"
import { PlanOffer, type OfferChoice, type OfferPlace } from "./ux/PlanOffer"
import { ListenBar, SpeakerIcon, useListen } from "./listen/useListen"
import { dodgeFab } from "./fabDodge"
import { hasPro, isUltra, type PaidPlan } from "../shared/plan"
import { SettingsView } from "./Settings"
import { shareLabels } from "./shareLabels"
import { loadJobs, markHintSeen, markMemoryOffered, memoryOffered, onJobsChanged, resetHints, seenHints, type HintKey } from "./store"
import { deleteThread, giveConsent, hasSeenTour, loadConsent, loadSettings, onConsentChanged, loadThreads, markTourSeen, lastPlanSeen, setLastPlanSeen, planToursSeen, markPlanToursSeen, noteHintCount, onSettingsChanged, onThreadsChanged, pageTexts, pinThread, purgeChats, nameThread, rememberPageText, renameThread, renewalAskedPeriod, unnameThread, restoreChat, saveSettings, saveThread, selHintCount, setActiveThread, setThreadTags, offerCardCount, setNoteHintCount, setOfferCardCount, setSelHintCount, trashChat } from "./store"
import { TagChip, TagEditor } from "./Tags"
import { ThreadsView } from "./Threads"
import { TrashView } from "./Trash"
import { starMarks } from "../shared/marks"
import { Bell, More, remindLabel, RemindSheet } from "./ux/MessageUx"
import { PageMenu } from "./ux/PageMenu"
import { bubbleActions, laterSections, laterSources, listsKind, pageRange, pageWatcher, setLaterOpener, type BubbleContext, type LaterContext, type LaterItem } from "./ux/later"
import { reminderOf, reminderRows, withReminderAt } from "./ux/reminderList"
import { watchableAt } from "./watch/at"
import { RemindersSheet } from "./ux/RemindersSheet"
import { TipsSheet } from "./tips/TipsSheet"
import { SelIconsTip } from "./ux/SelTip"
import { shadowSelection, trackPointer } from "./selectionShadow"
import { restoredDraft, withoutStopped } from "./ux/stopped"
import { type Jobs, extendsChat, interruption, repeatsLast, runningThreads, unreadThreads } from "../shared/jobs"
import { scheduleReminder, thisDevice, useMessageUx } from "./ux/useMessageUx"
import { Tour, tourSteps } from "./Tour"
import { languageName, translateTarget } from "./translateTarget"
import { GuideCard, GuidePill, ON_PAGE, PLAN_MENU, PLAN_STEPS, PLAN_VIEW, PRO_TOUR, ULTRA_FULL_TOUR, ULTRA_TOUR, WAITING, type GuideStep } from "./Guide"
import { ConsentCard } from "./Consent"
import { QI_EVENTS, QuickInsert } from "./insert/QuickInsert"
import * as QIcon from "./insert/icons"
import { keepCopied, report as reportInsert } from "./insert/store"
import { insertFromPanel, useButtonShown, useHasField } from "./insert/target"
import { TemplatesView } from "./insert/TemplatesView"
import { allTags, chatDigests, chatList, cleanTags, newThreadId, pageBlocks, pinAt, shownThread, threadPages, threadTitle, trashedThreads, type MoveUndo, type Thread, type Threads } from "../shared/threads"
import type { ChatDigest } from "../shared/history"
import type { ConsentStatus } from "../shared/consent"

export type Bus = EventTarget

type Turn = Entry

// Pro's weekly allowance (PRO_WEEKLY_LIMIT on the server), quoted by the offers.
const PRO_WEEKLY = 375
// An Own key subscriber is offered Pro at a discount this long after the first refusal of the period.
const BYOK_OFFER_AFTER_MS = 24 * 3600_000
const APP_ID = "6759115793"

interface ChatError {
  code: ErrorCode
  message?: string
  usage?: Usage | null
  offer?: ProOffer | null
  // The page is long: an answer about it counts as this many, more than are left (2.5).
  weight?: number
}

interface Action {
  id: string
  label: MessageKey
  prompt: MessageKey
  mode?: "google"
  // In place of the language: Translate into another one than the interface's (2.6, translateTarget.ts), with its label.
  arg?: string
  text?: string
}

const PAGE_ACTIONS: Action[] = [
  { id: "summarize", label: "actSummarize", prompt: "promptSummarize" },
  { id: "key_points", label: "actKeyPoints", prompt: "promptKeyPoints" },
  { id: "explain", label: "actExplain", prompt: "promptExplain" },
  { id: "translate", label: "actTranslate", prompt: "promptTranslate" },
  { id: "google", label: "actGoogle", prompt: "promptGoogle", mode: "google" },
  // 2.6, Ultra: opens Find similar's card (a condition, then the checked list), not a question.
  { id: "similar", label: "actSimilar", prompt: "actSimilar" }
]

const SEL_GOOGLE: Action = { id: "sel_google", label: "actGoogle", prompt: "promptSelGoogle", mode: "google" }

const SELECTION_ACTIONS: Action[] = [
  { id: "sel_explain", label: "actExplain", prompt: "promptSelExplain" },
  { id: "sel_summarize", label: "actSummarize", prompt: "promptSelSummarize" },
  { id: "sel_translate", label: "actTranslate", prompt: "promptSelTranslate" },
  SEL_GOOGLE,
  { id: "sel_improve", label: "actImprove", prompt: "promptSelImprove" },
  { id: "sel_reply", label: "actReply", prompt: "promptReply" },
  // 2.6: Find similar for what the selection describes (Ultra); last, since the Mac buttons pick these by index.
  { id: "sel_similar", label: "selSimilar", prompt: "selSimilar" }
]
const selAction = (id: string) => SELECTION_ACTIONS.find((a) => a.id === id)!

/** The chips in the selection buttons' field on iPhone and iPad (2.6, the owner): the panel's selection actions in his
 * order, without Google (the buttons have their own). */
/** Ultra's actions (2.6, build 90, the owner: "colour Similar so it's clear it's an Ultra feature"): in Ultra's colour
 * (--ultra) everywhere they show, with a small "Ultra" for anyone without it. */
const ULTRA_ACTIONS = new Set(["similar", "sel_similar"])

/** The small "Ultra" on an Ultra action, for someone without Ultra (a tap opens Ultra's card). */
function UltraMark({ show }: { show: boolean }): VNode | null {
  return show ? <span class="cf-ultra-mark">Ultra</span> : null
}

/** The plans, low to high: an upgrade moves up (Own key is below Pro: it has none of Pro's features). */
const PLAN_RANK: Record<string, number> = { free: 0, byok: 1, pro: 2, ultra: 3 }

const SEL_CHIPS = ["sel_summarize", "sel_translate", "sel_similar", "sel_explain", "sel_improve", "sel_reply"]

/**
 * Translate for this text: into the interface's language, or, when the text already is in it, into English (or the
 * person's next language) with a label that says so; null when there's nowhere to translate it (translateTarget.ts).
 */
function translateFor(text: string): Action | null {
  // The language the panel speaks (its messages'), not the browser's: they differ where we have no translation.
  const ui = t("langCode")
  const to = translateTarget(text, ui, navigator.languages ?? [navigator.language])
  const action = selAction("sel_translate")
  if (!to) return null
  if (!to.code) return action
  const name = languageName(to.code, ui)
  return { ...action, arg: name, text: t("selTranslateTo", name) }
}

/** An action as it goes for this selection (Translate may go elsewhere, or not at all). */
function forSelection(action: Action, text: string): Action | null {
  return action.id === "sel_translate" ? translateFor(text) : action
}

function sendBackground<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        void chrome.runtime.lastError
        resolve(response ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}


async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;opacity:0;top:0;left:0"
    document.documentElement.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

function timeUntil(iso: string | undefined): string {
  if (!iso) return t("hours", 24)
  const ms = Math.max(0, Date.parse(iso) - Date.now())
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? t("hours", hours) : t("minutes", Math.max(1, Math.ceil(ms / 60_000)))
}

/** The local time of day a limit resets ("3:00 AM"). */
function clockTime(iso: string | undefined): string {
  const at = iso ? new Date(iso) : new Date(Date.now() + 86_400_000)
  return new Intl.DateTimeFormat(uiLanguage(), { hour: "numeric", minute: "2-digit" }).format(at)
}

/** The App Store's sheet for an offer code, with the code filled in (on a Mac it needs macOS 15). */
function offerUrl(code: string): string {
  return `https://apps.apple.com/redeem?ctx=offercodes&id=${APP_ID}&code=${encodeURIComponent(code)}`
}

// A question whose answer was lost while nobody followed it shows these as they were; anything else as "interrupted".
const RESUMABLE = ["STREAM", "NETWORK", "UPSTREAM", "BUSY", "LIMIT_REACHED"]

function errorText(error: ChatError): string {
  switch (error.code) {
    case "NETWORK":
      return t("errNetwork")
    case "BUSY":
      // A message comes only from the user's own provider (OpenAI or Anthropic), in its own words.
      return error.message ? t("errProvider", error.message) : t("errBusy")
    case "UPSTREAM":
      return t("errUpstream")
    case "STREAM":
    case "EMPTY":
      return t("errInterrupted")
    case "BAD_KEY":
      return t("errBadKey")
    case "SEARCH_LIMIT":
      return t("errSearchLimit")
    case "PRO_ONLY":
      return t("errProOnly")
    case "SEARCH_UNAVAILABLE":
      return t("errSearchUnavailable")
    case "UNAVAILABLE":
      return error.message === "similar" ? t("similarOff") : t("errGeneric")
    case "CONSENT":
      return t("consentNeeded")
    default:
      return t("errGeneric")
  }
}

// The answers to the auto-renew question, as the panel shows them.
const RENEWAL_LABELS: Record<(typeof RENEWAL_REASONS)[number], MessageKey> = {
  price: "renewalPrice", rarely: "renewalRarely", answers: "renewalAnswers", features: "renewalFeatures", free_enough: "renewalFreeEnough", other: "renewalOther"
}

/**
 * The panel. `source`: where questions get their page from (the tab's page, or the PDF a popup is about).
 * `popup`: shown as the whole window of the toolbar popup (on a tab where Safari shows a PDF).
 */
export function App({ platform, bus, source, popup = false }: { platform: Platform; bus: Bus; source: PageSource; popup?: boolean }): VNode {
  const touch = isTouch(platform)
  // The page's text goes into the chat (and iCloud) only for a tab's own page, never in Private Browsing.
  const keepsText = !popup && !privateBrowsing()
  const [open, setOpen] = useState(popup)
  const [visible, setVisible] = useState(popup)
  // "trash": Recently Deleted, opened from the end of the chat list (its back goes to the list).
  const [view, setView] = useState<"chat" | "settings" | "threads" | "templates" | "trash">("chat")
  // Quick insert: the page has a field the user typed in (answers and notes can go there).
  const hasField = useHasField() && !popup
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const [usage, setUsage] = useState<Usage | null>(null)
  const [viaOwnKey, setViaOwnKey] = useState(false)
  // Asked again when it was given for an older text ("old": 2.3 and earlier named OpenAI only).
  const [consent, setConsent] = useState<ConsentStatus>("ok")
  const consentRef = useRef(consent)
  consentRef.current = consent
  const [messages, setMessages] = useState<Turn[]>([])
  // Chats as threads: the list (newest first) and the one shown, which every page and tab continues.
  const [threadList, setThreadList] = useState<Thread[]>([])
  // Recently Deleted (2.5 (83)): the chats there, the last one deleted first.
  const [trashList, setTrashList] = useState<Thread[]>([])
  /** Both lists as they are in `threads`. */
  const showLists = (threads: Threads) => {
    setThreadList(chatList(threads))
    setTrashList(trashedThreads(threads))
  }
  const threadRef = useRef("")
  const [partial, setPartial] = useState<string | null>(null)
  // Before asking: a video's transcript or a PDF being read (shown instead of "Reading the page…").
  const [reading, setReading] = useState<"video" | "pdf" | null>(null)
  // The question being prepared (page still being read); cleared when it's sent or stopped.
  const askToken = useRef<object | null>(null)
  const sendRef = useRef<(base: Turn[], content: string, opts: { label?: string; action?: string; mode?: "google" }, full: PageRead, selection: SelectionInfo | null, history?: ChatDigest[]) => void>(() => undefined)
  // The chat shown is "Ask your chats" (Pro): questions about all the other chats, not the page.
  const [historyMode, setHistoryMode] = useState(false)
  const historyRef = useRef(false)
  const setKind = (kind: Thread["kind"]) => {
    historyRef.current = kind === "history"
    setHistoryMode(kind === "history")
  }
  // "First time here" hints still to show (null until read from storage).
  const [hints, setHints] = useState<HintKey[] | null>(null)
  useEffect(() => void seenHints().then(setHints), [])
  const hintDue = (key: HintKey) => hints !== null && !hints.includes(key) && !touring && tourSeen
  const doneHint = (key: HintKey) => {
    setHints((seen) => [...(seen ?? []), key])
    void markHintSeen(key)
  }
  // What a Pro feature would do, for someone without Pro (from the ✦ search or "Ask your chats").
  const [upsell, setUpsell] = useState<"find" | "history" | null>(null)
  // Find similar (2.6): its card (the condition, or Ultra for someone without it), and the answer as it comes.
  const [similarCard, setSimilarCard] = useState<"pick" | "upsell" | { limit: Usage | null } | null>(null)
  // Build 91: the chat's memory is Pro's — the plans message in the chat, from the switch ("switch") or once a free
  // chat is longer than the messages a free answer remembers ("long").
  const [memoryOffer, setMemoryOffer] = useState<"switch" | "long" | null>(null)
  // The plan as last known (the status, else the plan the panel saw last): what a question's memory is.
  const planKnownRef = useRef<Plan>("free")
  // The card opened from a selection: what was selected, the thing to find alternatives to (the page is context).
  const [similarSubject, setSimilarSubject] = useState<string | null>(null)
  const [similarRun, setSimilarRun] = useState<{ items: SimilarItem[]; step: SimilarStep; pages?: number } | null>(null)
  // 2.6: the plans sheet, open on this plan (Ultra from Listen).
  const [plansOpen, setPlansOpen] = useState<PaidPlan | null>(null)
  const [draft, setDraft] = useState("")
  // The send button writes a note to the chat instead of asking (switched by swiping or scrolling on it).
  const [noteMode, setNoteMode] = useState(false)
  const [noteHint, setNoteHint] = useState(false)
  const [error, setError] = useState<ChatError | null>(null)
  // The Pro offer, shown once more to an install that ran out of free answers before.
  const [offerCard, setOfferCard] = useState(false)
  const [findConsent, setFindConsent] = useState<{ resolve: (agreed: boolean) => void } | null>(null)
  const [pending, setPending] = useState<{ text: string; label?: string; action?: string; mode?: "google"; similar?: string; similarSel?: string } | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [pageReadable, setPageReadable] = useState(true)
  const [wide, setWide] = useState(() => window.innerWidth >= 700)
  const [keyboard, setKeyboard] = useState(0)
  const [bubble, setBubble] = useState<SelectionInfo | null>(null)
  // The selection buttons' own question field, "Saved to the chat" after Note, and the first-time hint.
  const [selDraft, setSelDraft] = useState("")
  const [noteSaved, setNoteSaved] = useState(false)
  const [selHint, setSelHint] = useState(false)
  // The selection buttons' field has the focus: its quick chips step aside (2.6).
  const [selFocus, setSelFocus] = useState(false)
  // The buttons stay while their field is being typed in or a note is being saved, though the page
  // selection is gone (focusing the field clears it) or the page scrolls (iPhone, for the keyboard).
  const selTyping = useRef(false)
  const noteHold = useRef(false)
  const bubbleHeld = () => selTyping.current || noteHold.current
  const [googleMode, setGoogleMode] = useState(false)
  const [streamMode, setStreamMode] = useState<"google" | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)
  // The round button out of the selection buttons' way while they show (fabDodge.ts): its center, in px; null at home.
  const fabRef = useRef<HTMLButtonElement>(null)
  const fabHome = useRef<DOMRect | null>(null)
  const [fabDodge, setFabDodge] = useState<number | null>(null)
  const fabDodgeRef = useRef<number | null>(null)
  fabDodgeRef.current = fabDodge
  // The tour of the panel: shown once, on the first open; Settings can show it again.
  const [tourSeen, setTourSeen] = useState(true)
  const [touring, setTouring] = useState(false)
  const touringRef = useRef(false)
  touringRef.current = touring
  // The guided first request (2.6, Guide.tsx): its step, or null; how it was started; the selection part begun.
  const [guide, setGuide] = useState<GuideStep | null>(null)
  const guideRef = useRef<GuideStep | null>(null)
  guideRef.current = guide
  const guideVia = useRef<"first" | "menu" | "plan" | "plan_menu">("first")
  // A plan's tour (2.6): its steps in order and the plans it covers (marked shown when it ends); null for the first one.
  const planTour = useRef<{ steps: GuideStep[]; plans: string[] } | null>(null)
  // Set where the guide's logic is (after what it reads); used by the panel's earlier hooks.
  const firstGuideRef = useRef<() => boolean>(() => false)
  const startGuideRef = useRef<(via: "first" | "menu") => void>(() => undefined)
  const endGuideRef = useRef<(a: "done" | "skip" | "exit", what?: string) => void>(() => undefined)
  const guideToRef = useRef<(step: GuideStep) => void>(() => undefined)
  const panelRef = useRef<HTMLElement>(null)

  // The page the panel is on now (normalized URL), followed while open for single-page apps.
  const [pageUrl, setPageUrl] = useState(() => source.key())
  const pageUrlRef = useRef(pageUrl)
  const [chatCopied, setChatCopied] = useState(false)
  // Choosing messages to share: the indexes picked, or null when not choosing.
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const partialRef = useRef("")
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loadedRef = useRef(false)
  const openedAt = useRef(0)
  // The chat being loaded as the panel opens: a question typed by the selection waits for it.
  const loadingRef = useRef<Promise<void>>(Promise.resolve())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Organizing (2.5): the bar after a move ("Moved to … · Undo · Open", kind "move"), and after a delete; how long
  // each stays is in undoClock.ts.
  const [undoBar, setUndoBar] = useState<{ text: string; actions: Array<{ label: string; run: () => void }>; kind?: BarKind } | null>(null)
  // 2.5: highlights, swipes, pinned messages, reminders (src/content/ux); a deleted message's Undo is on the same bar.
  const ux = useMessageUx({
    messages,
    setMessages,
    chatId: () => threadRef.current,
    chatTitle: () => threadList.find((x) => x.id === threadRef.current)?.title ?? threadTitle(messages),
    list: listRef,
    touch,
    open,
    send: sendBackground,
    showUndo: (text, undo) => setUndoBar({ text, actions: [{ label: t("orgUndo"), run: () => { setUndoBar(null); undo() } }] })
  })
  // The bell by a selection: "Remind me to come back" (a note with the quote and the page, and a reminder that
  // opens the page).
  // "Remind me about this page" (the header's "…", or watching offering a reminder instead, later.ts): what was
  // selected then.
  const [later, setLater] = useState<{ selection: SelectionInfo | null; range: Range | null } | null>(null)
  const [laterFlash, setLaterFlash] = useState(0)
  // "Reminders" and "Watching" (the header's "…"; "All reminders" in the window; 2.5 (77): two lists, never one):
  // which one is open, the rows (null while loading), and how many of each for the "…".
  const [listOpen, setListOpen] = useState<LaterItem["kind"] | null>(null)
  const [laterList, setLaterList] = useState<LaterItem[] | null>(null)
  const [laterCount, setLaterCount] = useState({ remind: 0, watch: 0 })
  useEffect(() => {
    setLaterOpener((from) => setLater({
      selection: from?.selection ? { text: from.selection, words: from.selection.split(/\s+/).filter(Boolean).length, rect: null, at: Date.now() } : null,
      range: from?.range ?? null
    }))
    return () => setLaterOpener(null)
  }, [])
  // The header's "…" (where Settings was): "Remind me about this page…", the two lists and Settings (2.5).
  const [pageMenu, setPageMenu] = useState(false)
  // "…" → Tips: the app's Tips in a sheet (2.5 (78)).
  const [tipsOpen, setTipsOpen] = useState(false)
  const [remindSaved, setRemindSaved] = useState<number | null>(null)

  // The source learnt something new (the PDF popup: the document's title once it's read).
  const [, setSourceSeen] = useState(0)
  useEffect(() => {
    const onSource = () => setSourceSeen((n) => n + 1)
    window.addEventListener("cf-source", onSource)
    return () => window.removeEventListener("cf-source", onSource)
  }, [])

  const streaming = partial !== null
  const layout = popup ? "popup" : wide ? "side" : "sheet"

  // ------------------------------------------------------------ settings
  useEffect(() => {
    void loadSettings().then(setSettings)
    void loadConsent().then(setConsent)
    void hasSeenTour().then(setTourSeen)
    // Given in another tab: this one knows at once (2.5 (78): its template editor asked again).
    const stopConsent = onConsentChanged(setConsent)
    const stopSettings = onSettingsChanged(setSettings)
    return () => {
      stopConsent()
      stopSettings()
    }
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch }
    setSettings(next)
    void saveSettings(next)
  }, [])

  const endTour = useCallback(() => {
    setTouring(false)
    setTourSeen(true)
    void markTourSeen()
  }, [])

  // ------------------------------------------------------------ status
  const refreshStatus = useCallback(async (refresh = false) => {
    // Fresh every time: answers on the user's other devices count against the same Pro allowance.
    const next = await sendBackground<StatusInfo>({ type: "status", refresh, fresh: true, platform })
    if (next) {
      setStatus(next)
      setUsage(next.usage)
    }
  }, [platform])

  // ------------------------------------------------------------ open/close
  // `captured`: the selection our selection button saw (on iPhone the tap itself clears it).
  const show = useCallback((captured?: SelectionInfo) => {
    openedAt.current = Date.now()
    if (captured) {
      rememberSelection(captured)
      // On iPhone and iPad the system edit menu stays up while text is selected, over our panel.
      if (touch) document.getSelection()?.removeAllRanges()
    }
    const sel = captured ?? recentSelection()
    setSelection(sel)
    setBubble(null)
    setView("chat")
    // The guide's selection steps: Ask AI (or another button by the selection) brings it back into the panel; the
    // ✦ without a selection, back to the card that sends the person to the page.
    if (guideRef.current && ON_PAGE.includes(guideRef.current)) guideToRef.current(captured ? "askSel" : "select")
    setOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }, [touch])

  const hide = useCallback(() => {
    if (popup) {
      window.close()
      return
    }
    setVisible(false)
    setTimeout(() => setOpen(false), 220)
  }, [popup])

  // ------------------------------------------------------------ quick insert
  // "Template" by a selection: the selected text becomes a template (the AI marks its blanks).
  const newTemplate = (sel: SelectionInfo) => {
    setBubble(null)
    if (touch) document.getSelection()?.removeAllRanges()
    bus.dispatchEvent(new CustomEvent(QI_EVENTS.newTemplate, { detail: { text: sel.text, from: "selection" } }))
  }
  // Consent given from quick insert's own card (to fill blanks or mark them).
  const agreeQuietly = useCallback(async () => {
    await giveConsent()
    setConsent("ok")
  }, [])

  useEffect(() => {
    const onToggle = () => (open ? hide() : show())
    const onOpen = () => show()
    bus.addEventListener("toggle", onToggle)
    bus.addEventListener("open", onOpen)
    return () => {
      bus.removeEventListener("toggle", onToggle)
      bus.removeEventListener("open", onOpen)
    }
  }, [bus, open, show, hide])

  // Every time the panel opens: the running conversation (another tab may have continued it),
  // the page as it is now, and fresh status.
  useEffect(() => {
    if (!open) return
    const key = source.key()
    pageUrlRef.current = key
    setPageUrl(key)
    if (!portRef.current) {
      // Show the end of the conversation (and this page's actions under it).
      const scrollToEnd = () => requestAnimationFrame(() => {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
      })
      loadingRef.current = loadThreads().then(({ threads, active }) => {
        loadedRef.current = true
        threadRef.current = active.id
        setKind(threads[active.id]?.kind)
        const entries = threads[active.id]?.m ?? []
        showLists(threads)
        setMessages(entries)
        scrollToEnd()
        // Its last question still being answered (asked before the panel closed), or lost meanwhile (build 91).
        resumeRef.current(entries, active.id)
        // Other devices may have continued a chat (iCloud), or the ContextFlow app asked to continue one
        // here ("Open in Safari"): show it unless something was asked here meanwhile.
        void sendBackground<{ changed: boolean; open?: string | null }>({ type: "syncThreads" }).then(async (result) => {
          if (!result?.changed || portRef.current) return
          const fresh = await loadThreads()
          const asked = result.open ? fresh.threads[result.open] : undefined
          const next = asked && !asked.deleted && asked.m.length ? { id: asked.id, m: asked.m } : shownThread(fresh.threads, fresh.active)
          showLists(fresh.threads)
          setMessages((current) => {
            if (current !== entries) return current
            if (next.id !== threadRef.current) {
              threadRef.current = next.id
              void setActiveThread(next.id)
            }
            setKind(fresh.threads[next.id]?.kind)
            setTimeout(() => resumeRef.current(next.m, next.id), 0)
            return next.m
          })
          scrollToEnd()
        })
      })
    }
    setPageReadable(source.readable())
    void refreshStatus()
    if (!touch) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 250)
  }, [open, refreshStatus, touch, source])

  // Single-page apps: follow URL changes while open (the conversation carries on). Every 3 s while the page shows, and
  // at once on the browser's own navigation events (build 92: every 1.5 s, hidden pages too).
  useEffect(() => {
    if (!open) return
    const check = () => {
      if (document.visibilityState !== "visible") return
      const key = source.key()
      if (key !== pageUrlRef.current) {
        pageUrlRef.current = key
        setPageUrl(key)
        forgetSelection()
        setSelection(null)
        setPageReadable(source.readable())
      }
    }
    const timer = setInterval(check, 3000)
    window.addEventListener("popstate", check)
    window.addEventListener("hashchange", check)
    return () => {
      clearInterval(timer)
      window.removeEventListener("popstate", check)
      window.removeEventListener("hashchange", check)
    }
  }, [open, source])

  // While open: the chat list follows other tabs and devices, and the answer counter other devices.
  useEffect(() => {
    if (!open) return
    const off = onThreadsChanged(() => void loadThreads().then(({ threads, active }) => {
      showLists(threads)
      // An answer the background wrote into the shown chat while this panel didn't follow it (another tab asked, or
      // this one lost the thread of it): it shows (build 91).
      const shown = threads[threadRef.current]
      if (shown && !portRef.current && !askToken.current && extendsChat(shown.m, nowRef.current.messages)) {
        setMessages(shown.m)
        setError(null)
      }
      // The chat shown went to Recently Deleted in another tab or on another device: it goes from here too, as when
      // it's deleted here (not while an answer is coming in).
      if (threads[threadRef.current]?.trashed === undefined || portRef.current || askToken.current) return
      threadRef.current = active.id
      setKind(threads[active.id]?.kind)
      setMessages(threads[active.id]?.m ?? [])
      setError(null)
    }))
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !portRef.current) void refreshStatus()
    }, 30_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [open, refreshStatus])

  // Coming back from the ContextFlow app (e.g. after subscribing) → re-check the plan.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && open) void refreshStatus(true)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [open, refreshStatus])

  // The first time the panel is open and idle: the guided first request where there's a page to summarize (2.6),
  // else the tour of what it can do.
  useEffect(() => {
    if (popup || tourSeen || touring || guideRef.current || !visible || view !== "chat" || streaming || pending) return
    const timer = setTimeout(() => (firstGuideRef.current() ? startGuideRef.current("first") : setTouring(true)), 450)
    return () => clearTimeout(timer)
  }, [popup, tourSeen, touring, visible, view, streaming, pending])

  // Recently Deleted emptied (everything restored or deleted, here or elsewhere): back to the list, where its row goes too.
  useEffect(() => {
    if (view === "trash" && trashList.length === 0) setView("threads")
  }, [view, trashList])

  // The panel open on a chat: its answers that came while it was closed were seen (the dots go, build 91).
  useEffect(() => {
    if (!open || !visible || !loadedRef.current) return
    const thread = threadRef.current
    const timer = setTimeout(() => void sendBackground({ type: "jobsSeen", thread }), 400)
    return () => clearTimeout(timer)
  }, [open, visible, messages])

  // Persist the chat shown.
  useEffect(() => {
    if (!loadedRef.current) return
    const id = threadRef.current
    const kind = historyRef.current ? "history" : undefined
    const timer = setTimeout(() => void saveThread(id, messages, kind), 300)
    return () => clearTimeout(timer)
  }, [messages])

  // ------------------------------------------------------------ layout
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 700)
    window.addEventListener("resize", onResize)
    const vv = window.visualViewport
    const onViewport = () => {
      if (!vv) return
      const covered = window.innerHeight - vv.height - vv.offsetTop
      setKeyboard(covered > 80 ? covered : 0)
    }
    vv?.addEventListener("resize", onViewport)
    vv?.addEventListener("scroll", onViewport)
    return () => {
      window.removeEventListener("resize", onResize)
      vv?.removeEventListener("resize", onViewport)
      vv?.removeEventListener("scroll", onViewport)
    }
  }, [])

  const pickedRef = useRef(picked)
  pickedRef.current = picked
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (touringRef.current) {
        endTour()
        return
      }
      if (guideRef.current) {
        endGuideRef.current("skip")
        return
      }
      if (pickedRef.current) {
        setPicked(null)
        return
      }
      // Escape in a chat's name field only cancels the renaming; in the chat search, it clears the search. (The
      // focused field from our root: from the window, a closed root shows only its host.)
      const field = (panelRef.current?.getRootNode() as ShadowRoot | Document | undefined)?.activeElement as HTMLInputElement | null | undefined
      if (field?.classList?.contains("cf-thread-name") || (field?.closest?.(".cf-search") && field.value)) return
      hide()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, hide, endTour])

  // Keep the newest text in view while streaming (not when a message only got tags: the chat stays put).
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    // The limit's card taller than the view (a long page's, in some languages): its title in view, not its end.
    const card = error ? list.querySelector<HTMLElement>(".cf-card.limit") : null
    if (card && card.offsetHeight > list.clientHeight - 16) {
      list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - 8
    }
  }, [messages.length, partial, error])

  // ------------------------------------------------------------ selection
  /** The page's selection as a range: in the page, or inside a site's open shadow root (LinkedIn's messages). */
  const selectedRange = (): Range | null => shadowSelection(HOST_TAG) ?? pageRange(HOST_TAG)
  // Where the pointer goes down, inside the sites' open shadow roots too: a selection there is read in that root.
  useEffect(() => trackPointer(), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    // On a Mac the button follows a mouse selection of a few words; on iPhone and iPad (no
    // mouseup after a long-press) it appears once the selection stops changing, even for one word.
    const offerButton = () => {
      if (!settingsRef.current.selectionButton || open) return
      const sel = readSelection()
      const vv = window.visualViewport
      const top = vv?.offsetTop ?? 0
      const onScreen = Boolean(sel?.rect && sel.rect.bottom > top && sel.rect.top < top + (vv?.height ?? window.innerHeight))
      // On a Mac a price or a status is a word or two: the bubble shows for it too, with watching's eye (Safari).
      const enough = sel && (sel.words >= (touch ? MIN_SELECTION_WORDS : 3) || (TARGET === "safari" && Boolean(watchableAt(sel.text, selectedRange()))))
      setBubble(sel && onScreen && enough ? sel : null)
    }
    const onSelectionChange = () => {
      // Remember it right away: tapping our button on iPhone clears the selection.
      trackSelection()
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (bubbleHeld()) return
        const sel = readSelection()
        if (open && sel && sel.words >= MIN_SELECTION_WORDS) setSelection(sel)
        if (!sel) setBubble(null)
        else if (touch) offerButton()
      }, touch ? 350 : 250)
    }
    const onMouseUp = (e: MouseEvent) => {
      if (touch) return
      if ((e.target as Element | null)?.closest?.("contextflow-root")) return
      setTimeout(offerButton, 10)
    }
    const onScroll = (e: Event) => {
      if (bubbleHeld()) return
      // A box of the page scrolled (2.6: Gemini's report on an iPhone is a full-screen fixed layer with its own
      // scroller, and the window never scrolls under it): only the one the selection is in moves the buttons.
      const box = e.target
      if (box instanceof Element) {
        const anchor = document.getSelection()?.anchorNode
        if (!anchor || !box.contains(anchor)) return
      }
      setBubble(null)
      clearTimeout(scrollTimer)
      if (touch) scrollTimer = setTimeout(offerButton, 400)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("mouseup", onMouseUp)
    // Capturing: a box's scroll doesn't bubble to the window. Our own lists scroll in our root, out of sight here.
    document.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      clearTimeout(timer)
      clearTimeout(scrollTimer)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("mouseup", onMouseUp)
      document.removeEventListener("scroll", onScroll, true)
    }
  }, [open, touch])

  // ------------------------------------------------------------ chat
  // `entry`: the answer as the background wrote it into the chat (build 91: the same message, its id too).
  const finish = useCallback((history: Turn[], text: string, err: ChatError | null, grounding?: Grounding, entry?: Turn) => {
    portRef.current = null
    askToken.current = null
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    if (entry || text) {
      const next: Turn[] = [...history, entry ?? stamped(grounding ? { role: "assistant", content: text, grounding } : { role: "assistant", content: text })]
      setMessages(next)
      const skipped = skippedFor(next, next.length - 1)
      if (skipped) void sendBackground({ type: "mediaNotice", action: "shown", media: skipped })
      // Right away, not on the debounced save: the user may go to another page as soon as the answer is in.
      void saveThread(threadRef.current, next, historyRef.current ? "history" : undefined)
      memoryNudgeRef.current(next)
    }
    if (err) setError(err)
  }, [])

  // A free chat longer than a free answer remembers: the memory message, once per chat (build 91).
  const memoryNudgeRef = useRef((_entries: Turn[]) => {})
  memoryNudgeRef.current = (entries: Turn[]) => {
    const planNow = statusRef.current?.plan ?? planKnownRef.current
    if (historyRef.current || hasPro(planNow) || (Boolean(statusRef.current?.hasOwnKey) && planNow !== "free")) return
    // More answers and notes than a free answer remembers (build 92: the last 5).
    if (entries.filter((e) => e.role === "assistant" || e.note).length <= FREE_MEMORY) return
    const chat = threadRef.current
    void memoryOffered().then((done) => {
      if (done.includes(chat) || threadRef.current !== chat) return
      void markMemoryOffered(chat)
      setMemoryOffer("long")
    })
  }

  const ask = useCallback((text: string, opts: { label?: string; action?: string; retry?: boolean; mode?: "google" } = {}) => {
    const content = text.trim()
    if (!content || portRef.current || askToken.current) return
    setUndoBar(null)
    setFirstWin(null)
    setMemoryOffer(null)
    if (consent !== "ok") {
      setPending({ text: content, label: opts.label, action: opts.action, mode: opts.mode })
      return
    }
    // The same question again after it was left without an answer (interrupted): it takes that one's place.
    const base = opts.retry || repeatsLast(messages, { content }) ? messages.slice(0, messages.length - 1) : messages
    const url = source.key()
    if (historyRef.current) {
      // "Ask your chats": the question goes with a digest of all the other chats, not the page.
      setMessages([...base, stamped({ role: "user", content, label: opts.label })])
      setDraft("")
      if (inputRef.current) inputRef.current.style.height = "auto"
      setError(null)
      setPartial("")
      setStreamMode(null)
      partialRef.current = ""
      const token = {}
      askToken.current = token
      const current = threadRef.current
      void loadThreads().then(({ threads }) => {
        if (askToken.current !== token) return
        const history = chatDigests(Object.values(threads).filter((th) => th.id !== current), { perChat: 2_500, perAnswer: 500, total: 55_000 })
        sendRef.current(base, content, { label: opts.label, action: opts.action }, { title: "", text: "", sources: [] }, null, history)
      })
      return
    }
    // The question shows at once; a video's transcript or a PDF may take a few seconds to read.
    const shown: Turn = stamped({ role: "user", content, label: opts.label, page: { url, title: source.title(), at: Date.now() } })
    if (opts.mode) shown.mode = opts.mode
    setMessages([...base, shown])
    setDraft("")
    if (inputRef.current) inputRef.current.style.height = "auto"
    setError(null)
    setOfferCard(false)
    setPartial("")
    setStreamMode(opts.mode ?? null)
    partialRef.current = ""
    const token = {}
    askToken.current = token
    // A selection or a Google search doesn't need the transcript or the PDFs.
    const whole = !selection && opts.mode !== "google"
    const quick = (): PageRead => ({ ...source.quick(), sources: [] })
    // The video and PDFs are read for plans with them (Pro); otherwise the question says the page has them.
    const plan = statusRef.current ? Promise.resolve(statusRef.current) : sendBackground<StatusInfo>({ type: "status", platform })
    // The page as it is now: read fresh for every question, so new content is always in the request.
    const reading = whole
      ? plan.then((now) => {
          const media = readsMedia(now, TARGET)
          if (askToken.current === token) setReading(media ? source.pending() : null)
          return source.read(media)
        }).catch(quick)
      : Promise.resolve(quick())
    void reading.then((full) => {
      if (askToken.current !== token) return // stopped meanwhile
      setReading(null)
      sendRef.current(base, content, opts, full, selection)
    })
  }, [consent, messages, platform, selection, source])

  // "Fit to the message" from quick insert: an ordinary answer (counts like one), the template as its start.
  // Quick insert's rewrite: the whole template for this page, with the conversation around the field when there's one
  // (2.5 (81): not a name from the list of other conversations).
  const adaptTemplate = (text: string, conversation: string | null) => {
    show()
    const prompt = t("qiAdaptPrompt", text) + (conversation ? `\n\n${t("qiAdaptConversation", conversation)}` : "")
    setTimeout(() => ask(prompt, { label: t(conversation ? "qiAdaptChat" : "qiAdaptLabel") }), 120)
  }

  /** Sends a question with the page as `full` (sources: what was read along with it) or the selection. */
  sendRef.current = (base, content, opts, full, selection, chats) => {
    const url = source.key()
    // The model gets all of the page (2.5); its fingerprint and the saved text are still its first
    // MAX_PAGE_CHARS, so a chat's "the page has changed" and the app's saved page stay as they were.
    const start = full.text.slice(0, MAX_PAGE_CHARS)
    const ref = pageRef(base, url, full.title, start, keepsText)
    const changed = !chats && pageHasChanged(base, url, ref.hash!)
    const user: Turn = stamped(chats ? { role: "user", content, label: opts.label } : { role: "user", content, label: opts.label, page: ref }, ref.at)
    if (!chats) void rememberPageText(url, full.title, full.attachments ? composePage(start, full.attachments) : start)
    if (opts.mode) user.mode = opts.mode
    if (changed) user.pageChanged = true
    if (full.sources.length) user.sources = full.sources
    if (full.skipped?.length) user.skipped = full.skipped
    const history: Turn[] = [...base, user]
    setMessages(history)

    const page: AskPayload["page"] = chats ? null : selection
      ? { kind: "selection", title: source.title().slice(0, 300), url: source.href(), text: selection.text }
      : full.text || full.attachments || full.skipped
        ? { kind: "page", title: full.title, url: source.href(), text: full.text, changed, ...(full.attachments ? { attachments: full.attachments } : {}), ...(full.skipped ? { skipped: full.skipped } : {}) }
        : null
    // The question is in the chat before it goes: the background writes the answer after it (build 91).
    const thread = threadRef.current
    const saved = saveThread(thread, history, historyRef.current ? "history" : undefined).catch(() => undefined)
    const job = { id: user.id!, thread }
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: "chat" })
    } catch {
      finish(history, "", { code: "NETWORK" })
      return
    }
    portRef.current = port
    listenChat(port, history)
    // Sizes only, for /analytics: whether keeping 40 messages, 50 chats or a few pages gets in the way.
    const stats = { turns: history.length, pages: threadPages(history).length, chats: threadList.length }
    if (chats) {
      void saved.then(() => {
        if (portRef.current === port) port.postMessage({ type: "ask", job, payload: { messages: historyForModel(history, url), page: null, action: opts.action, context: "history" as const, history: chats, stats } })
      })
      return
    }
    // The whole chat (its messages, notes and other pages) is Pro's memory, on unless turned off; free answers see the
    // last messages (build 91).
    const planNow = statusRef.current?.plan ?? planKnownRef.current
    // …and the own key's, whose subscriber pays the model.
    const ownKeyNow = Boolean(statusRef.current?.hasOwnKey) && planNow !== "free"
    const wholeChat = (hasPro(planNow) || ownKeyNow) && settingsRef.current.chatMemory !== false
    // Free: the last 5 answers and notes (build 92).
    const free = !hasPro(planNow) && !ownKeyNow
    // The chat's other pages: this device's copy of their text, else the one saved in the chat (another device's).
    const others = otherPages(history, url).map((p) => p.url).slice(0, MAX_OTHER_PAGES)
    const savedTexts = savedPages(history)
    void Promise.all([wholeChat ? pageTexts(others) : Promise.resolve([]), saved]).then(([local]) => {
      const pages = wholeChat ? others.flatMap((u) => local.find((p) => p.url === u) ?? savedTexts.find((p) => p.url === u) ?? []) : []
      if (portRef.current !== port) return // stopped meanwhile
      port.postMessage({
        type: "ask",
        job,
        payload: {
          messages: historyForModel(history, url, wholeChat, free),
          page,
          action: opts.action,
          mode: opts.mode,
          stats,
          // Asked during the guided first request: the server doesn't count it, for an install's first few (2.6).
          ...(guideRef.current && !planTour.current ? { tour: true as const } : {}),
          ...(wholeChat ? { context: "chat" as const, pages } : {})
        }
      })
    })
  }

  // ------------------------------------------------------------ answers that go on with the panel closed (build 91)
  // The background answers every question as a job and writes the answer into its chat (background/jobs.ts). The panel
  // follows the job of the chat it shows: the one it asked, or, coming back to the chat (the panel reopened, another
  // page, another chat and back), the one still running, from what came so far. A job that ended while nobody
  // followed it left its answer in the chat; one lost (the connection, the background closed) leaves "interrupted".
  const heardRef = useRef(0)

  /** Follows a chat answer on `port`: what came so far first when it's a job followed again ("snapshot"). */
  const listenChat = (port: chrome.runtime.Port, history: Turn[]) => {
    heardRef.current = Date.now()
    let settled = false
    let grounded: { text: string; grounding: Grounding } | null = null
    let lastSeq = 0
    type Followed = { type: "snapshot"; text: string; grounding?: { text: string; grounding: Grounding } } | { type: "beat" } | { type: "gone" }
    port.onMessage.addListener((event: (StreamEvent | Followed) & { seq?: number; entry?: Turn }) => {
      // Safari can deliver a message twice (in the PDF popup): every event is numbered.
      if (event.seq !== undefined) {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
      }
      if (portRef.current !== port) return
      heardRef.current = Date.now()
      if (event.type === "snapshot") {
        partialRef.current = event.text
        setPartial(event.text)
        if (event.grounding) grounded = event.grounding
      } else if (event.type === "gone") {
        settled = true
        lostRef.current()
      } else if (event.type === "meta") {
        setViaOwnKey(event.viaOwnKey)
        if (event.usage) setUsage(event.usage)
      } else if (event.type === "delta") {
        partialRef.current += event.text
        setPartial(partialRef.current)
      } else if (event.type === "grounding") {
        grounded = { text: event.text, grounding: event.grounding }
      } else if (event.type === "done") {
        settled = true
        if (event.usage) setUsage(event.usage)
        finish(history, grounded?.text ?? partialRef.current, null, grounded?.grounding, event.entry)
      } else if (event.type === "error") {
        settled = true
        if (event.usage) setUsage(event.usage)
        finish(history, partialRef.current, { code: event.code, message: event.message, usage: event.usage, offer: event.offer, weight: event.weight }, undefined, event.entry)
      }
    })
    // Closed without an end: the job may well go on (the background still answers it), so the chat is read again.
    port.onDisconnect.addListener(() => {
      if (!settled && portRef.current === port) lostRef.current()
    })
  }

  /** Follows the job answering `last` (the shown chat's last question), from what came so far. */
  const attach = (last: Turn, history: Turn[]) => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: "job" })
    } catch {
      return
    }
    portRef.current = port
    setError(null)
    partialRef.current = ""
    setPartial("")
    if (last.similarAsk !== undefined) {
      setSimilarRun({ items: [], step: "plan" })
      listenSimilarRef.current(port, history, last.similarAsk)
    } else {
      setStreamMode(last.mode ?? null)
      listenChat(port, history)
    }
    port.postMessage({ type: "attach", id: last.id })
  }

  /**
   * The shown chat's last question has no answer: follow its job when the background still runs it, else say it was
   * interrupted (with Retry), unless it's too fresh to tell (asked on another device a moment ago).
   */
  const resume = (entries: Turn[], thread: string) => {
    const last = entries[entries.length - 1]
    if (!isQuestion(last)) return
    void Promise.all([sendBackground<{ ids: string[] }>({ type: "liveJobs" }), loadJobs()]).then(([live, jobs]) => {
      const shown = nowRef.current.messages
      const now = shown[shown.length - 1]
      if (threadRef.current !== thread || portRef.current || askToken.current || !now || entryKey(now) !== entryKey(last)) return
      if (last.id && live?.ids?.includes(last.id)) return attach(now, shown)
      const gap = interruption(shown, jobs, false)
      if (gap) setError({ code: RESUMABLE.includes(gap.code) ? (gap.code as ErrorCode) : "STREAM" })
    })
  }
  const resumeRef = useRef(resume)
  resumeRef.current = resume

  /**
   * The followed answer went quiet or its port closed: the chat as the background left it (the answer may be in it
   * already), then its last question followed again or said to be interrupted.
   */
  const lost = () => {
    const port = portRef.current
    portRef.current = null
    askToken.current = null
    try {
      port?.disconnect()
    } catch {
      // already closed
    }
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    setSimilarRun(null)
    const thread = threadRef.current
    void loadThreads().then(({ threads }) => {
      if (threadRef.current !== thread || portRef.current || askToken.current) return
      const shown = nowRef.current.messages
      const stored = threads[thread]?.m
      const entries = stored && extendsChat(stored, shown) ? stored : shown
      if (entries !== shown) setMessages(entries)
      resumeRef.current(entries, thread)
    })
  }
  const lostRef = useRef(lost)
  lostRef.current = lost

  // A followed answer that says nothing for a while (its port broke without closing: 2.6 (90), "Reading the page…" for
  // minutes) is looked up again; so is one coming back from sleep (the page in the background, the phone locked).
  // Only while an answer is coming (build 92: it ran every 5 s on every page, the panel closed too).
  useEffect(() => {
    if (partial === null) return
    const quiet = (ms: number) => portRef.current !== null && heardRef.current > 0 && Date.now() - heardRef.current > ms
    const timer = setInterval(() => {
      if (quiet(20_000)) lostRef.current()
    }, 5_000)
    const onVisible = () => {
      if (document.visibilityState === "visible" && quiet(6_000)) lostRef.current()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [partial === null])

  /** Keeps a note in the chat (with the page it was written on); no AI, no allowance used. */
  const saveNote = useCallback((text: string) => {
    const content = text.trim()
    if (!content || portRef.current || askToken.current) return
    setUndoBar(null)
    setFirstWin(null)
    const url = source.key()
    const full = source.quick()
    const next: Turn[] = [...messages, stamped({ role: "user", content, note: true, page: pageRef(messages, url, full.title, full.text, keepsText) })]
    setMessages(next)
    void saveThread(threadRef.current, next)
    void rememberPageText(url, full.title, full.text)
    setDraft("")
    if (inputRef.current) inputRef.current.style.height = "auto"
    setError(null)
    setNoteMode(false)
  }, [messages, source])

  const submit = () => (noteMode ? saveNote(draft) : ask(draft, { mode: googleMode && !historyRef.current ? "google" : undefined }))

  // The chat and the field as they are now, for stop() (2.5 (75)).
  const nowRef = useRef({ messages, draft })
  nowRef.current = { messages, draft }
  /**
   * A question stopped before any of its answer came (2.5 (75), the owner's notes) leaves no question without an
   * answer, and no chat that only had it (stopped.ts); `restore` (the stop button): its text goes back to the field.
   */
  const dropStopped = (restore: boolean) => {
    const { kept, question } = withoutStopped(nowRef.current.messages)
    if (!question) return
    const id = threadRef.current
    setMessages(kept)
    if (kept.length) void saveThread(id, kept, historyRef.current ? "history" : undefined)
    else void deleteThread(id)
    const back = restore ? restoredDraft(question, nowRef.current.draft) : null
    if (back === null) return
    setDraft(back)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.style.height = "auto"
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`
    })
  }
  const dropStoppedRef = useRef(dropStopped)
  dropStoppedRef.current = dropStopped

  // `fromButton`: the stop button (the question comes back to the field); else a new or another chat is opening, and
  // the answer goes on in its chat (build 91): the panel only stops following it.
  const stop = useCallback((fromButton = false) => {
    const port = portRef.current
    if (!port && askToken.current) {
      // Stopped while the page was still being read: nothing was asked.
      askToken.current = null
      setReading(null)
      partialRef.current = ""
      setPartial(null)
      setStreamMode(null)
      dropStoppedRef.current(fromButton)
      return
    }
    if (!port) return
    portRef.current = null
    // The next question can go (it waited for this one to finish).
    askToken.current = null
    try {
      if (fromButton) port.postMessage({ type: "stop" })
      port.disconnect()
    } catch {
      // already closed
    }
    const text = partialRef.current
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    setSimilarRun(null)
    if (!fromButton) return
    if (text) setMessages((prev) => [...prev, stamped({ role: "assistant", content: text })])
    else dropStoppedRef.current(fromButton)
  }, [])

  // `withoutGoogle`: ask the same question as a normal answer (e.g. after the Google limit).
  const retry = useCallback((withoutGoogle = false) => {
    const last = messages[messages.length - 1]
    if (!isQuestion(last)) return
    if (last.similarAsk !== undefined) return findSimilarRef.current(last.similarAsk, last.label ?? last.content, true, last.similarSel)
    if (withoutGoogle) setGoogleMode(false)
    ask(last.content, { label: last.label, retry: true, mode: withoutGoogle ? undefined : last.mode })
  }, [messages, ask])

  const runAction = useCallback((picked: Action) => {
    if (picked.id === "similar") return openSimilarRef.current("chip")
    // 2.6 (build 89, the owner): Find similar from a selection: alternatives to what it describes, the page as context.
    if (picked.id === "sel_similar") return openSimilarRef.current("selection", selection?.text)
    // Translate by a selection: into English (or the next language) when the text is in the interface's already.
    const action = (selection && forSelection(picked, selection.text)) || picked
    ask(t(action.prompt, action.arg ?? t("languageName")), { label: action.text ?? t(action.label), action: action.id, mode: action.mode })
  }, [ask, selection])
  runActionRef.current = runAction

  // ------------------------------------------------------------ find similar (2.6, Ultra)
  /** The card: the condition for someone with Ultra, what it is and the way to it for anyone else. */
  const openSimilar = (via: "chip" | "menu" | "selection", subject?: string) => {
    setPageMenu(false)
    setSimilarSubject(via === "selection" && subject?.trim() ? subject.trim().slice(0, SIMILAR_SELECTION_MAX) : null)
    if (via === "menu") void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "similar" })
    // The plan decides: as the panel knows it, or, tapped before the panel's status came, as the background tells it
    // (an Ultra subscriber must never see Ultra's card for being quick).
    const decide = (plan: string | undefined) => setSimilarCard(similarAllowed(plan) ? "pick" : "upsell")
    if (statusRef.current) decide(statusRef.current.plan)
    else void sendBackground<StatusInfo>({ type: "status", platform }).then((now) => decide(now?.plan ?? statusRef.current?.plan))
    setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }), 60)
  }
  const openSimilarRef = useRef(openSimilar)
  openSimilarRef.current = openSimilar

  /** Ends a Find similar: the checked list as the chat's answer, or why there isn't one. */
  const finishSimilar = (history: Turn[], answer: Omit<SimilarAnswer, "asked" | "at"> | null, asked: string, code: string | null, usage?: Usage | null, entry?: Turn) => {
    portRef.current = null
    askToken.current = null
    partialRef.current = ""
    setPartial(null)
    setSimilarRun(null)
    if (code === "ULTRA_ONLY" || code === "PRO_ONLY" || code === "LIMIT_REACHED") {
      // Not in their plan after all (the server's word), or the week's searches are used: the question goes, a card
      // says so.
      setMessages(history.slice(0, -1))
      setSimilarCard(code === "LIMIT_REACHED" ? { limit: usage ?? null } : "upsell")
      return
    }
    if (entry || answer) {
      // The list as the background wrote it into the chat (build 91), else as it came.
      const full: SimilarAnswer | null = entry ? null : { ...answer!, asked, at: Date.now() }
      const content = full ? similarMarkdown(full, { inStock: t("similarStockIn"), outOfStock: t("similarStockOut"), notConfirmed: t("similarNotConfirmed"), notOpened: t("similarNotOpened") }) : ""
      const next: Turn[] = [...history, entry ?? stamped({ role: "assistant", content, similar: full! })]
      setMessages(next)
      void saveThread(threadRef.current, next)
    }
    if (code) setError(code === "UNAVAILABLE" ? { code: "UNAVAILABLE", message: "similar" } : { code: code as ErrorCode })
  }

  /** Asks our server for checked alternatives to this page (engine A only); the list streams in as items pass. */
  const findSimilar = (condition: string, label: string, again = false, subject?: string) => {
    if (portRef.current || askToken.current) return
    setSimilarCard(null)
    if (consent !== "ok") {
      setPending({ text: label, label, action: "similar", similar: condition, ...(subject ? { similarSel: subject } : {}) })
      return
    }
    setUndoBar(null)
    setFirstWin(null)
    setError(null)
    setOfferCard(false)
    // Asked again after it was left without an answer (interrupted): it takes that question's place (2.6 (90): twice).
    const base = again || repeatsLast(messages, { content: label, similarAsk: condition, similarSel: subject }) ? messages.slice(0, messages.length - 1) : messages
    const user: Turn = stamped({ role: "user", content: label, label, similarAsk: condition, ...(subject ? { similarSel: subject } : {}), page: { url: source.key(), title: source.title(), at: Date.now() } })
    const history: Turn[] = [...base, user]
    setMessages(history)
    // In the chat before it goes: the background writes the list after it (build 91).
    const thread = threadRef.current
    const saved = saveThread(thread, history).catch(() => undefined)
    partialRef.current = ""
    setPartial("")
    setSimilarRun({ items: [], step: "plan" })
    const token = {}
    askToken.current = token
    // What the page states for machines (page watch's reader): its price and stock, to compare against.
    const facts = factsFrom(structured(document.documentElement.outerHTML), document.documentElement.lang || "")
    void Promise.all([source.read(false).catch(() => ({ ...source.quick(), sources: [] })), saved]).then(([full]) => {
      if (askToken.current !== token) return
      let port: chrome.runtime.Port
      try {
        port = chrome.runtime.connect({ name: "similar" })
      } catch {
        finishSimilar(history, null, condition, "NETWORK")
        return
      }
      portRef.current = port
      listenSimilar(port, history, condition)
      port.postMessage({
        type: "similar",
        job: { id: user.id!, thread },
        payload: { page: { title: full.title || source.title(), url: source.href(), text: full.text.slice(0, 5_000), facts }, condition, ...(subject ? { selection: subject } : {}) }
      })
    })
  }

  /** Follows a Find similar on `port`: what came so far first when it's a job followed again ("snapshot"). */
  const listenSimilar = (port: chrome.runtime.Port, history: Turn[], condition: string) => {
    heardRef.current = Date.now()
    let settled = false
    let lastSeq = 0
    let items: SimilarItem[] = []
    let answer: Omit<SimilarAnswer, "asked" | "at"> | null = null
    type Followed = { type: "snapshot"; items: SimilarItem[]; step?: SimilarStep; pages?: number } | { type: "beat" } | { type: "gone" }
    port.onMessage.addListener((event: (SimilarStreamEvent | Followed) & { seq?: number; entry?: Turn }) => {
      if (event.seq !== undefined) {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
      }
      if (portRef.current !== port) return
      heardRef.current = Date.now()
      if (event.type === "snapshot") {
        items = [...event.items]
        setSimilarRun({ items, step: event.step ?? "plan", ...(event.pages !== undefined ? { pages: event.pages } : {}) })
      } else if (event.type === "gone") {
        settled = true
        lostRef.current()
      } else if (event.type === "progress") setSimilarRun((r) => (r ? { ...r, step: event.step, pages: event.pages ?? r.pages } : r))
      else if (event.type === "item") {
        items = [...items, event.item]
        setSimilarRun((r) => (r ? { ...r, items } : r))
      } else if (event.type === "result") answer = event.answer
      else if (event.type === "done") {
        settled = true
        finishSimilar(history, answer ?? { intro: "", items, note: "", condition: "" }, condition, null, undefined, event.entry)
      } else if (event.type === "error") {
        settled = true
        finishSimilar(history, items.length ? { intro: "", items, note: "", condition: "" } : null, condition, event.code, event.usage, event.entry)
      }
    })
    // Closed without an end: the background may still be answering it, so the chat is read again.
    port.onDisconnect.addListener(() => {
      if (!settled && portRef.current === port) lostRef.current()
    })
  }
  const listenSimilarRef = useRef(listenSimilar)
  listenSimilarRef.current = listenSimilar
  const findSimilarRef = useRef(findSimilar)
  findSimilarRef.current = findSimilar

  /** "Watch price" on an item: page watch on that page, from where our server read its price. */
  const watchItem = (item: SimilarItem) => {
    if (!item.watch) return
    const candidates = item.watch.source === "ld-price" ? { ldPrice: item.watch.value } : { metaPrice: item.watch.value }
    openWatchSheet({
      url: item.url, title: item.name, selection: item.watch.value, how: "later",
      draft: { url: item.url, title: item.name, selection: item.watch.value, what: "price", condition: conditionFor("price", shownPrice(item.watch.value)), around: "", candidates, value: item.watch.value }
    })
  }

  const acceptConsent = useCallback(async () => {
    await giveConsent()
    setConsent("ok")
    const p = pending
    setPending(null)
    if (p?.action === "similar") setTimeout(() => findSimilarRef.current(p.similar ?? "", p.label ?? p.text, false, p.similarSel), 0)
    else if (p) setTimeout(() => askRef.current(p.text, { label: p.label, action: p.action, mode: p.mode }), 0)
  }, [pending])
  // "Not now": the question stays in the box, nothing is sent.
  const declineConsent = useCallback(() => setPending(null), [])
  const askRef = useRef(ask)
  askRef.current = ask

  /** Starts a new thread; the previous one stays in the list. */
  const newChat = useCallback(() => {
    stop()
    setUndoBar(null)
    setFirstWin(null)
    const id = newThreadId()
    threadRef.current = id
    setKind(undefined)
    void setActiveThread(id)
    setMessages([])
    setError(null)
    setMemoryOffer(null)
    setView("chat")
  }, [stop])

  // ------------------------------------------------------------ the field and Note by a selection
  // The first time the selection buttons show on a page (three page visits, until one is used): what's new in them.
  const selHintAsked = useRef(false)
  useEffect(() => {
    if (!bubble) {
      setSelDraft("")
      setSelFocus(false)
      // The field went away with the buttons while focused (after Note): no blur comes, and a
      // "typing" left on would hold back every later selection on the page.
      selTyping.current = false
      return
    }
    if (selHintAsked.current) return
    selHintAsked.current = true
    void selHintCount().then((count) => {
      if (count < 0 || count >= 3) return
      setSelHint(true)
      void setSelHintCount(count + 1)
    })
  }, [bubble])

  const selFeatureUsed = () => {
    setSelHint(false)
    void setSelHintCount(-1)
  }

  /** The question typed by the selection: the panel opens on the selection, with that question and its answer. */
  const askAboutSelection = (sel: SelectionInfo, question: string) => {
    const text = question.trim()
    if (!text) return
    selTyping.current = false
    selFeatureUsed()
    show(sel)
    // Once the panel has rendered open and loaded its chat (not "Ask your chats": a question about
    // the page starts a new chat there); an answer still coming in leaves the question in the field.
    setTimeout(() => void loadingRef.current.then(() => {
      if (historyRef.current) newChat()
      setTimeout(() => {
        if (portRef.current || askToken.current) setDraft(text)
        else askRef.current(text)
      }, 0)
    }), 60)
  }

  /**
   * Note by the selection: the selected text, with what's typed in the field as its comment, goes to
   * the end of the current chat with the page. No AI, no answer used; the panel stays closed.
   */
  /**
   * `remindAt`: "Come back later" → Remind (2.5): the note gets a reminder that opens its page. Without a selection
   * the note is the page itself (its title).
   */
  const noteSelection = async (sel: SelectionInfo | null, comment: string, remindAt?: number, remindPreset?: string) => {
    if (noteHold.current) return
    noteHold.current = true
    if (sel) selFeatureUsed()
    // An answer still coming in (the panel was closed meanwhile) is saved first: the note goes after it.
    for (let i = 0; i < 300 && (portRef.current || askToken.current); i++) await new Promise((r) => setTimeout(r, 200))
    const { threads, active } = await loadThreads()
    const current = threads[active.id]
    // Not into "Ask your chats" or a chat deleted on another device: a new chat then.
    const fits = !current || (!current.deleted && current.kind !== "history")
    const id = fits ? active.id : newThreadId()
    if (!fits) await setActiveThread(id)
    const url = source.key()
    const page = source.quick()
    const ref = pageRef(fits && current ? current.m : [], url, page.title, page.text, keepsText)
    let note: Entry = sel ? selectionNote(sel.text, comment, ref, (text) => t("noteQuote", text)) : stamped({ role: "user", content: page.title || source.href(), note: true, page: ref }, ref.at)
    if (remindAt) {
      // Set on this device first: the note keeps the bell only when the notification is really set.
      const outcome = await scheduleReminder(sendBackground, id, { ...note, remind: { at: remindAt, page: true } }, remindAt, "")
      const dev = await thisDevice()
      if (outcome === "scheduled") note = { ...note, remind: { at: remindAt, page: true, ...(dev ? { dev } : {}) } }
      // A time when set; -1 when notifications are off for ContextFlow; 0 when there's no app to set it.
      setRemindSaved(outcome === "scheduled" ? remindAt : outcome === "denied" ? -1 : 0)
      void sendBackground({ type: "uxEvent", kind: "ux_remind", action: outcome === "scheduled" ? "set" : outcome === "denied" ? "denied" : "cancelled", what: "page", how: "later", ...(remindPreset ? { preset: remindPreset } : {}) })
    }
    const list = [...(fits && current ? current.m : []), note]
    await saveThread(id, list)
    // The panel open ("Come back later" from its "…"): the note shows in the chat at once.
    if (open) {
      threadRef.current = id
      setMessages(list)
    }
    void rememberPageText(url, page.title, page.text)
    setNoteSaved(true)
    setTimeout(() => {
      noteHold.current = false
      setNoteSaved(false)
      setRemindSaved(null)
      setBubble(null)
      // On iPhone and iPad the system edit menu would stay over the page.
      if (touch) document.getSelection()?.removeAllRanges()
    }, remindAt ? 4000 : 2200)
  }

  /** "Ask your chats" (Pro): continues today's one, else starts a new one; without Pro, says what it does. */
  const askHistory = useCallback(() => {
    if (!hasPro(status?.plan)) {
      setUpsell("history")
      return
    }
    stop()
    setUpsell(null)
    const recent = threadList.find((th) => th.kind === "history" && Date.now() - (th.a ?? th.u) < 24 * 3600_000)
    const id = recent?.id ?? newThreadId()
    threadRef.current = id
    setKind("history")
    void setActiveThread(id)
    setMessages(recent?.m ?? [])
    setError(null)
    setView("chat")
    if (recent) setTimeout(() => resumeRef.current(recent.m, id), 0)
  }, [stop, status, threadList])

  /** AI search (Pro): the chats the server finds for what the user describes. */
  const findChats = useCallback(async (query: string): Promise<FindReply> => {
    // Without consent to the current text the card asks first; "Not now" sends nothing.
    if (consentRef.current !== "ok") {
      const agreed = await new Promise<boolean>((resolve) => setFindConsent({ resolve }))
      setFindConsent(null)
      if (!agreed) return { ok: false, code: "CONSENT" }
      await giveConsent()
      setConsent("ok")
    }
    const { threads } = await loadThreads()
    const chats = chatDigests(Object.values(threads), { perChat: 450, perAnswer: 150, total: 38_000 })
    const reply = (await sendBackground<FindReply>({ type: "find", query, chats })) ?? { ok: false as const, code: "NETWORK" as const }
    if (reply.usage) setUsage(reply.usage)
    if (!reply.ok && reply.code === "PRO_ONLY") setUpsell("find")
    return reply
  }, [])

  /** Opens a chat; `at`: the message to show (a search result), else its end. */
  const openThread = useCallback((id: string, at?: number) => {
    stop()
    setUndoBar(null)
    setFirstWin(null)
    const thread = threadList.find((x) => x.id === id)
    threadRef.current = id
    setKind(thread?.kind)
    void setActiveThread(id)
    setMessages(thread?.m ?? [])
    setError(null)
    setMemoryOffer(null)
    setView("chat")
    // Its answer still coming (asked before another chat was opened), or lost (build 91).
    if (thread) setTimeout(() => resumeRef.current(thread.m, id), 0)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const list = listRef.current
      if (!list) return
      const target = at !== undefined && at >= 0 ? list.querySelector<HTMLElement>(`[data-index="${at}"]`) : null
      if (!target) {
        list.scrollTop = list.scrollHeight
        return
      }
      target.scrollIntoView({ block: "center" })
      target.classList.add("found")
      setTimeout(() => target.classList.remove("found"), 1600)
    }))
  }, [stop, threadList])

  // Tags: of a chat (from the list), of an answer or a note (`tagging`: the message's index).
  const [tagging, setTagging] = useState<number | null>(null)
  const tagChat = useCallback((id: string, tags: string[]) => {
    setThreadList((list) => list.map((th) => (th.id === id ? { ...th, tags: cleanTags(tags) } : th)))
    void setThreadTags(id, tags)
  }, [])
  const tagMessage = useCallback((index: number, tags: string[]) => {
    setMessages((list) => list.map((m, i) => {
      if (i !== index) return m
      const next = { ...m }
      const clean = cleanTags(tags)
      if (clean.length) next.tags = clean
      else delete next.tags
      return next
    }))
  }, [])

  /**
   * Under an answer and under a note, the same: its tags, then Copy, Share and Tag, then the tag
   * picker (`plain`: the text to copy, `shared`: the text to share).
   */
  const messageFooter = (m: Entry, idx: number, plain: () => string, shared: () => string): VNode => (
    <>
      {m.tags && m.tags.length > 0 && <div class="cf-msg-tags">{m.tags.map((tag) => <TagChip key={tag} tag={tag} onClick={() => setTagging(idx)} />)}</div>}
      <div class={`cf-msg-tools ${hasField ? "has-insert" : ""}`}>
        {hasField && (
          <button type="button" class="cf-insert" onClick={() => {
            const text = plain()
            hide()
            // The panel slides away first: the field gets the caret back once it's visible again.
            setTimeout(() => insertFromPanel(text, m.note ? "note" : "answer"), layout === "sheet" ? 240 : 0)
          }}>
            <QIcon.Insert size={15} /> {t("qiInsertIntoField")}
          </button>
        )}
        <button type="button" onClick={async () => {
          const text = plain()
          // An answer with highlights goes as rich text too (bold), then as plain text.
          if ((await ux.copyAnswer(idx, text)) || (await copyText(text))) {
            setCopied(idx)
            setTimeout(() => setCopied(null), 1500)
            // ContextFlow's own Copy goes to Copied too.
            void keepCopied(text, "", "contextflow")
          }
        }}>
          {copied === idx ? <Icon.Check /> : <Icon.Copy />} {copied === idx ? t("copied") : t("copy")}
        </button>
        {typeof navigator.share === "function" && (
          <button type="button" onClick={() => {
            // Highlights as **…** only with the setting on (Messages and Notes show the asterisks).
            const stars = Boolean(m.marks?.length && settingsRef.current.shareMarks)
            if (stars) void sendBackground({ type: "uxEvent", kind: "ux_mark", action: "shared" })
            void shareText(stars ? starMarks(shared(), m.marks) : shared())
          }} aria-label={t("share")} title={t("share")}>
            <Icon.Share /> <span class="cf-tl">{t("share")}</span>
          </button>
        )}
        {TARGET === "safari" && !m.note && m.role === "assistant" && (
          <button type="button" class={`cf-listen-btn cf-ultra-tool ${idx === lastAnswerIdx ? "last" : ""} ${listen.state.at !== "idle" && "key" in listen.state && listen.state.key === `a:${idx}` ? "on" : ""}`} onClick={() => {
            if (listen.state.at !== "idle" && "key" in listen.state && listen.state.key === `a:${idx}`) return listen.stop()
            void listen.start(`a:${idx}`, { text: m.content, what: "answer", lang: textLanguage(m.content) ?? t("langCode"), title: source.title(), url: source.href() })
          }} aria-label={t("listen")} title={t("listen")}>
            <SpeakerIcon /> <span class="cf-tl">{t("listen")}</span>{!isUltra(plan) && <span class="cf-ultra-badge">Ultra</span>}
          </button>
        )}
        <button type="button" onClick={() => setTagging(tagging === idx ? null : idx)} aria-expanded={tagging === idx} aria-label={t("tagsButton")} title={t("tagsButton")}>
          <Icon.Tag /> <span class="cf-tl">{t("tagsButton")}</span>
        </button>
        {ux.moreButton(m, idx)}
      </div>
      {tagging === idx && <TagEditor tags={m.tags ?? []} known={allTags(threadList).map((x) => x.tag)} onChange={(next) => userTags(idx, next)} onClose={() => setTagging(null)} />}
      {organizeRow(idx)}
    </>
  )

  const renameChat = useCallback((id: string, name: string) => {
    void renameThread(id, name).then(() => loadThreads()).then(({ threads }) => showLists(threads))
  }, [])

  /**
   * A chat's reminders on this device: off while it's in Recently Deleted, on again once it's back (those still ahead
   * that were set here).
   */
  const chatReminders = async (thread: Thread, on: boolean) => {
    const dev = on ? await thisDevice() : undefined
    for (const m of thread.m) {
      if (!m.remind) continue
      if (!on) void scheduleReminder(sendBackground, thread.id, m, null, "")
      else if (m.remind.at > Date.now() && (!m.remind.dev || m.remind.dev === dev)) void scheduleReminder(sendBackground, thread.id, m, m.remind.at, thread.title || threadTitle(thread.m))
    }
  }

  // The last move to Recently Deleted being stored: Undo right after a delete waits for it, or it would find nothing to
  // restore and the delete would land after it.
  const trashing = useRef<Promise<unknown>>(Promise.resolve())
  /** A chat the user deleted goes to Recently Deleted (2.5 (83)); shown here, a new chat takes its place. */
  const removeThread = useCallback((id: string) => {
    setThreadList((list) => list.filter((x) => x.id !== id))
    if (id === threadRef.current) {
      const id2 = newThreadId()
      threadRef.current = id2
      setKind(undefined)
      void setActiveThread(id2)
      setMessages([])
      setError(null)
    }
    const done = trashChat(id).then(async (gone) => {
      if (gone) void chatReminders(gone, false)
      const { threads } = await loadThreads()
      showLists(threads)
    })
    trashing.current = done.catch(() => undefined)
  }, [])

  /** Back from Recently Deleted (its Restore, or Undo after a delete): to its place in the list, its reminders on again. */
  const restoreFromTrash = (id: string, how: "bar" | "list") => {
    void trashing.current.then(() => restoreChat(id)).then(async (back) => {
      if (back) void chatReminders(back, true)
      const { threads } = await loadThreads()
      showLists(threads)
      if (back) void sendBackground({ type: "uxEvent", kind: "ux_delete", action: "undone", what: "chat", how })
    })
  }

  /** Delete Now (one chat) and Delete All (`ids`: every chat there) in Recently Deleted: gone for good. */
  const purgeFromTrash = (ids: string[]) => {
    setTrashList((list) => list.filter((x) => !ids.includes(x.id)))
    void purgeChats(ids).then(showLists)
  }

  /**
   * A chat deleted from the list (its trash button, a swipe or "…"), with "Chat deleted · Undo" (2.5); Undo brings it
   * back from Recently Deleted.
   */
  const deleteChatWithUndo = useCallback((id: string) => {
    const gone = threadList.find((x) => x.id === id)
    removeThread(id)
    if (!gone) return
    void sendBackground({ type: "uxEvent", kind: "ux_delete", action: "deleted", what: "chat", how: touch ? "swipe" : "list" })
    setUndoBar({
      text: t("uxDeletedChat"),
      actions: [{
        label: t("orgUndo"),
        run: () => {
          setUndoBar(null)
          restoreFromTrash(gone.id, "bar")
        }
      }]
    })
  }, [threadList, removeThread, touch])

  // Pinning and reordering show at once; storage (and iCloud) follow.
  const placeChat = useCallback((id: string, pin: number | null) => {
    setThreadList((list) => chatList(Object.fromEntries(list.map((th) => {
      if (th.id !== id) return [th.id, th]
      const next = { ...th }
      if (pin === null) delete next.pin
      else next.pin = pin
      return [th.id, next]
    }))))
    void pinThread(id, pin)
  }, [])
  const pinChat = useCallback((id: string, pinned: boolean) => {
    placeChat(id, pinned ? pinAt(threadList.filter((th) => th.pin !== undefined && th.id !== id), 0) : null)
  }, [threadList, placeChat])
  const moveChat = useCallback((id: string, index: number) => {
    placeChat(id, pinAt(threadList.filter((th) => th.pin !== undefined && th.id !== id), index))
  }, [threadList, placeChat])

  // ------------------------------------------------------------ notes
  /** A page of the chat: its tab when it's open somewhere, else a new tab. */
  const openPage = useCallback((url: string) => void sendBackground({ type: "openPage", url }), [])

  // The send button flips between asking and writing a note: swipe it up or down (touch), scroll on it
  // (trackpad, mouse wheel) or hold it. `switched` swallows the click that ends a hold.
  const switched = useRef(false)
  const gesture = useRef({ y: 0, moved: false, wheelAt: 0, hold: 0 })
  const flipMode = useCallback(() => {
    setNoteMode((on) => !on)
    setNoteHint(false)
    void setNoteHintCount(-1)
  }, [])
  const endHold = () => window.clearTimeout(gesture.current.hold)
  const switchGestures = {
    onTouchStart: (e: TouchEvent) => {
      gesture.current.y = e.touches[0].clientY
      gesture.current.moved = false
    },
    onTouchMove: (e: TouchEvent) => {
      const g = gesture.current
      if (!g.moved && Math.abs(e.touches[0].clientY - g.y) > 14) {
        g.moved = true
        switched.current = true
        endHold()
        flipMode()
      }
      if (g.moved) e.preventDefault()
    },
    onWheel: (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 3) return
      e.preventDefault()
      const now = Date.now()
      if (now - gesture.current.wheelAt > 500) flipMode()
      gesture.current.wheelAt = now
    },
    onPointerDown: () => {
      switched.current = false
      gesture.current.hold = window.setTimeout(() => {
        switched.current = true
        flipMode()
      }, 500)
    },
    onPointerUp: endHold,
    onPointerLeave: endHold,
    onPointerCancel: endHold,
    onContextMenu: (e: Event) => e.preventDefault()
  }

  // While typing, the first few panel sessions show how to switch to a note (until it's been used once).
  const hintAsked = useRef(false)
  useEffect(() => {
    if (!draft.trim() || noteMode || hintAsked.current) return
    hintAsked.current = true
    void noteHintCount().then((count) => {
      if (count < 0 || count >= 3) return
      setNoteHint(true)
      void setNoteHintCount(count + 1)
      window.setTimeout(() => setNoteHint(false), 8000)
    })
  }, [draft, noteMode])

  // An install that ran out of free answers before is offered Pro with the first month off once more: the card
  // shows in up to three page visits, until it's answered (asking a question just hides it for now).
  const offerCardAsked = useRef(false)
  useEffect(() => {
    if (TARGET !== "safari" || !open || offerCardAsked.current || !status) return
    if (!status.limitedBefore || !status.offer || status.plan !== "free" || status.hasOwnKey) return
    offerCardAsked.current = true
    void offerCardCount().then((count) => {
      if (count < 0 || count >= 3) return
      setOfferCard(true)
      void setOfferCardCount(count + 1)
    })
  }, [open, status])
  // It comes after the chat: bring it into view.
  useEffect(() => {
    if (offerCard) requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }))
  }, [offerCard])

  // A Pro user who turned auto-renew off: when Pro ends, and one question, what was missing. Once per
  // subscription period, here or in the app (it keeps the mark for both). Nothing is offered.
  const [renewal, setRenewal] = useState<"ask" | "thanks" | null>(null)
  useEffect(() => {
    const store = status?.store
    if (TARGET !== "safari" || !open || renewal || !store?.active || store.autoRenew !== false || !store.period || store.renewalAsked) return
    if (!(PRODUCTS.pro as readonly string[]).includes(store.productId ?? "")) return
    void renewalAskedPeriod().then((asked) => {
      if (asked !== store.period) setRenewal("ask")
    })
  }, [open, status, renewal])
  const answerRenewal = useCallback((reason: RenewalReason) => {
    const store = statusRef.current?.store
    if (!store?.period) return
    void sendBackground({ type: "renewalAnswer", reason, period: store.period, productId: store.productId, expiresAt: store.expiresAt })
    setRenewal(reason === "later" ? null : "thanks")
    if (reason !== "later") setTimeout(() => setRenewal(null), 4000)
  }, [])
  useEffect(() => {
    if (renewal === "ask") requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }))
  }, [renewal])

  // ------------------------------------------------------------ sharing
  const shareLinks = (): ShareLinks => ({ page: source.href(), app: LINKS.appStoreShare })

  const chatName = (): string => threadList.find((t) => t.id === threadRef.current)?.title || threadTitle(messages)

  /** Shares text (copies it where sharing isn't available). True when it was copied. */
  const shareText = useCallback(async (text: string): Promise<boolean> => {
    if (typeof navigator.share === "function") {
      // Text only: with a `url` as well, iOS shares the App Store page and the text gets lost.
      await navigator.share({ text }).catch(() => undefined)
      return false
    }
    return copyText(text)
  }, [])

  /** Sharing the chat starts with every message picked: untick what shouldn't go, then share or copy. */
  const pickMessages = useCallback(() => setPicked(new Set(messages.map((_, i) => i))), [messages])
  const togglePicked = (index: number) => setPicked((now) => {
    if (!now) return now
    const next = new Set(now)
    if (!next.delete(index)) next.add(index)
    return next
  })
  // While choosing, a press anywhere on a message (links too) ticks it instead of acting.
  const pickProps = (index: number) => picked
    ? {
        role: "checkbox" as const,
        "aria-checked": picked.has(index),
        tabIndex: 0,
        onClickCapture: (e: Event) => { e.preventDefault(); e.stopPropagation(); togglePicked(index) },
        onKeyDown: (e: KeyboardEvent) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); togglePicked(index) } }
      }
    : {}
  const pickedText = () => pickedShareText(messages, picked ?? new Set(), chatName(), shareLabels(chatLanguage(messages)), shareLinks())
  /** Shares (or copies, where sharing isn't available) the picked messages. */
  const sharePicked = useCallback(async () => {
    if (!picked?.size) return
    const copiedIt = await shareText(pickedText())
    setPicked(null)
    if (copiedIt) {
      setChatCopied(true)
      setTimeout(() => setChatCopied(false), 1500)
    }
  }, [picked, messages, shareText, threadList])
  const copyPicked = useCallback(async () => {
    if (!picked?.size) return
    if (await copyText(pickedText())) {
      setPicked(null)
      setChatCopied(true)
      setTimeout(() => setChatCopied(false), 1500)
    }
  }, [picked, messages, threadList])
  // Another chat, or one that changed underneath: start choosing again.
  useEffect(() => setPicked(null), [threadRef.current, messages.length, view])

  // ------------------------------------------------------------ upgrade
  const openApp = useCallback((target: "subscribe" | "manage", feature?: "ai" | "organize") => {
    openAppFromTap(touch, { target, feature })
  }, [touch])

  // The App Store's sheet for the offer code: the discount and the price after it, then the purchase.
  const redeemOffer = useCallback((code: string) => {
    void sendBackground({ type: "openUrl", url: offerUrl(code) })
  }, [])

  // The offer card was answered: it isn't shown again.
  const closeOfferCard = useCallback((code: string | null) => {
    setOfferCard(false)
    void setOfferCardCount(-1)
    if (code) redeemOffer(code)
  }, [redeemOffer])

  // Out of answers: write a note instead (free and unlimited).
  const writeNote = useCallback(() => {
    setError(null)
    setNoteMode(true)
    setNoteHint(false)
    void setNoteHintCount(-1)
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50)
  }, [])

  // ------------------------------------------------------------ FAB
  const fabEnabled = settings.fab !== "off"
  // The ✦ steps aside while quick insert's button sits by the field being typed in.
  const insertButtonShown = useButtonShown()
  const fabVisible = !popup && fabEnabled && !open && !settings.fabHiddenSites.includes(source.site()) && !insertButtonShown
  // Long answers run by the background (similar-26's jobs, src/shared/jobs.ts): a spinner on their chat's row and
  // "Working on it…" in it, a dot on the row and on the round button once one finished unseen. The background marks
  // a chat's outcomes seen when the panel shows it (the "jobsSeen" effect above).
  const [jobList, setJobList] = useState<Jobs>({})
  useEffect(() => {
    void loadJobs().then(setJobList)
    return onJobsChanged(setJobList)
  }, [])
  const jobs = useMemo(() => ({ running: runningThreads(jobList), unread: unreadThreads(jobList) }), [jobList])
  // The selection buttons were placed: the round button steps out of their way, or stays (fabDodge.ts).
  const onBubblePlace = useCallback((box: DOMRect, selection: DOMRect) => {
    const fab = fabRef.current
    if (!fab) return
    // Its own place: measured while it's there (the drag's end or the settings move it there again).
    if (fabDodgeRef.current === null) fabHome.current = fab.getBoundingClientRect()
    const home = fabHome.current
    if (!home) return
    const vv = window.visualViewport
    const top = vv?.offsetTop ?? 0
    setFabDodge(dodgeFab(home, box, selection, { top, bottom: top + (vv?.height ?? window.innerHeight) }))
  }, [])
  // The selection buttons before the panel opened here: the plan from the background's copy, for Ultra's mark.
  useEffect(() => {
    if (!bubble?.rect || statusRef.current) return
    void sendBackground<StatusInfo>({ type: "status", platform }).then((now) => {
      if (now && !statusRef.current) setStatus(now)
    })
  }, [bubble?.rect])
  // Back home once the selection buttons are gone, or when the button is moved or hidden.
  useEffect(() => {
    if (!bubble?.rect || !fabVisible) setFabDodge(null)
  }, [bubble?.rect, fabVisible])
  useEffect(() => {
    setFabDodge(null)
    fabHome.current = null
  }, [settings.fabY, settings.fabSide])
  const dragRef = useRef<{ startY: number; startX: number; moved: boolean; pointer: number } | null>(null)

  const onFabDown = (e: PointerEvent) => {
    dragRef.current = { startY: e.clientY, startX: e.clientX, moved: false, pointer: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onFabMove = (e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientY - d.startY) + Math.abs(e.clientX - d.startX) < 8) return
    d.moved = true
    e.preventDefault()
    setDragY(Math.min(92, Math.max(8, (e.clientY / window.innerHeight) * 100)))
  }
  const onFabUp = (e: PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) {
      const y = Math.min(92, Math.max(8, (e.clientY / window.innerHeight) * 100))
      setDragY(null)
      updateSettings({ fabY: Math.round(y), fabSide: e.clientX < window.innerWidth / 2 ? "left" : "right" })
    } else {
      show()
    }
  }

  // ------------------------------------------------------------ derived
  const contextKind: "selection" | "page" | "none" = selection ? "selection" : pageReadable ? "page" : "none"
  const actions = historyMode
    ? []
    : contextKind === "selection" && selection
      ? SELECTION_ACTIONS.flatMap((a) => forSelection(a, selection.text) ?? [])
      : contextKind === "page" ? PAGE_ACTIONS : []
  const actionLabel = (a: Action) => a.text ?? t(a.label)

  // ------------------------------------------------------------ the guided first request (2.6, Guide.tsx)
  const reportGuide = (a: "start" | "step" | "done" | "skip" | "exit", what?: string) =>
    void sendBackground({ type: "useEvent", f: "tour", a, what, via: guideVia.current })
  /** It can start here: a page to summarize, in the panel's chat (a selection is put aside when it starts). */
  firstGuideRef.current = () => !historyMode && pageReadable
  startGuideRef.current = (via: "first" | "menu") => {
    guideVia.current = via
    setTouring(false)
    // From the "…" menu over a chat: a new one about the whole page, so Summarize is there to tap.
    if (selection) {
      forgetSelection()
      setSelection(null)
    }
    if (messages.length > 0) newChat()
    setGuide("summarize")
    reportGuide("start")
  }
  const endGuide = (a: "done" | "skip" | "exit", what?: string) => {
    const step = guideRef.current
    if (!step) return
    setGuide(null)
    if (planTour.current) {
      void markPlanToursSeen(planTour.current.plans)
      planTour.current = null
    } else {
      setTourSeen(true)
      void markTourSeen()
    }
    reportGuide(a, what ?? step)
  }
  endGuideRef.current = endGuide
  const guideTo = (step: GuideStep) => {
    if (guideRef.current === step) return
    guideRef.current = step
    setGuide(step)
    reportGuide("step", step)
  }
  guideToRef.current = guideTo
  // Which step is on follows what happens: the consent card, a question going out, its answer, the selection buttons.
  const lastRole = messages[messages.length - 1]?.role
  // The last answer (its Listen is what Ultra's tour lights up).
  let lastAnswerIdx = -1
  for (let i = messages.length - 1; i >= 0 && lastAnswerIdx < 0; i--) if (messages[i].role === "assistant" && !messages[i].note) lastAnswerIdx = i
  useEffect(() => {
    if (!guide) return
    // A plan's tour goes by its Next and the taps on what it lights up; out of the chat list, on past the chats.
    if (planTour.current) {
      // Left the place the step is shown in (Back from the chat list or Templates): on past that place's steps.
      const there = PLAN_VIEW[guide]
      if (there && view !== there && view !== "settings") planNext(there === "threads" ? "pro_askChats" : guide)
      return
    }
    const second = guide === "askSel" || guide === "answer2" || ON_PAGE.includes(guide)
    if (pending && (guide === "summarize" || guide === "askSel")) guideTo("consent")
    else if (guide === "consent" && !pending && partial === null && consent !== "ok") endGuide("exit", "declined")
    else if (streaming && !WAITING.includes(guide)) guideTo(second ? "answer2" : "answer")
    else if (error && (WAITING.includes(guide) || guide === "consent")) endGuide("exit", error.code === "LIMIT_REACHED" ? "limit" : "error")
    else if (guide === "answer2" && !streaming && !error && lastRole === "assistant") guideTo(threadList.length > 0 ? "chats" : "menu")
    else if (guide === "pick" && bubble?.rect && !open) guideTo("ask")
    else if (guide === "ask" && !bubble?.rect && !open) guideTo("pick")
    // Out of the chat list (back, a chat opened, a new one): on to the "…".
    else if (guide === "chatList" && view === "chat") guideTo("menu")
  }, [guide, pending, partial, consent, error, lastRole, bubble, open, threadList.length, view])
  // The answer step's card waits for the answer to be in.
  const guideIdle = guide !== null && !(WAITING.includes(guide) && (streaming || lastRole !== "assistant"))
  // The panel closed during a step in it (not by the guide's own "Try it"): it ends there.
  useEffect(() => {
    if (!open && guide && !ON_PAGE.includes(guide)) endGuide("exit", "closed")
  }, [open])
  /** A plan step on, where it's shown: the chat list, Templates or the chat, with the "…" menu open for the watched
   * pages (and for Find similar when the chat has no quick action for it). One update with the step, so the step is
   * never measured on the screen before. */
  const planEnter = (step: GuideStep) => {
    setView(PLAN_VIEW[step] ?? "chat")
    const menu = PLAN_MENU.includes(step) || (step === "ultra_similar" && !panelRef.current?.querySelector(".cf-empty .cf-chip[data-action=similar]"))
    setPageMenu(menu)
    guideTo(step)
  }
  const planNext = (step: GuideStep) => {
    const steps = planTour.current?.steps ?? []
    const i = steps.indexOf(step)
    if (i < 0 || i >= steps.length - 1) {
      setPageMenu(false)
      endGuide("done")
    } else planEnter(steps[i + 1])
  }
  const guideNext = () => {
    if (guide && planTour.current) return planNext(guide)
    if (guide === "answer") guideTo("select")
    else if (guide === "select") {
      guideTo("pick")
      if (!popup) hide()
    } else if (guide === "chats") guideTo("menu")
    else if (guide === "chatList") {
      setView("chat")
      guideTo("menu")
    } else if (guide === "menu") endGuide("done")
  }
  // A tap on what the step lights up: the guide goes where it leads. The other steps' taps (Summarize, the consent
  // card, a quick action) already move it on by what they start.
  const guideTap = (step: GuideStep) => {
    if (step === "chats") {
      // The list opened here too, with the step: this runs before the button's own handler, and a render between the
      // two (the chat list's step with the chat still showing) would send the guide straight on to the "…".
      setView("threads")
      guideTo("chatList")
      // The guide's card says what the list's hint would: it isn't shown again later.
      if (hints !== null && !hints.includes("chats")) doneHint("chats")
    } else if (step === "menu") endGuide("done")
    // A plan's tour: the lit-up control does its thing (✦ turns on, Listen plays, Find similar's card opens, a new
    // template starts) and the tour goes on; Watch this page or Watching ends it there.
    else if (step === "pro_watch" || step === "ultra_watch") endGuide("done")
    else if (planTour.current && PLAN_STEPS.includes(step)) planNext(step)
  }
  /** A plan's tour: what Pro or Ultra added. After the upgrade (via "plan"), or again from the "…" menu. Ultra for
   * someone coming from below Pro (and from the menu) has Pro's steps too. */
  const startPlanTour = (tier: "pro" | "ultra", via: "plan" | "plan_menu", from?: string) => {
    const full = tier === "ultra" && (via === "plan_menu" || from === "free" || from === "byok")
    const steps = tier === "pro" ? PRO_TOUR : full ? ULTRA_FULL_TOUR : ULTRA_TOUR
    planTour.current = { steps, plans: full || tier === "pro" ? (tier === "pro" ? ["pro"] : ["pro", "ultra"]) : ["ultra"] }
    guideVia.current = via
    setTouring(false)
    setView(PLAN_VIEW[steps[0]] ?? "chat")
    guideRef.current = steps[0]
    setGuide(steps[0])
    reportGuide("start", steps[0])
  }
  const startPlanTourRef = useRef(startPlanTour)
  startPlanTourRef.current = startPlanTour
  // An upgrade seen here (Free or Own key → Pro, → Ultra): its tour on the panel's next quiet moment. The first plan
  // 2.6 sees is only noted (subscribers before 2.6 aren't toured), and each plan's tour shows once by itself.
  const [planTourDue, setPlanTourDue] = useState<{ tier: "pro" | "ultra"; from: string } | null>(null)
  useEffect(() => {
    const now = status?.plan
    if (!now) return
    let live = true
    void (async () => {
      const before = await lastPlanSeen()
      if (before === now) return
      await setLastPlanSeen(now)
      if (!live || !before || (now !== "pro" && now !== "ultra") || PLAN_RANK[now] <= (PLAN_RANK[before] ?? 0)) return
      if ((await planToursSeen()).includes(now)) return
      if (live) setPlanTourDue({ tier: now, from: before })
    })()
    return () => {
      live = false
    }
  }, [status?.plan])
  useEffect(() => {
    if (!planTourDue || !open || guide || touring || view !== "chat" || streaming || partial !== null) return
    setPlanTourDue(null)
    startPlanTourRef.current(planTourDue.tier, "plan", planTourDue.from)
  }, [planTourDue, open, guide, touring, view, streaming, partial])
  const plan = status?.plan ?? "free"
  // "Ultra" on Ultra's actions for anyone without it, once the plan is known: the selection buttons come before the
  // panel has opened on a page, so their plan is read then too (below), and an Ultra subscriber never sees the mark.
  const markUltra = status !== null && !isUltra(plan)
  // Read aloud (2.6, Ultra): an answer or the page. Without Ultra, Listen opens the plans sheet on Ultra.
  const openPlans = useCallback((focus: PaidPlan, via: "listen" | "settings" | "watch" | "limit" | "similar" = "listen") => {
    setPlansOpen(focus)
    void sendBackground({ type: "useEvent", f: "plans", a: "open", via, plan: focus })
  }, [])
  if (status?.plan) planKnownRef.current = status.plan
  // The plans message in the chat (build 91): a plan and period chosen open the app on them, as the plans sheet does.
  const choosePlan = (choice: OfferChoice) => {
    openAppFromTap(touch, { target: "subscribe", plan: choice.plan, period: choice.period, feature: choice.plan === "ultra" ? "listen" : undefined })
  }
  const offerEvent = (place: OfferPlace) => (action: string, choice?: OfferChoice) =>
    void sendBackground({ type: "useEvent", f: "chat_plans", a: action, via: place, ...(choice ? { plan: choice.plan, period: choice.period } : {}) })
  const listen = useListen({
    platform,
    plan,
    speakLeft: status?.ultra?.speak ? Math.max(0, status.ultra.speak.limit - status.ultra.speak.used) : null,
    onUltra: () => openPlans("ultra"),
    follow: followLink,
    send: (message) => sendBackground(message)
  })
  // The panel closed (build 92): what isn't playing goes, its audio and clock with it; what plays goes on (it's back
  // in the bar when the panel opens again).
  // Only at the moment it closes: a text paused later (the page left, with the panel closed) keeps its notification.
  const listenAtRef = useRef(listen.state.at)
  listenAtRef.current = listen.state.at
  const listenStop = listen.stop
  useEffect(() => {
    const at = listenAtRef.current
    if (!open && at !== "idle" && at !== "playing" && at !== "loading" && at !== "handoff") listenStop()
  }, [open, listenStop])
  const listenPage = useCallback(async () => {
    if (consentRef.current !== "ok") {
      const agreed = await new Promise<boolean>((resolve) => setFindConsent({ resolve }))
      setFindConsent(null)
      if (!agreed) return
      await giveConsent()
      setConsent("ok")
    }
    const read = await source.read(false)
    void listen.start("page", { text: read.text, what: "page", lang: document.documentElement.lang || textLanguage(read.text) || t("langCode"), title: read.title || source.title(), url: source.href() })
  }, [listen.start, source])
  const ownKeyActive = viaOwnKey || (Boolean(status?.hasOwnKey) && plan !== "free")
  // The chat's memory as the next answer gets it (build 91): the whole chat for Pro and Ultra (and the own key, whose
  // subscriber pays the model) unless turned off.
  const memoryAllowed = hasPro(plan) || ownKeyActive
  const memoryOn = memoryAllowed && settings.chatMemory !== false
  // The App Store offer code for Pro, once this install has run out of free answers (Safari only).
  const offer = TARGET === "safari" && plan === "free" && !ownKeyActive ? error?.offer ?? status?.offer ?? null : null
  // Videos and PDFs on the page are read for Pro (and the user's own key); free answers say they skipped them.
  const mediaOn = readsMedia(status, TARGET)
  const tryPro = (kinds: MediaKind[]) => {
    void sendBackground({ type: "mediaNotice", action: "pro", media: kinds })
    if (offer) redeemOffer(offer.code)
    else void openApp("subscribe")
  }
  // An Own key subscriber (Safari): what Pro adds when something is refused, and a day after the first refusal of
  // the period, Pro at a discount (the app makes the discounted purchase; the panel opens it on its Pro screen).
  const byok = TARGET === "safari" && plan === "byok"
  const byokRefusedAt = status?.store?.byokRefusedAt ?? null
  const byokDiscount = byok && status?.upgradeOffer && byokRefusedAt !== null && Date.now() - byokRefusedAt >= BYOK_OFFER_AFTER_MS ? status.upgradeOffer.discount : null
  const search = status?.searchLimits ?? { freeDaily: 3, proWeekly: 50 }
  const upgrade = (where: UpsellWhere) => {
    void sendBackground({ type: "byokUpsell", action: "tap", where, period: status?.store?.period ?? null, discount: byokDiscount !== null })
    void openApp("subscribe")
  }
  const upgradeButton = (where: UpsellWhere): VNode => (
    <button type="button" class="cf-primary" onClick={() => upgrade(where)}><Icon.Sparkle size={14} /> {byokDiscount !== null ? t("upgradeProOff", byokDiscount) : t("upgradePro")}</button>
  )
  // Each refusal of an Own key subscriber is noted; the first one of the period starts the day before the discount.
  useEffect(() => {
    if (!byok || !error) return
    const where: UpsellWhere | null = error.code === "LIMIT_REACHED" ? "limit" : error.code === "SEARCH_LIMIT" ? "search" : error.code === "PRO_ONLY" ? "pro_only" : null
    if (where) void sendBackground({ type: "byokUpsell", action: "refused", where, period: status?.store?.period ?? null })
  }, [error])
  useEffect(() => {
    if (byok && upsell) void sendBackground({ type: "byokUpsell", action: "refused", where: "pro_only", period: status?.store?.period ?? null })
  }, [upsell])
  // The discount card: once per period, when the panel is open.
  const [byokCard, setByokCard] = useState(false)
  useEffect(() => {
    if (!open || byokCard || byokDiscount === null || status?.store?.byokOfferShown) return
    setByokCard(true)
    void sendBackground({ type: "byokUpsell", action: "shown", where: "offer", period: status?.store?.period ?? null, discount: true })
  }, [open, byokDiscount, status])

  // A long page counts as several answers (2.5; the server decides, from what it sends): said by the field before
  // the question goes, for the page itself (a selection, Google mode and "Ask your chats" count as one; with the
  // user's own key nothing is counted). Measured when the panel opens and after each answer.
  const [pageWeight, setPageWeight] = useState(1)
  useEffect(() => {
    if (!open) return
    try {
      setPageWeight(answerWeight(source.length()))
    } catch {
      setPageWeight(1)
    }
  }, [open, messages.length, source])
  const weightNote = pageWeight > 1 && contextKind === "page" && !googleMode && !historyMode && !noteMode && !ownKeyActive

  // ------------------------------------------------------------ "Remind me about this page" (2.5, later.ts)
  /** The window: when (this evening, tomorrow morning, in a week, a date of one's own); 2.5 (77): time only. */
  const laterSheet = (page: boolean): VNode => {
    const from = later!
    const ctx: LaterContext = {
      url: source.href(), key: source.key(), title: source.title(), selection: from.selection?.text ?? null, range: from.range,
      close: () => setLater(null),
      remind: () => setLaterFlash((n) => n + 1)
    }
    return (
      <RemindSheet
        page={page}
        later
        flash={laterFlash}
        title={t(from.selection ? "uxRemind" : "uxLaterTitle")}
        quote={from.selection?.text}
        onPick={(at, preset) => {
          setLater(null)
          void noteSelection(from.selection, "", at, preset)
        }}
        onCancel={() => setLater(null)}
        onClose={() => setLater(null)}
      >
        {laterSections().map((render, i) => <Fragment key={i}>{render(ctx)}</Fragment>)}
        {!page && (
          <button type="button" class="cf-sheet-link" onClick={() => {
            setLater(null)
            openReminders("link", "remind")
          }}>{t("uxAllReminders")}</button>
        )}
      </RemindSheet>
    )
  }
  /** The reminders still to ring in every chat (the soonest first), then watching's rows (later.ts); each list shows its own. */
  const laterItems = async (): Promise<LaterItem[]> => {
    const [{ threads }, dev] = await Promise.all([loadThreads(), thisDevice()])
    const reminders = reminderRows(threads, dev, Date.now(), (at) => remindLabel(at), (label) => t("uxOnAnotherDevice", label))
    const watches = (await Promise.all(laterSources().map((s) => s.items().catch(() => [] as LaterItem[])))).flat()
    return [...reminders, ...watches.sort((a, b) => b.sortAt - a.sortAt)]
  }
  const countOf = (items: LaterItem[]) => ({ remind: items.filter((i) => i.kind === "remind").length, watch: items.filter((i) => i.kind === "watch").length })
  const openReminders = (via: "menu" | "link", kind: LaterItem["kind"]) => {
    setLaterList(null)
    setListOpen(kind)
    void laterItems().then((items) => {
      setLaterList(items)
      const n = countOf(items)
      setLaterCount(n)
      void sendBackground({ type: "useEvent", f: "later", a: "list", what: kind, via, reminders: String(n.remind), watches: String(n.watch) })
    }).catch(() => setLaterList([]))
  }
  /** A page reminder or a watch opens its page in a new tab; a reminder on an answer or a note, its chat at it. */
  const openLaterItem = (item: LaterItem) => {
    // A source that opens its own rows (watching's window).
    const reread = () => void laterItems().then((items) => {
      setLaterList(items)
      setLaterCount(countOf(items))
    }, () => undefined)
    if (laterSources().some((s) => s.open?.(item, reread))) return
    if (item.url) {
      window.open(item.url, "_blank", "noopener")
      return
    }
    const [, chat, key] = item.id.split(":")
    const at = threadList.find((x) => x.id === chat)?.m.findIndex((m) => entryKey(m) === key) ?? -1
    setListOpen(null)
    openThread(chat, at >= 0 ? at : undefined)
  }
  const cancelLaterItem = async (item: LaterItem) => {
    if (item.kind === "remind") {
      const [, chat, key] = item.id.split(":")
      const list = (await loadThreads()).threads[chat]?.m
      const entry = list?.find((m) => entryKey(m) === key)
      if (list && entry) {
        void scheduleReminder(sendBackground, chat, entry, null, "")
        const next = list.map((m) => {
          if (entryKey(m) !== key) return m
          const { remind: _, ...rest } = m
          return rest
        })
        await saveThread(chat, next)
        if (threadRef.current === chat) setMessages(next)
        void sendBackground({ type: "uxEvent", kind: "ux_remind", action: "cancelled", what: entry.remind?.page ? "page" : entry.note ? "note" : "answer", how: "list" })
      }
    } else {
      for (const source of laterSources()) await source.cancel(item.id).catch(() => undefined)
    }
    const items = await laterItems()
    setLaterList(items)
    setLaterCount(countOf(items))
  }
  /** A reminder's new time, from the list (2.5 (75)): it rings on this device. Null once set, else why it isn't. */
  const rescheduleLaterItem = async (item: LaterItem, at: number, preset: string): Promise<string | null> => {
    const ref = reminderOf(item)
    const thread = ref ? (await loadThreads()).threads[ref.chat] : undefined
    const entry = ref && thread?.m.find((m) => entryKey(m) === ref.key)
    if (!ref || !thread || !entry) return null
    const what = entry.remind?.page ? "page" : entry.note ? "note" : "answer"
    const outcome = await scheduleReminder(sendBackground, ref.chat, entry, at, thread.title || threadTitle(thread.m))
    if (outcome !== "scheduled") {
      if (outcome === "denied") void sendBackground({ type: "uxEvent", kind: "ux_remind", action: "denied", what })
      return t(outcome === "denied" ? "uxRemindOff" : "uxRemindNone")
    }
    const dev = await thisDevice()
    await saveThread(ref.chat, withReminderAt(thread.m, ref.key, at, dev))
    if (threadRef.current === ref.chat) setMessages((list) => withReminderAt(list, ref.key, at, dev))
    void sendBackground({ type: "uxEvent", kind: "ux_remind", action: "set", what, how: "list", preset })
    const items = await laterItems()
    setLaterList(items)
    setLaterCount(countOf(items))
    return null
  }
  // The bell in the selection bubble (2.5 (77), the owner: "how do I add Remind me on the page itself?"), on any
  // selection, before the eye: the same "Remind me" window as the header's "…", with the quote; the note keeps the
  // quote and the page, the reminder opens it.
  const remindButton = (sel: SelectionInfo) => (
    <button
      type="button"
      class="cf-sel-icon cf-sel-remind"
      aria-label={t("uxRemind")}
      title={t("uxRemind")}
      {...press(() => {
        void sendBackground({ type: "useEvent", f: "later", a: "open", via: "bubble" })
        setLater({ selection: sel, range: selectedRange() })
        // The page's selection goes, and with it the system's edit menu that would stay over the window.
        document.getSelection()?.removeAllRanges()
        setBubble(null)
      })}
    >
      <Bell size={touch ? 16 : 14} />
      <span class="cf-sel-remind-l">{t("uxRemind")}</span>
    </button>
  )
  // The actions added to the selection bubble, after the bell (watching's eye); none for plain text.
  const bubbleExtras: VNode[] = bubble?.rect && !open && !popup
    ? bubbleActions().flatMap((render, i) => {
        const ctx: BubbleContext = { url: source.href(), key: source.key(), title: source.title(), selection: bubble.text, range: selectedRange(), close: () => setBubble(null) }
        const node = render(ctx)
        return node ? [<Fragment key={i}>{node}</Fragment>] : []
      })
    : []

  // The allowance under the input: short, to share the line with "Whole chat" and Get Pro; in full on hover.
  const usageLine = useMemo(() => {
    if (ownKeyActive) return { short: t("usageOwnKey"), full: t("usageOwnKey") }
    if (!usage) return { short: "", full: "" }
    const left = Math.max(0, usage.limit - usage.used)
    return hasPro(plan)
      // Ultra by its name on the line too (2.6: it said "Pro", and the full text is only a hover, none on iPhone).
      ? isUltra(plan)
        ? { short: t("usageUltraShort", left, usage.limit), full: t("usageUltra", left, usage.limit) }
        : { short: t("usageProShort", left, usage.limit), full: t("usagePro", left, usage.limit) }
      : { short: t("usageFreeShort", left, usage.limit), full: t("usageFree", left, usage.limit) }
  }, [usage, plan, ownKeyActive])

  // ------------------------------------------------------------ organizing (2.5)
  // Suggestions for the chat shown (Pro, with suggestions on): asked once an answer or a note is in, or the chat
  // opens. They belong to the chat as it was (its length) and go when it changes; at most one row under a message.
  const orgCfg = status?.organize?.config ?? DEFAULT_ORGANIZE
  const orgOn = TARGET === "safari" && hasPro(plan) && Boolean(status?.organize?.on) && settings.organize
  const [org, setOrg] = useState<{ chat: string; length: number; move: OrganizeMove | null; tags: Array<{ index: number; key: string; tag: string }> } | null>(null)
  const [cards, setCards] = useState<OrganizeCards | null>(null)
  // "Everything in one chat?" showing in this chat; the card after the third tag; the line after the first one taken
  // (the chat it was taken in: it stays there until the next question or note, never at the end of other chats).
  const [messFor, setMessFor] = useState<string | null>(null)
  const [tagsCard, setTagsCard] = useState(false)
  const [firstWin, setFirstWin] = useState<string | null>(null)
  const orgSeen = useRef(new Set<string>())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const orgEvent = (event: OrganizeEvent) => void sendBackground({ type: "organizeEvent", event })
  useEffect(() => {
    if (open) void organizeCards().then(setCards)
  }, [open])

  useEffect(() => {
    if (!open || !orgOn || streaming || historyMode || messages.length === 0) return
    const chat = threadRef.current
    const length = messages.length
    // After the answer is in, without delaying it; a fade in, not a jump.
    const timer = setTimeout(() => {
      void sendBackground<OrganizeReply>({ type: "organize", chat }).then((reply) => {
        if (reply?.ok && reply.name) void putName(chat, reply.name, "drift")
        if (!reply?.ok || threadRef.current !== chat || messagesRef.current.length !== length) return
        setOrg({ chat, length, move: reply.move, tags: reply.tags })
      })
    }, 900)
    return () => clearTimeout(timer)
  }, [open, orgOn, streaming, historyMode, messages.length, threadRef.current])

  const orgNow = org && orgOn && org.chat === threadRef.current && org.length === messages.length && !picked && !streaming ? org : null
  // Each suggestion is counted once as shown.
  useEffect(() => {
    if (!orgNow) return
    const seen: Array<[string, OrganizeEvent]> = []
    if (orgNow.move && messages[orgNow.move.start]) {
      seen.push([`m:${entryKey(messages[orgNow.move.start])}:${orgNow.move.to}`, { kind: "organize", action: "shown", what: orgNow.move.to ? "move" : "new", why: orgNow.move.why }])
    }
    for (const x of orgNow.tags) seen.push([`t:${x.key}:${x.tag}`, { kind: "organize", action: "shown", what: "tag" }])
    for (const [id, event] of seen) {
      if (orgSeen.current.has(id)) continue
      orgSeen.current.add(id)
      orgEvent(event)
    }
  }, [orgNow])

  // 2.6: the chat named by its topic, by "Name by topic" or by itself when its name no longer fit (never one the user
  // typed): the list shows it, and a bar says so, with Undo. By itself while another bar is up: quietly.
  const undoBarRef = useRef(undoBar)
  undoBarRef.current = undoBar
  const putName = async (chat: string, name: string, why: "asked" | "drift") => {
    const before = await nameThread(chat, name, why === "asked")
    if (!before) return
    setThreadList(chatList((await loadThreads()).threads))
    orgEvent({ kind: "organize", action: "accepted", what: "name", why })
    if (why === "drift" && (undoBarRef.current || threadRef.current !== chat)) return
    setUndoBar({
      text: t("orgNamed", name),
      kind: "move",
      actions: [{
        label: t("orgUndo"),
        run: () => {
          setUndoBar(null)
          void unnameThread(chat, name, before).then(() => loadThreads()).then(({ threads }) => setThreadList(chatList(threads)))
          orgEvent({ kind: "organize", action: "undone", what: "name", why })
        }
      }]
    })
  }
  const [naming, setNaming] = useState(false)
  const nameByTopic = () => {
    const chat = threadRef.current
    setNaming(true)
    void sendBackground<OrganizeNameReply>({ type: "organizeName", chat }).then((reply) => {
      setNaming(false)
      if (reply?.ok) void putName(chat, reply.name, "asked")
      else if (threadRef.current === chat) setUndoBar({ text: t("orgNameFailed"), actions: [] })
    })
  }

  // 2.6: the chats list shows how many open suggestions each chat has ("N recommendations"): asked each time the list
  // shows (and the chats change), counted once per chat as shown.
  const [recs, setRecs] = useState<Record<string, number>>({})
  const recsSeen = useRef(new Set<string>())
  useEffect(() => {
    if (!open || !orgOn || view !== "threads") return
    let live = true
    void sendBackground<OrganizeCountsReply>({ type: "organizeCounts" }).then((reply) => {
      if (!live || !reply?.ok) return
      setRecs(reply.counts)
      for (const id of Object.keys(reply.counts)) {
        if (recsSeen.current.has(id)) continue
        recsSeen.current.add(id)
        orgEvent({ kind: "organize", action: "shown", what: "badge" })
      }
    })
    return () => { live = false }
  }, [open, orgOn, view, threadList])

  // The first suggestion taken: a line that from now on they come by themselves (once).
  const won = () => {
    if (!cards || cards.firstWin) return
    setFirstWin(threadRef.current)
    void setOrganizeCards({ firstWin: true }).then(setCards)
    orgEvent({ kind: "organize_promo", action: "shown", where: "first_win" })
  }

  const takeTag = (index: number, tag: string) => {
    setMessages((list) => list.map((m, i) => (i !== index ? m : {
      ...m,
      tags: cleanTags([...(m.tags ?? []), tag]),
      accepted: { ...m.accepted, tags: cleanTags([...(m.accepted?.tags ?? []), tag]) }
    })))
    setOrg((o) => o && { ...o, tags: o.tags.filter((x) => x.index !== index) })
    orgEvent({ kind: "organize", action: "accepted", what: "tag" })
    won()
  }
  const refuseTag = (index: number, tag: string) => {
    setMessages((list) => list.map((m, i) => (i !== index ? m : { ...m, dismissed: { ...m.dismissed, tags: cleanTags([...(m.dismissed?.tags ?? []), tag]) } })))
    setOrg((o) => o && { ...o, tags: o.tags.filter((x) => x.index !== index) })
    orgEvent({ kind: "organize", action: "dismissed", what: "tag" })
  }

  /** Shows chat `id` as it is in `threads` (after a move or its undo). */
  const showChat = (id: string, threads: Threads) => {
    threadRef.current = id
    setKind(threads[id]?.kind)
    void setActiveThread(id)
    setMessages(threads[id]?.m ?? [])
    setError(null)
    setView("chat")
  }
  const undoChatMove = async (undo: MoveUndo) => {
    setUndoBar(null)
    const threads = await undoBlockMove(undo)
    showLists(threads)
    const here = threadRef.current
    if (here === undo.source || here === undo.target) showChat(threads[undo.source] && !threads[undo.source].deleted ? undo.source : here, threads)
    // Taken back: the same move isn't suggested again.
    const keys = new Set(undo.keys)
    if (threadRef.current === undo.source) {
      setMessages((list) => list.map((m) => (keys.has(entryKey(m)) ? { ...m, dismissed: { ...m.dismissed, move: true as const } } : m)))
    }
    orgEvent({ kind: "organize", action: "undone", what: undo.before.target ? "move" : "new" })
  }
  const takeMove = async (move: OrganizeMove) => {
    const source = threadRef.current
    const target = move.to ?? newThreadId()
    setOrg(null)
    const moved = await moveBlock(source, move.start, move.end, target)
    if (!moved) return
    showLists(moved.threads)
    const left = moved.threads[source]
    // The panel stays on this chat ("Open" goes to the other one), unless nothing is left in it: then it's
    // the other one already, without "Open".
    const stays = left && !left.deleted ? left : null
    if (stays) setMessages(stays.m)
    else showChat(target, moved.threads)
    orgEvent({ kind: "organize", action: "accepted", what: move.to ? "move" : "new", why: move.why })
    setUndoBar({
      text: t("orgMoved", move.toName),
      kind: "move",
      actions: [
        { label: t("orgUndo"), run: () => void undoChatMove(moved.undo) },
        ...(stays ? [{ label: t("orgOpen"), run: () => { setUndoBar(null); void loadThreads().then(({ threads }) => showChat(target, threads)) } }] : [])
      ]
    })
    won()
  }
  const refuseMove = (move: OrganizeMove) => {
    setMessages((list) => list.map((m, i) => (i < move.start || i > move.end ? m : { ...m, dismissed: { ...m.dismissed, move: true as const } })))
    setOrg((o) => o && { ...o, move: null })
    orgEvent({ kind: "organize", action: "dismissed", what: move.to ? "move" : "new", why: move.why })
  }

  // The bar lives its seconds (undoClock.ts), then goes; before that an action takes it: a question, a note, another
  // chat, a new bar or its own buttons (they clear it there). After a delete, touching or scrolling the chat leaves
  // it (2.5: a scroll used to take the Undo away). The bar after a move also goes on a scroll or a swipe, past its
  // first seconds. A pointer resting on the bar holds it.
  const barShownAt = useRef(0)
  const barUntil = useRef(0)
  const [barHeld, setBarHeld] = useState(false)
  useEffect(() => {
    setBarHeld(false)
    if (!undoBar) return
    barShownAt.current = Date.now()
    barUntil.current = barDeadline(undoBar.kind ?? "undo", barShownAt.current)
  }, [undoBar])
  useEffect(() => {
    if (!undoBar || barHeld) return
    const timer = setTimeout(() => setUndoBar(null), Math.max(0, barUntil.current - Date.now()))
    return () => clearTimeout(timer)
  }, [undoBar, barHeld])
  const holdBar = useCallback((on: boolean) => {
    if (!on) barUntil.current = deadlineAfterHold(barUntil.current, Date.now())
    setBarHeld(on)
  }, [])
  useEffect(() => {
    const list = listRef.current
    const kind = undoBar?.kind
    if (kind !== "move" || !list) return
    const goes = () => { if (goesOnWork(kind, barShownAt.current, Date.now())) setUndoBar(null) }
    // A finger that moves (a scroll or a swipe), not a tap.
    let from: { x: number; y: number } | null = null
    const start = (e: TouchEvent) => { const p = e.touches[0]; from = p ? { x: p.clientX, y: p.clientY } : null }
    const move = (e: TouchEvent) => {
      const p = e.touches[0]
      if (from && p && Math.hypot(p.clientX - from.x, p.clientY - from.y) > 12) goes()
    }
    list.addEventListener("wheel", goes, { passive: true })
    list.addEventListener("touchstart", start, { passive: true })
    list.addEventListener("touchmove", move, { passive: true })
    return () => {
      list.removeEventListener("wheel", goes)
      list.removeEventListener("touchstart", start)
      list.removeEventListener("touchmove", move)
    }
  }, [undoBar, view, open])

  // The message with text selected in it: its suggestions step aside for the Highlight bubble by the selection.
  const [selectingIdx, setSelectingIdx] = useState<number | null>(null)
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const list = listRef.current
        const root = list?.getRootNode()
        const node = root instanceof ShadowRoot ? panelSelectionStart(root) : null
        const msg = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".cf-msg")
        const idx = msg && list?.contains(msg) ? Number(msg.dataset.index) : NaN
        setSelectingIdx(Number.isInteger(idx) ? idx : null)
      }, 150)
    }
    document.addEventListener("selectionchange", onChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("selectionchange", onChange)
    }
  }, [open])

  /** The row of suggestions under the message at `idx`: its tag, and the move of the block it ends. */
  const organizeRow = (idx: number): VNode | null => {
    if (!orgNow) return null
    const tag = orgNow.tags.find((x) => x.index === idx && messages[idx] && entryKey(messages[idx]) === x.key)?.tag
    const move = orgNow.move && orgNow.move.end === idx ? orgNow.move : undefined
    if (!tag && !move) return null
    return (
      <OrganizeRow
        tag={tag}
        move={move}
        quiet={idx === selectingIdx}
        onTag={() => tag && takeTag(idx, tag)}
        onTagNo={() => tag && refuseTag(idx, tag)}
        onMove={() => move && void takeMove(move)}
        onMoveNo={() => move && refuseMove(move)}
      />
    )
  }

  // Cards: turn suggestions on (Pro, off, the chat looks like it needs them), "Everything in one chat?" (without Pro),
  // and after the third tag (without Pro). Each once; closing one is final.
  const shownChat: Thread = { id: threadRef.current, u: 0, m: messages }
  const chatBlocks = pageBlocks(messages)
  const mixed = messages.length > 0 && !historyMode && looksMixed(shownChat, orgCfg)
  const pageElsewhere = chatBlocks.length >= 2 && chatBlocks.some((b) => b.url && threadList.some((x) => x.id !== threadRef.current && x.m.some((e) => e.page?.url === b.url)))
  // Nothing until the plan is known: a Pro user mustn't see the free card while the status loads.
  const idle = status !== null && !status.offline && !streaming && !historyMode && !picked && !error
  const consentCard = TARGET === "safari" && hasPro(plan) && Boolean(status?.organize?.on) && !settings.organize && cards !== null && !cards.consent && idle && (mixed || pageElsewhere)
  const promoOk = TARGET === "safari" && !hasPro(plan) && cards !== null && idle
  const messCard = promoOk && !cards?.mess?.closed && (messFor === threadRef.current ||
    (mixed && !cards?.mess?.chats.includes(threadRef.current) && Date.now() - (cards?.mess?.at ?? 0) > orgCfg.messHours * 3_600_000))
  useEffect(() => {
    if (!messCard || messFor === threadRef.current) return
    const id = threadRef.current
    setMessFor(id)
    void setOrganizeCards({ mess: { chats: [...(cards?.mess?.chats ?? []), id].slice(-50), at: Date.now() } }).then(setCards)
    orgEvent({ kind: "organize_promo", action: "shown", where: "inchat_mess" })
  }, [messCard])
  // They come after the chat (once the plan is known): bring them into view, as the offer card does.
  const chatCard = consentCard || messCard
  useEffect(() => {
    if (chatCard) requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }))
  }, [chatCard])
  useEffect(() => {
    if (upsell && TARGET === "safari" && !hasPro(plan)) orgEvent({ kind: "organize_promo", action: "shown", where: "pro_card" })
  }, [upsell])

  /** Tags the user set on a message: after their third tag in all, what organizing does (without Pro, once). */
  const userTags = (index: number, next: string[]) => {
    const known = new Set(allTags(threadList).map((x) => x.tag.toLowerCase()))
    for (const m of messages) for (const tag of m.tags ?? []) known.add(tag.toLowerCase())
    const added = cleanTags(next).filter((tag) => !known.has(tag.toLowerCase())).length
    tagMessage(index, next)
    if (known.size < 3 && known.size + added >= 3 && TARGET === "safari" && !hasPro(plan) && cards && !cards.thirdTag) {
      setTagsCard(true)
      void setOrganizeCards({ thirdTag: true }).then(setCards)
      orgEvent({ kind: "organize_promo", action: "shown", where: "third_tag" })
    }
  }
  const turnOnOrganize = (from: "card" | "settings") => {
    updateSettings({ organize: true })
    void setOrganizeCards({ consent: "accepted" }).then(setCards)
    orgEvent({ kind: "organize_optin", action: "accepted", from })
  }
  const tryOrganizePro = (where: "inchat_mess" | "third_tag" | "settings") => {
    orgEvent({ kind: "organize_promo", action: "tap", where })
    if (byok) upgrade("pro_only")
    else void openApp("subscribe", "organize")
  }
  const organizeCardsView = (
    <>
      {consentCard && (
        <OrganizeCard
          kind="consent"
          onPrimary={() => turnOnOrganize("card")}
          onClose={() => {
            void setOrganizeCards({ consent: "declined" }).then(setCards)
            orgEvent({ kind: "organize_optin", action: "declined", from: "card" })
          }}
        />
      )}
      {messCard && (
        <OrganizeCard
          kind="mess"
          pro={byok ? (byokDiscount !== null ? t("upgradeProOff", byokDiscount) : t("upgradePro")) : undefined}
          onPrimary={() => tryOrganizePro("inchat_mess")}
          onClose={() => {
            setMessFor(null)
            void setOrganizeCards({ mess: { chats: cards?.mess?.chats ?? [], at: cards?.mess?.at ?? Date.now(), closed: true } }).then(setCards)
          }}
        />
      )}
      {tagsCard && !messCard && promoOk && (
        <OrganizeCard kind="tags" pro={byok ? t("upgradePro") : undefined} onPrimary={() => tryOrganizePro("third_tag")} onClose={() => setTagsCard(false)} />
      )}
      {firstWin === threadRef.current && orgOn && <div class="cf-org-win" role="status"><Icon.Sparkle size={13} /> {t("orgFirstWin")}</div>}
    </>
  )

  const theme = settings.theme === "auto" ? undefined : settings.theme
  // The last message is a question still without an answer (a note doesn't count).
  const lastIsUser = isQuestion(messages[messages.length - 1])
  // The conversation was last on another page: offer this page's actions.
  const onNewPage = messages.length > 0 && Boolean(lastPage(messages)) && lastPage(messages)?.url !== pageUrl

  // ------------------------------------------------------------ render
  return (
    <div class="cf" data-theme={theme} data-size={settings.textSize} data-layout={layout} data-touch={touch ? "1" : undefined}>
      {fabVisible && (
        <button
          type="button"
          ref={fabRef}
          class={`cf-fab ${settings.fabSide === "left" ? "left" : "right"} ${dragY === null ? "glide" : ""}`}
          style={{ top: dragY !== null ? `${dragY}%` : fabDodge !== null ? `${fabDodge}px` : `${settings.fabY}%` }}
          aria-label={t("fabLabel")}
          title={t("fabLabel")}
          onPointerDown={onFabDown}
          onPointerMove={onFabMove}
          onPointerUp={onFabUp}
          onPointerCancel={() => {
            dragRef.current = null
            setDragY(null)
          }}
        >
          <Icon.Sparkle size={22} />
          {jobs.unread.size > 0 && <span class="cf-fab-dot" role="status" aria-label={t("busyNew")} />}
        </button>
      )}

      {/* The page reminder is set: said here too (on iPhone the selection, and its buttons, are gone by now). */}
      {remindSaved !== null && !bubble?.rect && !open && (
        <div class="cf-toast cf-snack" role="status" style={{ top: `${(window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight) - 64}px` }}>
          <Bell size={14} /> {remindSaved > 0 ? t("uxRemindSaved", remindLabel(remindSaved)) : remindSaved < 0 ? t("uxRemindNotSet") : t("uxRemindNoApp")}
        </div>
      )}
      {later && !open && laterSheet(true)}
      {guide === "pick" && !open && !bubble?.rect && <GuidePill touch={touch} onSkip={() => endGuide("skip")} />}

      {bubble?.rect && !open && !popup && (
        <SelectionBubble rect={bubble.rect} touch={touch} guide={guide === "ask"} onPlace={onBubblePlace}>
          {noteSaved ? (
            <div class="cf-bubble-saved" role="status">
              <span><Icon.Check /> {remindSaved === null ? t("selNoteSaved") : remindSaved > 0 ? t("uxRemindSaved", remindLabel(remindSaved)) : remindSaved < 0 ? t("uxRemindNotSet") : t("uxRemindNoApp")}</span>
              <button type="button" {...press(() => show())}>{t("selNoteOpen")}</button>
            </div>
          ) : (
            <>
              <div class="cf-bubble-row">
                {touch ? (
                  <>
                    {/* "Ask AI" always (the owner, build 75: shorter and clearer than "Ask ContextFlow"), and Google by its word. */}
                    <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={16} /> {t("selAsk")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}>{t("actGoogle")}</button>
                    <button type="button" class="cf-sel-template" aria-label={t("qiTemplateButton")} title={t("qiTemplateButton")} {...press(() => newTemplate(bubble))}><QIcon.Template /> <span class="cf-sel-l">{t("qiTemplateButton")}</span></button>
                    {remindButton(bubble)}
                    {bubbleExtras}
                  </>
                ) : (
                  <>
                    <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={14} /> {t("selAsk")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[0]), 60) })}>{t("selExplain")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[2]), 60) })}>{t("selTranslate")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}><Icon.Search size={13} /> {t("actGoogle")}</button>
                    {/* 2.6 (build 89, the owner): Find similar from a selection too, not only from the panel. */}
                    <button type="button" class="cf-sel-similar ultra" title={t("actSimilar")} {...press(() => {
                      void sendBackground({ type: "useEvent", f: "bubble", a: "action", what: "sel_similar", via: "button" })
                      show(bubble)
                      setTimeout(() => runActionRef.current(selAction("sel_similar")), 60)
                    })}><SimilarIcon size={13} /> {t("selSimilar")}<UltraMark show={markUltra} /></button>
                    <button type="button" class="cf-sel-template" aria-label={t("qiTemplateButton")} title={t("qiTemplateButton")} {...press(() => newTemplate(bubble))}><QIcon.Template size={14} /> <span class="cf-sel-l">{t("qiTemplateButton")}</span></button>
                    {remindButton(bubble)}
                    {bubbleExtras}
                  </>
                )}
              </div>
              <div class="cf-bubble-ask">
                <SelField touch={touch} placeholder={t("selQuestion")} markUltra={markUltra} chips={touch && !selDraft && !selFocus ? SEL_CHIPS.flatMap((id) => forSelection(selAction(id), bubble.text) ?? []) : []} onChip={(a) => {
                  selFeatureUsed()
                  void sendBackground({ type: "useEvent", f: "bubble", a: "action", what: a.id, via: "chip" })
                  show(bubble)
                  setTimeout(() => runActionRef.current(a), 60)
                }}>
                <input
                  type="text"
                  value={selDraft}
                  placeholder={t(touch ? "selQuestion" : "placeholderSelection")}
                  aria-label={t("placeholderSelection")}
                  enterKeyHint="send"
                  autoComplete="off"
                  onFocus={() => {
                    selTyping.current = true
                    setSelFocus(true)
                  }}
                  onBlur={() => {
                    selTyping.current = false
                    setSelFocus(false)
                  }}
                  onInput={(e) => setSelDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.isComposing) {
                      e.preventDefault()
                      askAboutSelection(bubble, selDraft)
                    } else if (e.key === "Escape") {
                      selTyping.current = false
                      setBubble(null)
                    }
                    e.stopPropagation()
                  }}
                  onKeyUp={(e) => e.stopPropagation()}
                  onKeyPress={(e) => e.stopPropagation()}
                />
                </SelField>
                {/* iPhone and iPad: send shows once there's a question, so the field has room for it. */}
                {(!touch || selDraft.trim()) && <button type="button" class="cf-bubble-send" disabled={!selDraft.trim()} aria-label={t("send")} title={t("send")} {...press(() => askAboutSelection(bubble, selDraft))}><Icon.ArrowUp /></button>}
                <button type="button" class="cf-sel-note" title={t("selNoteTitle")} aria-label={t("selNote")} {...press(() => void noteSelection(bubble, selDraft))}><Icon.Pencil />{!(touch && narrowScreen()) && ` ${t("selNote")}`}</button>
              </div>
              {guide === "ask" ? (
                <div class="cf-bubble-hint guide">{t(touch ? "guideTapAskTouch" : "guideTapAskMouse", t("selAsk"))}</div>
              ) : (
                <>
                  {selHint && <div class="cf-bubble-hint">{t("selHint")}</div>}
                  {!selHint && <SelIconsTip watching={listsKind("watch")} />}
                </>
              )}
            </>
          )}
        </SelectionBubble>
      )}

      {open && layout === "sheet" && (
        <div
          class={`cf-backdrop ${visible ? "in" : ""}`}
          // Ignore the click of the very tap that opened the panel.
          onClick={() => Date.now() - openedAt.current > 500 && hide()}
          onTouchMove={(e) => e.preventDefault()}
        />
      )}

      {open && (
        <section
          ref={panelRef}
          class={`cf-panel ${visible ? "in" : ""}`}
          role="dialog"
          aria-label="ContextFlow"
          style={layout === "sheet" && keyboard ? { bottom: `${keyboard}px`, maxHeight: `${window.visualViewport?.height ?? window.innerHeight}px` } : undefined}
        >
          {layout === "sheet" && <div class="cf-grabber" onClick={hide} />}
          <header class="cf-header">
            {view !== "chat" ? (
              <button type="button" class="cf-icon" onClick={() => setView(view === "trash" ? "threads" : "chat")} aria-label={t("back")}><Icon.Back /></button>
            ) : (
              <span class="cf-logo"><Icon.Sparkle size={18} /></span>
            )}
            <div class="cf-title">
              {view !== "chat" ? (
                <strong>{view === "settings" ? t("settings") : view === "templates" ? t("qiTemplatesTitle") : view === "trash" ? t("trashTitle") : t("chatsTitle")}</strong>
              ) : (
                historyMode ? (
                  <span class="cf-ctx history"><Icon.Sparkle size={13} /> <span class="cf-ctx-text">{t("askHistory")}</span></span>
                ) : <ContextChip
                  kind={contextKind}
                  media={source.kind()}
                  title={source.title()}
                  words={selection?.words ?? 0}
                  text={selection?.text ?? ""}
                  onClear={() => {
                    forgetSelection()
                    setSelection(null)
                  }}
                />
              )}
            </div>
            {view === "chat" && messages.length > 0 && partial === null && (
              <button type="button" class="cf-icon" onClick={() => (picked ? setPicked(null) : pickMessages())} aria-pressed={Boolean(picked)} aria-label={t("shareChat")} title={chatCopied ? t("copied") : t("shareChat")}>
                {chatCopied ? <Icon.Check /> : <Icon.Share />}
              </button>
            )}
            {/* With every chat in Recently Deleted, still the way to it. */}
            {view === "chat" && (threadList.length > 0 || trashList.length > 0) && (
              <button type="button" class="cf-icon cf-chats-button" onClick={() => setView("threads")} aria-label={t("allChats")} title={t("allChats")}>
                <Icon.Chats />
                {threadList.length > 0 && <span class="cf-badge">{threadList.length}</span>}
              </button>
            )}
            {((view === "chat" && messages.length > 0) || view === "threads") && (
              <button type="button" class="cf-icon" onClick={newChat} aria-label={t("newChat")} title={t("newChat")}><Icon.Plus /></button>
            )}
            {view === "chat" && (
              <span class="cf-page-more-wrap">
                <button type="button" class="cf-icon cf-page-more" aria-haspopup="menu" aria-expanded={pageMenu} aria-label={t("uxMorePage")} title={t("uxMorePage")} onClick={() => {
                  // Opened, and which item: to see whether Settings is still found a tap further.
                  if (!pageMenu) {
                    void sendBackground({ type: "useEvent", f: "menu", a: "open" })
                    void laterItems().then((items) => setLaterCount(countOf(items))).catch(() => setLaterCount({ remind: 0, watch: 0 }))
                  }
                  setPageMenu(!pageMenu)
                }}><More size={18} /></button>
                {pageMenu && (
                  <PageMenu
                    onLater={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "later" })
                      void sendBackground({ type: "useEvent", f: "later", a: "open", via: "menu" })
                      setLater({ selection, range: selectedRange() })
                    }}
                    onWatchPage={listsKind("watch") && pageWatcher() ? () => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "watch_page" })
                      pageWatcher()?.({ url: source.href(), title: source.title() })
                    } : undefined}
                    onSimilar={contextKind === "page" && !historyMode ? () => openSimilar("menu") : undefined}
                    onNameChat={orgOn && view === "chat" && !historyMode && messages.length > 0 && !naming ? () => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "name_chat" })
                      nameByTopic()
                    } : undefined}
                    similarLocked={!similarAllowed(plan)}
                    reminders={laterCount.remind}
                    watches={listsKind("watch") ? laterCount.watch : null}
                    onReminders={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "reminders" })
                      openReminders("menu", "remind")
                    }}
                    onWatching={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "watching" })
                      openReminders("menu", "watch")
                    }}
                    onTips={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "tips" })
                      setTipsOpen(true)
                    }}
                    onSettings={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "settings" })
                      setView("settings")
                    }}
                    onListen={TARGET === "safari" && source.readable() && source.kind() === "page" ? () => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "listen" })
                      void listenPage()
                    } : undefined}
                    ultra={isUltra(plan)}
                    planTour={plan === "pro" || plan === "ultra" ? {
                      label: t("ptMenu", plan === "ultra" ? t("planUltra") : t("planPro")),
                      start: () => {
                        setPageMenu(false)
                        void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "plan_tour" })
                        startPlanTour(plan, "plan_menu")
                      }
                    } : undefined}
                    onIntro={firstGuideRef.current() ? () => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "intro" })
                      startGuideRef.current("menu")
                    } : undefined}
                    onClose={() => setPageMenu(false)}
                  />
                )}
              </span>
            )}
            <button type="button" class="cf-icon" onClick={hide} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
          </header>

          {view === "threads" ? (
            <>
              {hintDue("chats") && threadList.length > 0 && guide !== "chatList" && !(guide && PLAN_VIEW[guide] === "threads") && (
                <div class="cf-upsell-wrap">
                  <Hint icon={<Icon.Chats />} title={t("hintChatsTitle")} onDone={() => doneHint("chats")}>{t("hintChatsBody")}</Hint>
                </div>
              )}
              {findConsent && (
                <div class="cf-upsell-wrap">
                  <ConsentCard again={consent === "old"} onAccept={() => findConsent.resolve(true)} onDecline={() => findConsent.resolve(false)} />
                </div>
              )}
              {upsell && (
                <div class="cf-upsell-wrap">
                  <ProUpsell
                    feature={upsell}
                    offer={TARGET === "safari" && plan === "free" ? status?.offer ?? null : null}
                    byok={byok ? { discount: byokDiscount } : undefined}
                    onPro={() => (byok ? upgrade("pro_only") : void openApp("subscribe", "ai"))}
                    onOffer={redeemOffer}
                    onClose={() => setUpsell(null)}
                  />
                </div>
              )}
              <ThreadsView
                threads={threadList}
                activeId={threadRef.current}
                onOpen={(id, at) => {
                  if (orgOn && recs[id]) orgEvent({ kind: "organize", action: "tap", what: "badge" })
                  openThread(id, at)
                }}
                onRename={renameChat}
                onDelete={deleteChatWithUndo}
                onNew={newChat}
                onPin={pinChat}
                onMove={moveChat}
                onOpenPage={openPage}
                pro={hasPro(plan)}
                onAskHistory={askHistory}
                onFind={findChats}
                findWaiting={findConsent !== null}
                onUpsell={setUpsell}
                findError={(code) => (code === "LIMIT_REACHED" ? t("limitProTitle") : errorText({ code: code as ErrorCode }))}
                onTags={tagChat}
                grouped={settings.groupByTags}
                onGrouped={(on) => updateSettings({ groupByTags: on })}
                touch={touch}
                trashCount={trashList.length}
                busy={jobs.running}
                unread={jobs.unread}
                onOpenTrash={() => {
                  setUndoBar(null)
                  setView("trash")
                }}
                recs={orgOn ? recs : undefined}
              />
              <div class="cf-undo-host">{undoBar && <UndoBar text={undoBar.text} actions={undoBar.actions} onHold={holdBar} />}</div>
            </>
          ) : view === "trash" ? (
            <TrashView
              threads={trashList}
              onRestore={(id) => restoreFromTrash(id, "list")}
              onDelete={(id) => purgeFromTrash([id])}
              onDeleteAll={() => purgeFromTrash(trashList.map((th) => th.id))}
            />
          ) : view === "templates" ? (
            <TemplatesView
              touch={touch}
              consent={consent}
              onConsent={agreeQuietly}
              host={source.site()}
              onInsert={(tpl) => {
                hide()
                setTimeout(() => bus.dispatchEvent(new CustomEvent(QI_EVENTS.insertTemplate, { detail: tpl })), layout === "sheet" ? 240 : 0)
              }}
            />
          ) : view === "settings" ? (
            <SettingsView
              settings={settings}
              status={status}
              usage={usage}
              platform={platform}
              site={source.site()}
              onChange={(patch) => {
                if (patch.organize === true) turnOnOrganize("settings")
                else updateSettings(patch)
              }}
              onOrganizePro={() => tryOrganizePro("settings")}
              onUpgrade={() => (byok ? upgrade("settings") : void openApp("subscribe"))}
              onPlans={() => openPlans(hasPro(plan) || byok ? "ultra" : "pro", "settings")}
              onYearly={(chosen) => {
                void sendBackground({ type: "useEvent", f: "plans", a: "yearly", plan: chosen, period: "yearly" })
                openAppFromTap(touch, { target: "subscribe", plan: chosen, period: "yearly" })
              }}
              upgradeLabel={byokDiscount !== null ? t("upgradeProOff", byokDiscount) : t("upgradePro")}
              onManage={() => void openApp("manage")}
              onStatusChange={() => void refreshStatus(true)}
              onOpenUrl={(url) => void sendBackground({ type: "openUrl", url })}
              onOpenTemplates={() => setView("templates")}
              onSocial={(network) => {
                reportInsert({ kind: "social_open", network })
                void sendBackground({ type: "openUrl", url: network === "x" ? LINKS.x : LINKS.threads })
              }}
              onShowTour={() => {
                setView("chat")
                setTouring(true)
                setHints([])
                void resetHints()
              }}
              onChatsDeleted={() => {
                setMessages([])
                setError(null)
                setThreadList([])
                setTrashList([])
                void loadThreads().then(({ active }) => {
                  threadRef.current = active.id
                })
              }}
            />
          ) : (
            <>
              <div class="cf-messages" ref={listRef} onClick={ux.onListClick}>
                {!picked && ux.strip}
                {historyMode && messages.length === 0 && partial === null && (
                  <div class="cf-empty">
                    <div class="cf-empty-icon"><Icon.Sparkle size={28} /></div>
                    <h2>{t("askHistory")}</h2>
                    <p>{t("askHistoryEmpty")}</p>
                    <div class="cf-actions">
                      {(["askHistoryEx1", "askHistoryEx2", "askHistoryEx3"] as const).map((key) => (
                        <button type="button" key={key} class="cf-chip" onClick={() => ask(t(key))}>{t(key)}</button>
                      ))}
                    </div>
                  </div>
                )}

                {!historyMode && messages.length === 0 && partial === null && (
                  <div class="cf-empty">
                    <div class="cf-empty-icon"><Icon.Sparkle size={28} /></div>
                    <h2>{t("emptyTitle")}</h2>
                    <p>{t(contextKind === "selection" ? "emptySelection" : contextKind === "page" ? (source.kind() === "video" ? (mediaOn ? "emptyVideo" : "emptyVideoFree") : source.kind() === "pdf" ? (mediaOn ? "emptyPdf" : "emptyPdfFree") : "emptyPage") : "emptyNone")}</p>
                    {actions.length > 0 && (
                      <div class="cf-actions">
                        {actions.map((a) => (
                          ULTRA_ACTIONS.has(a.id)
                            ? <button type="button" key={a.id} class="cf-chip ultra" data-action={a.id} onClick={() => runAction(a)}><SimilarIcon size={13} /> {actionLabel(a)}<UltraMark show={markUltra} /></button>
                            : <button type="button" key={a.id} class="cf-chip" data-action={a.id} onClick={() => runAction(a)}>{actionLabel(a)}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {messages.map((m, idx) =>
                  m.role === "user" ? (
                    <div class={`cf-msg user ${m.note ? "note" : ""} ${m.pinned ? "pinned-msg" : ""} ${picked ? "pickable" : ""} ${picked?.has(idx) ? "picked" : ""}`} key={idx} data-index={idx} {...pickProps(idx)} onContextMenu={m.note && !picked ? ux.contextMenu(idx) : undefined}>
                      <PageDivider entries={messages} index={idx} onOpen={openPage} />
                      {m.note ? (
                        ux.wrap(m, idx, (
                          <div class="cf-bubble-note" dir="auto">
                            <span class="cf-note-mark" aria-label={t("shareNote")}><Icon.Pencil /></span>{m.content}
                          </div>
                        ), !picked)
                      ) : (
                        <div class="cf-bubble-user" dir="auto">
                          {m.mode === "google" && <span class="cf-user-mode"><Icon.Search size={12} /></span>}
                          {m.similarAsk !== undefined && <span class="cf-user-mode" title={t("similarTitle")} aria-label={t("similarTitle")}><SimilarIcon size={12} /></span>}
                          {m.label ?? m.content}
                        </div>
                      )}
                      {m.sources && m.sources.length > 0 && <UsedSources notes={m.sources} />}
                      {m.note && messageFooter(m, idx, () => noteCopyText(m), () => noteShareText(messages, idx, shareLabels(chatLanguage(messages)), shareLinks()))}
                    </div>
                  ) : (
                    <div class={`cf-msg ai ${m.pinned ? "pinned-msg" : ""} ${picked ? "pickable" : ""} ${picked?.has(idx) ? "picked" : ""}`} key={idx} data-index={idx} {...pickProps(idx)} onContextMenu={picked ? undefined : ux.contextMenu(idx)}>
                      {ux.wrap(m, idx, (
                        <>
                          {m.grounding && <div class="cf-grounded"><Icon.Search size={13} /> {t("googleBadge")}</div>}
                          {m.similar ? (
                            <SimilarList answer={m.similar} items={m.similar.items} onOpen={openPage} onWatch={listsKind("watch") ? watchItem : undefined} />
                          ) : (
                            <Markdown text={m.content} marks={m.marks} onCopyCode={(code) => void copyText(code)} />
                          )}
                          {m.grounding && <Sources grounding={m.grounding} />}
                          {!mediaOn && <MediaSkipped kinds={skippedFor(messages, idx)} onPro={tryPro} />}
                        </>
                      ), !picked)}
                      {messageFooter(m, idx, () => toPlainText(m.content), () => answerShareText(messages, idx, shareLabels(chatLanguage(messages)), shareLinks()))}
                    </div>
                  )
                )}

                {partial !== null && (
                  <div class="cf-msg ai">
                    {similarRun ? <SimilarList items={similarRun.items} step={similarRun.step} pages={similarRun.pages} onOpen={openPage} /> : partial ? <Markdown text={partial} /> : <div class="cf-thinking"><span /><span /><span /> {t(reading === "video" ? "readingVideo" : reading === "pdf" ? "readingPdf" : streamMode === "google" ? "searching" : "thinking")}</div>}
                  </div>
                )}

                {similarCard === "pick" && partial === null && (
                  <SimilarPicker
                    title={similarSubject ? t("noteQuote", clip(similarSubject, 140)) : source.title() || source.site()}
                    onFind={(condition, label) => {
                      if (!similarSubject) return findSimilar(condition, label)
                      // What was selected, in the question: "Find similar: “…”" (and the condition after it).
                      const quote = t("noteQuote", clip(similarSubject, 60))
                      findSimilar(condition, condition ? `${quote} · ${label}` : quote, false, similarSubject)
                    }}
                    onClose={() => setSimilarCard(null)}
                  />
                )}
                {similarCard === "upsell" && (
                  <PlanOffer
                    place="ultra_only"
                    status={status}
                    title={t("similarTitle")}
                    body={t("similarUpsellText")}
                    lines={[t("similarUpsellChecked"), t("similarUpsellConditions"), t("similarUpsellWatch")]}
                    plans={["ultra"]}
                    onChoose={(choice) => { setSimilarCard(null); choosePlan(choice) }}
                    onEvent={offerEvent("ultra_only")}
                    onClose={() => setSimilarCard(null)}
                  />
                )}
                {similarCard !== null && typeof similarCard === "object" && (
                  <div class="cf-card limit cf-similar-limit">
                    <p>{t("similarLimit", String(similarCard.limit?.limit ?? ""), similarCard.limit?.resetsAt ? new Date(similarCard.limit.resetsAt).toLocaleDateString(undefined, { weekday: "long" }) : "")}</p>
                    <div class="cf-card-actions"><button type="button" class="cf-secondary" onClick={() => setSimilarCard(null)}>{t("close")}</button></div>
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && onNewPage && (
                  <div class="cf-newpage">
                    <div class="cf-divider"><span>{t("nowOnPage", source.title() || source.site())}</span></div>
                    <div class="cf-actions follow">
                      {actions.slice(0, 4).map((a) => (
                        <button type="button" key={a.id} class="cf-chip small" onClick={() => runAction(a)}>{actionLabel(a)}</button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && !onNewPage && messages.length < 3 && (
                  <div class="cf-actions follow">
                    {actions.filter((a) => !messages.some((m) => m.label === actionLabel(a))).slice(0, 3).map((a) => (
                      <button type="button" key={a.id} class="cf-chip small" onClick={() => runAction(a)}>{actionLabel(a)}</button>
                    ))}
                  </div>
                )}

                {/* 2.6 (91): a long answer for this chat under way off the panel (Find similar in the background). */}
                {jobs.running.has(threadRef.current) && partial === null && (
                  <div class="cf-busy-row" role="status"><span class="cf-busy-spin" aria-hidden="true" /> {t("busyWorking")}</div>
                )}
                {organizeCardsView}

                {byokCard && byokDiscount !== null && !error && partial === null && (
                  <div class="cf-card offer">
                    <strong>{t("byokOfferTitle", byokDiscount)}</strong>
                    <p>{t("byokOfferBody", PRO_WEEKLY, search.proWeekly)}</p>
                    <div class="cf-card-actions">
                      <button type="button" class="cf-primary" onClick={() => { setByokCard(false); upgrade("offer") }}><Icon.Sparkle size={14} /> {t("upgradeProOff", byokDiscount)}</button>
                      <button type="button" class="cf-secondary" onClick={() => setByokCard(false)}>{t("offerLater")}</button>
                    </div>
                  </div>
                )}

                {renewal && !error && partial === null && (
                  <div class={`cf-card renewal ${renewal === "thanks" ? "done" : ""}`} role="group" aria-label={t("renewalBody")}>
                    {renewal === "thanks" ? (
                      <p>{t("renewalThanks")}</p>
                    ) : (
                      <>
                        <strong>{t("renewalTitle", status?.store?.expiresAt ? new Date(status.store.expiresAt).toLocaleDateString() : "")}</strong>
                        <p>{t("renewalBody")}</p>
                        <div class="cf-renewal-reasons">
                          {RENEWAL_REASONS.map((reason) => (
                            <button type="button" key={reason} class="cf-chip small" onClick={() => answerRenewal(reason)}>{t(RENEWAL_LABELS[reason])}</button>
                          ))}
                        </div>
                        <div class="cf-card-actions">
                          <button type="button" class="cf-link" onClick={() => answerRenewal("later")}>{t("offerLater")}</button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {offerCard && offer && !error && partial === null && (
                  <div class="cf-card offer">
                    <strong>{t("offerCardTitle")}</strong>
                    <p>{t("offerCardBody", offer.discount, PRO_WEEKLY)}</p>
                    <div class="cf-card-actions">
                      <button type="button" class="cf-primary" onClick={() => closeOfferCard(offer.code)}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
                      <button type="button" class="cf-secondary" onClick={() => closeOfferCard(null)}>{t("offerLater")}</button>
                    </div>
                  </div>
                )}

                {error && error.code === "LIMIT_REACHED" && (() => {
                  const resetsAt = error.usage?.resetsAt ?? usage?.resetsAt
                  const back = error.usage?.limit ?? usage?.limit ?? 5
                  // A long page: some answers are left, but fewer than it counts as (2.5).
                  const left = Math.max(0, (error.usage?.limit ?? 0) - (error.usage?.used ?? 0))
                  const long = (error.weight ?? 1) > 1 && left > 0
                  // Free and Pro (build 91): the plans message in the chat, Retry once the answers are back. An own key
                  // subscriber, and Ultra (nothing above it), keep the card.
                  if (!byok && !isUltra(plan)) {
                    const event = offerEvent("limit")
                    return (
                      <PlanOffer
                        place="limit"
                        status={status}
                        title={long ? t("limitLongTitle") : hasPro(plan) ? t("limitProTitle") : t("limitFreeTitle")}
                        body={<>
                          {long && `${t("limitLongBody", error.weight!, left)} `}
                          {hasPro(plan) ? t("limitProBody", timeUntil(resetsAt)) : t("limitFreeBack", back, clockTime(resetsAt), timeUntil(resetsAt))}
                        </>}
                        plans={hasPro(plan) ? ["ultra"] : ["pro", "ultra"]}
                        retryAt={resetsAt ? Date.parse(resetsAt) : null}
                        onRetry={lastIsUser ? () => retry() : undefined}
                        onChoose={choosePlan}
                        onEvent={event}
                        extra={<>
                          {offer && (
                            <div class="cf-card-actions">
                              <button type="button" class="cf-secondary" onClick={() => { event("discount"); redeemOffer(offer.code) }}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
                            </div>
                          )}
                          <p class="cf-limit-notes">
                            <Icon.Pencil /> {t("limitNotes")}{" "}
                            <button type="button" class="cf-link" onClick={() => { event("note"); writeNote() }}>{t("writeNote")}</button>
                          </p>
                          {!hasPro(plan) && TARGET === "safari" && (
                            <p class="cf-offer-own"><button type="button" class="cf-link" onClick={() => { event("own_key"); setView("settings") }}>{t("useOwnKey")}</button></p>
                          )}
                        </>}
                      />
                    )
                  }
                  return (
                    <div class="cf-card limit">
                      <strong>{long ? t("limitLongTitle") : hasPro(plan) ? t("limitProTitle") : byok ? t("byokLimitTitle") : t("limitFreeTitle")}</strong>
                      <p>
                        {long && `${t("limitLongBody", error.weight!, left)} `}
                        {hasPro(plan)
                          ? t("limitProBody", timeUntil(resetsAt))
                          : byok
                            ? `${t("limitFreeBack", back, clockTime(resetsAt), timeUntil(resetsAt))} ${status?.hasOwnKey ? t("byokLimitGoogle", back, PRO_WEEKLY) : t("byokLimitNoKey", back, PRO_WEEKLY)}`
                            : `${t("limitFreeBack", back, clockTime(resetsAt), timeUntil(resetsAt))} ${offer ? t("offerLimit", offer.discount, PRO_WEEKLY) : t("limitFreePro", PRO_WEEKLY)}`}
                      </p>
                      <p class="cf-limit-notes">
                        <Icon.Pencil /> {t("limitNotes")}{" "}
                        <button type="button" class="cf-link" onClick={writeNote}>{t("writeNote")}</button>
                      </p>
                      {byok && (
                        <div class="cf-card-actions">
                          {upgradeButton("limit")}
                          {!status?.hasOwnKey && <button type="button" class="cf-secondary" onClick={() => setView("settings")}>{t("useOwnKey")}</button>}
                        </div>
                      )}
                      {!hasPro(plan) && !byok && (
                        <div class="cf-card-actions">
                          {offer ? (
                            <button type="button" class="cf-primary" onClick={() => redeemOffer(offer.code)}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
                          ) : (
                            <button type="button" class="cf-primary" onClick={() => void openApp("subscribe")}><Icon.Sparkle size={14} /> {t("getPro")}</button>
                          )}
                          <button type="button" class="cf-secondary" onClick={() => setView("settings")}>{t("useOwnKey")}</button>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {error && error.code === "PRO_ONLY" && (byok ? (
                  <ProUpsell
                    feature="history"
                    offer={offer}
                    byok={{ discount: byokDiscount }}
                    onPro={() => upgrade("pro_only")}
                    onOffer={redeemOffer}
                    onClose={() => setError(null)}
                  />
                ) : (
                  <PlanOffer
                    place="pro_only"
                    status={status}
                    title={t("upsellHistoryTitle")}
                    lines={[t("upsellHistoryText"), t("upsellFindText"), t("upsellOrganizeText")]}
                    onChoose={choosePlan}
                    onEvent={offerEvent("pro_only")}
                    onClose={() => setError(null)}
                    extra={offer ? (
                      <div class="cf-card-actions">
                        <button type="button" class="cf-secondary" onClick={() => { offerEvent("pro_only")("discount"); redeemOffer(offer.code) }}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
                      </div>
                    ) : undefined}
                  />
                ))}

                {memoryOffer && !error && partial === null && !memoryAllowed && (
                  <PlanOffer
                    key={memoryOffer}
                    place="memory"
                    status={status}
                    title={t("offerMemoryTitle")}
                    body={t(memoryOffer === "long" ? "offerMemoryLong" : "offerMemoryBody", FREE_MEMORY)}
                    onChoose={choosePlan}
                    onEvent={offerEvent("memory")}
                    onClose={() => setMemoryOffer(null)}
                    extra={offer ? (
                      <div class="cf-card-actions">
                        <button type="button" class="cf-secondary" onClick={() => { offerEvent("memory")("discount"); redeemOffer(offer.code) }}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
                      </div>
                    ) : undefined}
                  />
                )}

                {error && error.code !== "LIMIT_REACHED" && error.code !== "PRO_ONLY" && (
                  <div class="cf-card error">
                    <p>{errorText(error)}</p>
                    {byok && error.code === "SEARCH_LIMIT" && <p>{t("byokSearch", search.freeDaily, search.proWeekly)}</p>}
                    <div class="cf-card-actions">
                      {byok && error.code === "SEARCH_LIMIT" && upgradeButton("search")}
                      {lastIsUser && error.code !== "SEARCH_LIMIT" && error.code !== "SEARCH_UNAVAILABLE" && (
                        <button type="button" class="cf-secondary" onClick={() => retry()}><Icon.Retry /> {t("retry")}</button>
                      )}
                      {lastIsUser && (error.code === "SEARCH_LIMIT" || error.code === "SEARCH_UNAVAILABLE") && (
                        <button type="button" class="cf-secondary" onClick={() => retry(true)}><Icon.Sparkle size={14} /> {t("askWithoutGoogle")}</button>
                      )}
                      {error.code === "BAD_KEY" && <button type="button" class="cf-secondary" onClick={() => setView("settings")}>{t("settings")}</button>}
                    </div>
                  </div>
                )}

                {!historyMode && partial === null && contextKind === "page" && source.kind() !== "page" && hintDue(source.kind() as HintKey) && (
                  <Hint
                    icon={source.kind() === "video" ? <Icon.Play /> : <Icon.Doc />}
                    title={t(source.kind() === "video" ? "hintVideoTitle" : mediaOn ? "hintPdfTitle" : "hintPdfTitleFree")}
                    onDone={() => doneHint(source.kind() as HintKey)}
                  >
                    {/* Free answers don't read them: the hint says Pro does. */}
                    {t(source.kind() === "video" ? (mediaOn ? "hintVideoBody" : "hintVideoBodyFree") : mediaOn ? "hintPdfBody" : "hintPdfBodyFree")}
                  </Hint>
                )}

                {pending && <ConsentCard again={consent === "old"} onAccept={() => void acceptConsent()} onDecline={declineConsent} />}
              </div>

              {picked ? (
                <footer class="cf-composer cf-pickbar">
                  <button type="button" class="cf-icon" onClick={() => setPicked(null)} aria-label={t("cancel")} title={t("cancel")}><Icon.Close /></button>
                  <button
                    type="button"
                    class="cf-pick-count"
                    onClick={() => setPicked(picked.size === messages.length ? new Set() : new Set(messages.map((_, i) => i)))}
                    title={t(picked.size === messages.length ? "pickNone" : "pickAll")}
                  >
                    {picked.size ? t("pickCount", picked.size, messages.length) : t("pickHint")}
                  </button>
                  <button type="button" class="cf-secondary" disabled={!picked.size} onClick={() => void copyPicked()}><Icon.Copy /> {t("copy")}</button>
                  {typeof navigator.share === "function" && (
                    <button type="button" class="cf-primary" disabled={!picked.size} onClick={() => void sharePicked()}><Icon.Share /> {t("share")}</button>
                  )}
                </footer>
              ) : (
                <footer class="cf-composer">
                  <ListenBar state={listen.state} speed={listen.speed} left={listen.left} onSpeed={listen.cycleSpeed} onAnyway={listen.anyway} onNotifyOn={listen.notifyTurnOn} onNotifyLater={listen.notifyNotNow} onToggle={listen.toggle} onSeek={listen.seek} onStop={listen.stop} onPlans={() => openPlans("ultra", "limit")} />
                  {undoBar && <UndoBar text={undoBar.text} actions={undoBar.actions} onHold={holdBar} />}
                  {noteHint && draft.trim() && !noteMode && <div class="cf-note-hint" role="status">{t(touch ? "noteHintTouch" : "noteHintMouse")}</div>}
                  {weightNote && <div class="cf-weight-note" title={t("longPageWeightHint", pageWeight)}>{t("longPageWeight", pageWeight)}</div>}
                  <div class={`cf-input ${noteMode ? "note" : ""}`}>
                    {!noteMode && !historyMode && (
                      <button
                        type="button"
                        class={`cf-mode ${googleMode ? "on" : ""}`}
                        aria-pressed={googleMode}
                        title={t("googleModeHint")}
                        onClick={() => setGoogleMode(!googleMode)}
                      >
                        <Icon.Search size={14} /> {t("actGoogle")}
                      </button>
                    )}
                    <textarea
                      ref={inputRef}
                      rows={1}
                      dir="auto"
                      value={draft}
                      placeholder={t(noteMode ? "placeholderNote" : historyMode ? "placeholderHistory" : googleMode ? "placeholderGoogle" : contextKind === "selection" ? "placeholderSelection" : contextKind === "page" ? "placeholderPage" : "placeholderNone")}
                      enterkeyhint="send"
                      onInput={(e) => {
                        const el = e.currentTarget
                        setDraft(el.value)
                        el.style.height = "auto"
                        el.style.height = `${Math.min(el.scrollHeight, 140)}px`
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                          e.preventDefault()
                          submit()
                        }
                        e.stopPropagation()
                      }}
                      onKeyUp={(e) => e.stopPropagation()}
                      onKeyPress={(e) => e.stopPropagation()}
                    />
                    {streaming ? (
                      <button type="button" class="cf-send stop" onClick={() => stop(true)} aria-label={t("stop")} title={t("stop")}><Icon.Stop /></button>
                    ) : (
                      <span class="cf-send-wrap" {...switchGestures}>
                        <button
                          type="button"
                          class={`cf-send ${noteMode ? "note" : ""}`}
                          disabled={!draft.trim()}
                          onClick={() => {
                            if (switched.current) switched.current = false
                            else submit()
                          }}
                          aria-label={t(noteMode ? "saveNote" : "send")}
                          title={`${t(noteMode ? "saveNote" : "send")} · ${t(touch ? "noteHintTouch" : "noteHintMouse")}`}
                        >
                          <span class="cf-send-icon" key={noteMode ? "note" : "send"}>{noteMode ? <Icon.Pencil /> : <Icon.ArrowUp />}</span>
                        </button>
                      </span>
                    )}
                  </div>
                  <div class="cf-usage">
                    <span class="cf-usage-text" title={usageLine.full}>{usageLine.short}</span>
                    {!historyMode && <label class="cf-whole" title={t("wholeChatHint")}>
                      <input type="checkbox" role="switch" checked={memoryOn} onChange={(e) => {
                        // Pro's memory (build 91): Pro and Ultra turn it on and off; without Pro it stays off and the chat
                        // says what Pro remembers.
                        if (memoryAllowed) return updateSettings({ chatMemory: e.currentTarget.checked })
                        e.currentTarget.checked = false
                        setMemoryOffer("switch")
                        setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }), 60)
                      }} />
                      <span class="cf-switch" aria-hidden="true" />
                      {t("wholeChat")}
                      {!memoryAllowed && <span class="cf-pro-badge">Pro</span>}
                    </label>}
                    {plan === "free" && !ownKeyActive && TARGET === "safari" && (
                      offer ? (
                        <button type="button" class="cf-link" onClick={() => redeemOffer(offer.code)}>{t("offerShort", offer.discount)}</button>
                      ) : (
                        <button type="button" class="cf-link" onClick={() => void openApp("subscribe")}>{t("getPro")}</button>
                      )
                    )}
                  </div>
                </footer>
              )}
            </>
          )}
          {guide && guideIdle && !ON_PAGE.includes(guide) && view === (guide === "chatList" ? "threads" : PLAN_VIEW[guide] ?? "chat") && panelRef.current && (
            <GuideCard
              key={guide}
              panel={panelRef.current}
              step={guide}
              touch={touch}
              sync={TARGET === "safari" && settings.syncChats}
              onNext={guideNext}
              onSkip={() => endGuide("skip")}
              onTap={guideTap}
            />
          )}
          {touring && view === "chat" && panelRef.current && (
            <Tour panel={panelRef.current} steps={tourSteps(TARGET === "safari" && settings.syncChats, touch)} onDone={endTour} />
          )}
          {view === "chat" && !picked && ux.overlay}
          {view === "chat" && later && laterSheet(false)}
          {view === "chat" && listOpen && (
            <RemindersSheet kind={listOpen} items={laterList} onOpen={openLaterItem} onCancel={(item) => void cancelLaterItem(item)} onReschedule={rescheduleLaterItem} onClose={() => setListOpen(null)} />
          )}
          {view === "chat" && tipsOpen && (
            <TipsSheet mac={!touch} onClose={() => setTipsOpen(false)} />
          )}
          {plansOpen && TARGET === "safari" && (
            <PlansSheet
              status={status}
              focus={plansOpen}
              onChoose={(chosen, period) => {
                setPlansOpen(null)
                void sendBackground({ type: "useEvent", f: "plans", a: "choose", plan: chosen, period })
                openAppFromTap(touch, { target: "subscribe", plan: chosen, period, feature: chosen === "ultra" ? "listen" : undefined })
              }}
              onClose={() => setPlansOpen(null)}
            />
          )}
        </section>
      )}

      {!popup && (
        <QuickInsert
          platform={platform}
          touch={touch}
          bus={bus}
          panelOpen={open}
          panelAside={open && layout === "side"}
          consent={consent}
          onConsent={agreeQuietly}
          free={plan === "free" && !ownKeyActive}
          onUpgrade={() => void openApp("subscribe")}
          onOpenTemplates={() => {
            show()
            setView("templates")
          }}
          onAdapt={adaptTemplate}
        />
      )}
    </div>
  )
}

const runActionRef: { current: (a: Action) => void } = { current: () => undefined }

/**
 * Above a question or note: "New page: …" on the chat's first page and whenever it moved to another one
 * (the title opens that page: its tab if it's open), with the day it came there and how long ago;
 * "Page updated" when the page changed.
 */
function PageDivider({ entries, index, onOpen }: { entries: Entry[]; index: number; onOpen: (url: string) => void }): VNode | null {
  const m = entries[index]
  const previous = lastPage(entries.slice(0, index))
  if (m.page && (!previous || previous.url !== m.page.url)) {
    const { url, title, at } = m.page
    const [before, after = ""] = t("newPage", "\uE000").split("\uE000")
    return (
      <div class="cf-divider">
        <span class="cf-divider-page">
          <span class="cf-divider-title">
            {before}
            <a href={url} title={t("openPage")} onClick={(e) => { e.preventDefault(); onOpen(url) }}>{title || url}</a>
            {after}
          </span>
          {at !== undefined && <span class="cf-divider-when">· {pageWhen(at, Date.now(), uiLanguage())}</span>}
        </span>
      </div>
    )
  }
  if (m.pageChanged) return <div class="cf-divider"><span>{t("pageUpdated")}</span></div>
  return null
}

// Selection buttons act on pointerup: on iPhone the tap that reaches them also clears the
// selection, and the click may never come. Keyboard activation still arrives as a click.
// touchend is cancelled so the tap's late click doesn't land on the panel opening underneath.
let pressed: EventTarget | null = null
function press(action: () => void) {
  return {
    onTouchEnd: (e: TouchEvent) => e.preventDefault(),
    onPointerDown: (e: PointerEvent) => {
      pressed = e.currentTarget
      e.preventDefault()
    },
    onPointerUp: (e: PointerEvent) => {
      if (pressed !== e.currentTarget) return
      pressed = null
      action()
    },
    onClick: (e: MouseEvent) => {
      if (e.detail === 0) action()
    }
  }
}

/**
 * Where the selection buttons go (`height`: theirs): below the selection, above it when there's no
 * room, so they don't cover it. iPhone and iPad: also clear of the selection handles and of the
 * system edit menu, which iOS 26+ shows right below the selection and above it when there's no room
 * below (older versions the other way round); the buttons keep the menu's whole height away on either
 * side, so they never meet it (the owner, build 75: "the menu lies over the bubble"). Mac: a right-click
 * menu opens down from the pointer, so then they go above the selection (`up`).
 * Always within what's visible: above the keyboard while their field is typed in.
 */
function bubbleTop(rect: DOMRect, touch: boolean, height: number, up = false): number {
  const vv = window.visualViewport
  const top0 = vv?.offsetTop ?? 0
  const bottom = top0 + (vv?.height ?? window.innerHeight)
  // The edit menu: about 16 pt from the selection, 44 pt tall (more with larger text); plus air.
  const clear = touch ? 88 : 8
  const below = rect.bottom + clear
  const above = rect.top - clear - height
  const fitsBelow = below + height <= bottom - 12
  const fitsAbove = above >= top0 + 8
  let top = (up ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) ? above : below
  // Neither side has room (a long selection, the keyboard up): the side with more of it, at the screen's edge.
  if (!fitsBelow && !fitsAbove) top = rect.top - top0 > bottom - rect.bottom ? top0 + 8 : bottom - height - 12
  return Math.max(top0 + 8, Math.min(bottom - height - 12, top))
}

/** A selection shown in a line: one line, at most `max` characters. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** 320 pt wide or less room (iPhone mini and SE with Display Zoom): the selection buttons use shorter labels. */
function narrowScreen(): boolean {
  return (window.visualViewport?.width ?? window.innerWidth) < 360
}

// Nudged once per page: the chips peek out, then slide back, so the swipe is found.
let chipsNudged = false

/**
 * The selection buttons' question field (2.6, the owner's idea for iPhone and iPad): the panel's quick actions sit
 * in the field itself, semi-transparent, starting right after the placeholder's text (build 86, the owner: the first
 * one barely peeked in at the far edge); a swipe toward the start pulls the rest in, a carousel, and a tap on one asks
 * it, so the person can swipe and tap instead of typing. Right to left (Arabic) the placeholder is on the right and
 * the chips follow it to its left. They step aside once the field has the focus or a question. The buttons are
 * touch-action:none (taps only); the field scrolls sideways (pan-x). The size of the buttons doesn't change. Mac: just
 * the field.
 */
function SelField({ touch, chips, placeholder, markUltra, onChip, children }: { touch: boolean; chips: Action[]; placeholder: string; markUltra: boolean; onChip: (a: Action) => void; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const on = chips.length > 0
  // The placeholder's own width in the field's font (each language's is different), plus the input's padding: the
  // input is that wide while the chips show, so the first one or two sit right after "Your question…".
  useLayoutEffect(() => {
    const field = ref.current
    const input = field?.querySelector("input")
    if (!field || !input || !probe.current) return
    const style = getComputedStyle(input)
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    // offsetWidth: the layout's width, not shrunk by the buttons' pop-in scale (+1 for its rounding).
    field.style.setProperty("--cf-ph", `${Math.ceil(probe.current.offsetWidth + pad + 1)}px`)
  }, [on, placeholder])
  useEffect(() => {
    const field = ref.current
    if (!field) return
    field.scrollLeft = 0
    if (!on || chipsNudged || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    chipsNudged = true
    // Right to left (Arabic) the chips wait past the left edge: scrollLeft runs from 0 into the negatives there.
    const ahead = getComputedStyle(field).direction === "rtl" ? -64 : 64
    const out = setTimeout(() => field.scrollTo({ left: ahead, behavior: "smooth" }), 450)
    const back = setTimeout(() => field.scrollTo({ left: 0, behavior: "smooth" }), 1150)
    return () => {
      clearTimeout(out)
      clearTimeout(back)
    }
  }, [on])
  if (!touch) return <>{children}</>
  return (
    <div ref={ref} class={`cf-ask-field ${on ? "chips" : ""}`} role="group" aria-label={on ? t("selChips") : undefined}>
      <span ref={probe} class="cf-ask-probe" aria-hidden="true">{placeholder}</span>
      {children}
      {chips.map((a) => (
        ULTRA_ACTIONS.has(a.id)
          ? <button type="button" key={a.id} class="cf-sel-chip ultra" {...press(() => onChip(a))}><SimilarIcon size={12} /> {a.text ?? t(a.label)}<UltraMark show={markUltra} /></button>
          : <button type="button" key={a.id} class="cf-sel-chip" {...press(() => onChip(a))}>{a.text ?? t(a.label)}</button>
      ))}
    </div>
  )
}

/** The buttons shown for a page selection, centered under it and kept on screen. */
function SelectionBubble({ rect, touch, guide, onPlace, children }: { rect: DOMRect; touch: boolean; guide?: boolean; onPlace?: (box: DOMRect, selection: DOMRect) => void; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  // Mac: a right-click on the page opens the system menu down from the pointer; the buttons go above the selection.
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (touch) return
    const menu = () => setUp(true)
    document.addEventListener("contextmenu", menu, true)
    return () => document.removeEventListener("contextmenu", menu, true)
  }, [touch])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const center = rect.left + rect.width / 2
    const place = () => {
      const vv = window.visualViewport
      const min = (vv?.offsetLeft ?? 0) + 8
      const max = min + (vv?.width ?? window.innerWidth) - 16 - el.offsetWidth
      // A row that doesn't fit the screen (longer words, the eye) keeps Template's icon only; once, not back and forth.
      const row = el.querySelector(".cf-bubble-row")
      if (row && row.scrollWidth > row.clientWidth + 1) el.classList.add("tight")
      el.style.left = `${Math.max(min, Math.min(max, center - el.offsetWidth / 2))}px`
      el.style.top = `${bubbleTop(rect, touch, el.offsetHeight, up)}px`
      onPlace?.(el.getBoundingClientRect(), rect)
    }
    el.classList.remove("tight")
    place()
    // Its size changes ("Saved to the chat", the hint), and on iPhone the keyboard covers part of the page.
    const resized = new ResizeObserver(place)
    resized.observe(el)
    const vv = window.visualViewport
    vv?.addEventListener("resize", place)
    vv?.addEventListener("scroll", place)
    return () => {
      resized.disconnect()
      vv?.removeEventListener("resize", place)
      vv?.removeEventListener("scroll", place)
    }
  }, [rect, touch, up])
  return (
    // Clicks on the buttons keep the page selection; the field takes the focus.
    <div ref={ref} class={`cf-bubble ${touch ? "touch" : ""} ${guide ? "guide" : ""}`} onMouseDown={(e) => (e.target as Element).closest("input") || e.preventDefault()}>
      {children}
    </div>
  )
}

function Sources({ grounding }: { grounding: Grounding }): VNode {
  return (
    <div class="cf-sources">
      {grounding.sources.length > 0 && (
        <>
          <div class="cf-sources-title">{t("sources")}</div>
          <ol class="cf-source-list">
            {grounding.sources.map((s, i) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer"><span class="n">{i + 1}</span><span class="t" dir="auto">{s.title}</span></a>
              </li>
            ))}
          </ol>
        </>
      )}
      {grounding.suggestions && <SearchSuggestions html={grounding.suggestions} />}
    </div>
  )
}

/** Google's Search Suggestions, rendered as Google provides them, in their own shadow root. */
function SearchSuggestions({ html }: { html: string }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  // Closed like the panel's own root: kept here, since a closed root can't be read back from its host.
  const shadow = useRef<ShadowRoot | null>(null)
  useEffect(() => {
    const host = ref.current
    if (!host) return
    shadow.current ??= host.attachShadow({ mode: SHADOW_MODE })
    shadow.current.replaceChildren(suggestionNodes(html))
  }, [html])
  return <div class="cf-suggest" ref={ref} />
}

// The snippet is HTML + CSS from the Gemini API: keep markup and styles, drop anything that could
// run or load (scripts, frames, handlers, non-https links), and open links in a new tab.
function suggestionNodes(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.querySelectorAll("script,iframe,frame,object,embed,form,link,meta,base").forEach((el) => el.remove())
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const url = /^(href|src|xlink:href|action|formaction)$/i.test(attr.name)
      if (/^on/i.test(attr.name) || (url && !/^(https:|data:image\/)/i.test(attr.value.trim()))) el.removeAttribute(attr.name)
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank")
      el.setAttribute("rel", "noopener noreferrer")
    }
  })
  const fragment = document.createDocumentFragment()
  for (const node of [...doc.head.childNodes, ...doc.body.childNodes]) fragment.appendChild(document.importNode(node, true))
  return fragment
}

/** Under a question: the video transcript or PDFs it went with, or why one couldn't be read. */
/** The video/PDF kinds the question an answer replies to didn't read (not Pro), if any. */
function skippedFor(entries: Entry[], index: number): MediaKind[] | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = entries[i]
    if (m.role === "user" && !m.note) return m.skipped?.length ? m.skipped : null
  }
  return null
}

/** Under a free answer on a page with a video or PDFs: they weren't read, and Pro reads them. */
function MediaSkipped({ kinds, onPro }: { kinds: MediaKind[] | null; onPro: (kinds: MediaKind[]) => void }): VNode | null {
  if (!kinds) return null
  const key: MessageKey = kinds.length > 1 ? "proSkipBoth" : kinds[0] === "video" ? "proSkipVideo" : "proSkipPdf"
  return (
    <div class="cf-media-skipped" role="note">
      {kinds[0] === "video" ? <Icon.Play size={13} /> : <Icon.Doc />}
      <span>{t(key)}</span>
      <button type="button" class="cf-link" onClick={() => onPro(kinds)}>{t("tryPro")}</button>
    </div>
  )
}

function UsedSources({ notes }: { notes: SourceNote[] }): VNode {
  return (
    <div class="cf-used-list">
      {notes.map((n, i) => {
        if (n.ok) {
          return (
            <span class="cf-used" key={i} title={n.name}>
              {n.kind === "video" ? <Icon.Play size={13} /> : <Icon.Doc />}
              <span>{n.kind === "video" ? t("usedVideo", n.detail ?? "") : t("usedPdf", n.name, n.detail ?? "")}</span>
            </span>
          )
        }
        const key: MessageKey = n.kind === "video" ? (n.reason === "none" ? "videoNoTranscript" : "videoFailed") : n.reason === "none" ? "pdfNoText" : "pdfFailed"
        return (
          <span class="cf-used warn" key={i} role="note">
            <Icon.Alert />
            <span>{t(key, n.name)}</span>
          </span>
        )
      })}
    </div>
  )
}

function ContextChip({ kind, media, title, words, text, onClear }: { kind: "selection" | "page" | "none"; media: "page" | "video" | "pdf"; title: string; words: number; text: string; onClear: () => void }): VNode {
  if (kind === "selection") {
    // A word or two (a long-press on iPhone) reads better as itself than as a word count.
    const short = words <= 3 && text.length <= 28
    return (
      <span class="cf-ctx selection">
        <Icon.Cursor /> <span class="cf-ctx-text">{short ? `“${text}”` : t("ctxSelection", words)}</span>
        <button type="button" class="cf-ctx-clear" onClick={onClear} title={t("ctxUsePage")} aria-label={t("ctxUsePage")}>×</button>
      </span>
    )
  }
  return (
    <span class={`cf-ctx ${kind}`}>
      {kind === "page" && media === "video" ? <Icon.Play /> : <Icon.Doc />} <span class="cf-ctx-text" dir="auto">{kind === "page" ? title || t("ctxPage") : t("ctxNone")}</span>
    </span>
  )
}
