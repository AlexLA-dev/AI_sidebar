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
  type ProOffer,
  type Settings,
  type UpsellWhere,
  type FindReply,
  type StatusInfo,
  type StreamEvent,
  type Usage
} from "../shared/types"
import * as Icon from "./icons"
import { historyForModel, isQuestion, lastPage, otherPages, pageHasChanged, pageRef, pageWhen, savedPages, selectionNote, stamped, type Entry, type SourceNote } from "../shared/conversation"
import { Markdown } from "./markdown"
import { MAX_OTHER_PAGES, MAX_PAGE_CHARS } from "../shared/prompt"
import { answerWeight } from "../shared/pagefit"
import { answerShareText, chatLanguage, noteCopyText, noteShareText, pickedShareText, toPlainText, type ShareLinks } from "../shared/share"
import type { PageRead, PageSource } from "./context"
import {
  forgetSelection,
  HOST_TAG,
  isTouch,
  MIN_SELECTION_WORDS,
  privateBrowsing,
  readSelection,
  recentSelection,
  rememberSelection,
  trackSelection,
  type SelectionInfo
} from "./page"
import { Hint } from "./Hint"
import { OrganizeCard, OrganizeRow, type OrganizeMove } from "./Organize"
import { UndoBar } from "./UndoBar"
import { moveBlock, organizeCards, setOrganizeCards, undoBlockMove, type OrganizeCards } from "./store"
import { DEFAULT_ORGANIZE, looksMixed } from "../shared/organize"
import { entryKey } from "../shared/conversation"
import type { OrganizeEvent, OrganizeReply } from "../shared/types"
import { ProUpsell } from "./ProUpsell"
import { SettingsView } from "./Settings"
import { shareLabels } from "./shareLabels"
import { markHintSeen, resetHints, seenHints, type HintKey } from "./store"
import { deleteThread, giveConsent, hasSeenTour, loadConsent, loadSettings, loadThreads, markTourSeen, noteHintCount, onSettingsChanged, onThreadsChanged, pageTexts, pinThread, rememberPageText, renameThread, renewalAskedPeriod, saveSettings, saveThread, selHintCount, setActiveThread, setThreadTags, offerCardCount, setNoteHintCount, setOfferCardCount, setSelHintCount } from "./store"
import { TagChip, TagEditor } from "./Tags"
import { ThreadsView } from "./Threads"
import { starMarks } from "../shared/marks"
import { Bell, More, remindLabel, RemindSheet } from "./ux/MessageUx"
import { PageMenu } from "./ux/PageMenu"
import { bubbleActions, laterSections, laterSources, pageRange, setLaterOpener, type BubbleContext, type LaterContext, type LaterItem } from "./ux/later"
import { RemindersSheet } from "./ux/RemindersSheet"
import { scheduleReminder, thisDevice, useMessageUx } from "./ux/useMessageUx"
import { Tour, tourSteps } from "./Tour"
import { QI_EVENTS, QuickInsert } from "./insert/QuickInsert"
import * as QIcon from "./insert/icons"
import { keepCopied, report as reportInsert } from "./insert/store"
import { insertFromPanel, useButtonShown, useHasField } from "./insert/target"
import { TemplatesView } from "./insert/TemplatesView"
import { allTags, chatDigests, chatList, cleanTags, newThreadId, pageBlocks, pinAt, shownThread, threadPages, threadTitle, type MoveUndo, type Thread, type Threads } from "../shared/threads"
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
}

const PAGE_ACTIONS: Action[] = [
  { id: "summarize", label: "actSummarize", prompt: "promptSummarize" },
  { id: "key_points", label: "actKeyPoints", prompt: "promptKeyPoints" },
  { id: "explain", label: "actExplain", prompt: "promptExplain" },
  { id: "translate", label: "actTranslate", prompt: "promptTranslate" },
  { id: "google", label: "actGoogle", prompt: "promptGoogle", mode: "google" }
]

const SEL_GOOGLE: Action = { id: "sel_google", label: "actGoogle", prompt: "promptSelGoogle", mode: "google" }

const SELECTION_ACTIONS: Action[] = [
  { id: "sel_explain", label: "actExplain", prompt: "promptSelExplain" },
  { id: "sel_summarize", label: "actSummarize", prompt: "promptSelSummarize" },
  { id: "sel_translate", label: "actTranslate", prompt: "promptSelTranslate" },
  SEL_GOOGLE,
  { id: "sel_improve", label: "actImprove", prompt: "promptSelImprove" },
  { id: "sel_reply", label: "actReply", prompt: "promptReply" }
]

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

function followLink(url: string): void {
  const a = document.createElement("a")
  a.href = url
  a.rel = "noopener"
  a.style.display = "none"
  document.documentElement.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 500)
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

/** Before the first answer, and again when the text changed (`again`): where questions go. */
function ConsentCard({ again, onAccept, onDecline }: { again: boolean; onAccept: () => void; onDecline: () => void }): VNode {
  return (
    <div class="cf-card consent">
      <strong>{t(again ? "consentAgainTitle" : "consentTitle")}</strong>
      <p>{t("consentBody")}</p>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onAccept}>{t("consentAccept")}</button>
        <button type="button" class="cf-link" onClick={onDecline}>{t("consentDecline")}</button>
        <button type="button" class="cf-link" onClick={() => void sendBackground({ type: "openUrl", url: LINKS.privacy })}>{t("privacyPolicy")}</button>
      </div>
    </div>
  )
}

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
  const [view, setView] = useState<"chat" | "settings" | "threads" | "templates">("chat")
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
  const [draft, setDraft] = useState("")
  // The send button writes a note to the chat instead of asking (switched by swiping or scrolling on it).
  const [noteMode, setNoteMode] = useState(false)
  const [noteHint, setNoteHint] = useState(false)
  const [error, setError] = useState<ChatError | null>(null)
  // The Pro offer, shown once more to an install that ran out of free answers before.
  const [offerCard, setOfferCard] = useState(false)
  const [findConsent, setFindConsent] = useState<{ resolve: (agreed: boolean) => void } | null>(null)
  const [pending, setPending] = useState<{ text: string; label?: string; action?: string; mode?: "google" } | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [pageReadable, setPageReadable] = useState(true)
  const [wide, setWide] = useState(() => window.innerWidth >= 700)
  const [keyboard, setKeyboard] = useState(0)
  const [bubble, setBubble] = useState<SelectionInfo | null>(null)
  // The selection buttons' own question field, "Saved to the chat" after Note, and the first-time hint.
  const [selDraft, setSelDraft] = useState("")
  const [noteSaved, setNoteSaved] = useState(false)
  const [selHint, setSelHint] = useState(false)
  // The buttons stay while their field is being typed in or a note is being saved, though the page
  // selection is gone (focusing the field clears it) or the page scrolls (iPhone, for the keyboard).
  const selTyping = useRef(false)
  const noteHold = useRef(false)
  const bubbleHeld = () => selTyping.current || noteHold.current
  const [googleMode, setGoogleMode] = useState(false)
  const [streamMode, setStreamMode] = useState<"google" | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)
  // The tour of the panel: shown once, on the first open; Settings can show it again.
  const [tourSeen, setTourSeen] = useState(true)
  const [touring, setTouring] = useState(false)
  const touringRef = useRef(false)
  touringRef.current = touring
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
  // Organizing (2.5): the bar after a move ("Moved to … · Undo · Open"), until the next action.
  const [undoBar, setUndoBar] = useState<{ text: string; actions: Array<{ label: string; run: () => void }> } | null>(null)
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
  // "Come back later" (the header's "…", or watching offering a reminder instead, later.ts): what was selected then.
  const [later, setLater] = useState<{ selection: SelectionInfo | null; range: Range | null } | null>(null)
  const [laterFlash, setLaterFlash] = useState(0)
  // "Reminders" (the header's "…", "All reminders" in the window): open, its rows (null while loading), how many.
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [laterList, setLaterList] = useState<LaterItem[] | null>(null)
  const [laterCount, setLaterCount] = useState(0)
  useEffect(() => {
    setLaterOpener((from) => setLater({
      selection: from?.selection ? { text: from.selection, words: from.selection.split(/\s+/).filter(Boolean).length, rect: null, at: Date.now() } : null,
      range: from?.range ?? null
    }))
    return () => setLaterOpener(null)
  }, [])
  // The header's "…" (where Settings was): "Come back later…" and Settings (2.5).
  const [pageMenu, setPageMenu] = useState(false)
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
    return onSettingsChanged(setSettings)
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
        setThreadList(chatList(threads))
        setMessages(entries)
        scrollToEnd()
        // Other devices may have continued a chat (iCloud), or the ContextFlow app asked to continue one
        // here ("Open in Safari"): show it unless something was asked here meanwhile.
        void sendBackground<{ changed: boolean; open?: string | null }>({ type: "syncThreads" }).then(async (result) => {
          if (!result?.changed || portRef.current) return
          const fresh = await loadThreads()
          const asked = result.open ? fresh.threads[result.open] : undefined
          const next = asked && !asked.deleted && asked.m.length ? { id: asked.id, m: asked.m } : shownThread(fresh.threads, fresh.active)
          setThreadList(chatList(fresh.threads))
          setMessages((current) => {
            if (current !== entries) return current
            if (next.id !== threadRef.current) {
              threadRef.current = next.id
              void setActiveThread(next.id)
            }
            setKind(fresh.threads[next.id]?.kind)
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

  // Single-page apps: follow URL changes while open (the conversation carries on).
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      const key = source.key()
      if (key !== pageUrlRef.current) {
        pageUrlRef.current = key
        setPageUrl(key)
        forgetSelection()
        setSelection(null)
        setPageReadable(source.readable())
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [open, source])

  // While open: the chat list follows other tabs and devices, and the answer counter other devices.
  useEffect(() => {
    if (!open) return
    const off = onThreadsChanged(() => void loadThreads().then(({ threads }) => setThreadList(chatList(threads))))
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

  // The first time the panel is open and idle, show what it can do.
  useEffect(() => {
    if (popup || tourSeen || touring || !visible || view !== "chat" || streaming || pending) return
    const timer = setTimeout(() => setTouring(true), 450)
    return () => clearTimeout(timer)
  }, [popup, tourSeen, touring, visible, view, streaming, pending])

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
      setBubble(sel && onScreen && sel.words >= (touch ? MIN_SELECTION_WORDS : 3) ? sel : null)
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
    const onScroll = () => {
      if (bubbleHeld()) return
      setBubble(null)
      clearTimeout(scrollTimer)
      if (touch) scrollTimer = setTimeout(offerButton, 400)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("mouseup", onMouseUp)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      clearTimeout(timer)
      clearTimeout(scrollTimer)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("scroll", onScroll)
    }
  }, [open, touch])

  // ------------------------------------------------------------ chat
  const finish = useCallback((history: Turn[], text: string, err: ChatError | null, grounding?: Grounding) => {
    portRef.current = null
    askToken.current = null
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    if (text) {
      const next: Turn[] = [...history, stamped(grounding ? { role: "assistant", content: text, grounding } : { role: "assistant", content: text })]
      setMessages(next)
      const skipped = skippedFor(next, next.length - 1)
      if (skipped) void sendBackground({ type: "mediaNotice", action: "shown", media: skipped })
      // Right away, not on the debounced save: the user may go to another page as soon as the answer is in.
      void saveThread(threadRef.current, next, historyRef.current ? "history" : undefined)
    }
    if (err) setError(err)
  }, [])

  const ask = useCallback((text: string, opts: { label?: string; action?: string; retry?: boolean; mode?: "google" } = {}) => {
    const content = text.trim()
    if (!content || portRef.current || askToken.current) return
    setUndoBar(null)
    if (consent !== "ok") {
      setPending({ text: content, label: opts.label, action: opts.action, mode: opts.mode })
      return
    }
    const base = opts.retry ? messages.slice(0, messages.length - 1) : messages
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
  const adaptTemplate = (text: string) => {
    show()
    setTimeout(() => ask(t("qiAdaptPrompt", text), { label: t("qiAdaptLabel") }), 120)
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
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: "chat" })
    } catch {
      finish(history, "", { code: "NETWORK" })
      return
    }
    portRef.current = port
    let settled = false
    let grounded: { text: string; grounding: Grounding } | null = null
    let lastSeq = 0
    port.onMessage.addListener((event: StreamEvent & { seq?: number }) => {
      // Safari can deliver a message twice (in the PDF popup): every event is numbered.
      if (event.seq !== undefined) {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
      }
      if (event.type === "meta") {
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
        finish(history, grounded?.text ?? partialRef.current, null, grounded?.grounding)
      } else if (event.type === "error") {
        settled = true
        if (event.usage) setUsage(event.usage)
        finish(history, partialRef.current, { code: event.code, message: event.message, usage: event.usage, offer: event.offer, weight: event.weight })
      }
    })
    port.onDisconnect.addListener(() => {
      if (!settled && portRef.current === port) finish(history, partialRef.current, partialRef.current ? null : { code: "STREAM" })
    })
    // Sizes only, for /analytics: whether keeping 40 messages, 50 chats or a few pages gets in the way.
    const stats = { turns: history.length, pages: threadPages(history).length, chats: threadList.length }
    if (chats) {
      port.postMessage({ type: "ask", payload: { messages: historyForModel(history, url), page: null, action: opts.action, context: "history" as const, history: chats, stats } })
      return
    }
    const wholeChat = settingsRef.current.wholeChat
    // The chat's other pages: this device's copy of their text, else the one saved in the chat (another device's).
    const others = otherPages(history, url).map((p) => p.url).slice(0, MAX_OTHER_PAGES)
    const saved = savedPages(history)
    void (wholeChat ? pageTexts(others) : Promise.resolve([])).then((local) => {
      const pages = wholeChat ? others.flatMap((u) => local.find((p) => p.url === u) ?? saved.find((p) => p.url === u) ?? []) : []
      if (portRef.current !== port) return // stopped meanwhile
      port.postMessage({
        type: "ask",
        payload: {
          messages: historyForModel(history, url, wholeChat),
          page,
          action: opts.action,
          mode: opts.mode,
          stats,
          ...(wholeChat ? { context: "chat" as const, pages } : {})
        }
      })
    })
  }

  /** Keeps a note in the chat (with the page it was written on); no AI, no allowance used. */
  const saveNote = useCallback((text: string) => {
    const content = text.trim()
    if (!content || portRef.current || askToken.current) return
    setUndoBar(null)
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

  const stop = useCallback(() => {
    const port = portRef.current
    if (!port && askToken.current) {
      // Stopped while the page was still being read: nothing was asked.
      askToken.current = null
      setReading(null)
      partialRef.current = ""
      setPartial(null)
      setStreamMode(null)
      return
    }
    if (!port) return
    portRef.current = null
    try {
      port.disconnect()
    } catch {
      // already closed
    }
    const text = partialRef.current
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    if (text) setMessages((prev) => [...prev, stamped({ role: "assistant", content: text })])
  }, [])

  // `withoutGoogle`: ask the same question as a normal answer (e.g. after the Google limit).
  const retry = useCallback((withoutGoogle = false) => {
    const last = messages[messages.length - 1]
    if (!isQuestion(last)) return
    if (withoutGoogle) setGoogleMode(false)
    ask(last.content, { label: last.label, retry: true, mode: withoutGoogle ? undefined : last.mode })
  }, [messages, ask])

  const runAction = useCallback((action: Action) => {
    const language = t("languageName")
    ask(t(action.prompt, language), { label: t(action.label), action: action.id, mode: action.mode })
  }, [ask])
  runActionRef.current = runAction

  const acceptConsent = useCallback(async () => {
    await giveConsent()
    setConsent("ok")
    const p = pending
    setPending(null)
    if (p) setTimeout(() => askRef.current(p.text, { label: p.label, action: p.action, mode: p.mode }), 0)
  }, [pending])
  // "Not now": the question stays in the box, nothing is sent.
  const declineConsent = useCallback(() => setPending(null), [])
  const askRef = useRef(ask)
  askRef.current = ask

  /** Starts a new thread; the previous one stays in the list. */
  const newChat = useCallback(() => {
    stop()
    setUndoBar(null)
    const id = newThreadId()
    threadRef.current = id
    setKind(undefined)
    void setActiveThread(id)
    setMessages([])
    setError(null)
    setView("chat")
  }, [stop])

  // ------------------------------------------------------------ the field and Note by a selection
  // The first time the selection buttons show on a page (three page visits, until one is used): what's new in them.
  const selHintAsked = useRef(false)
  useEffect(() => {
    if (!bubble) {
      setSelDraft("")
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
    if ((status?.plan ?? "free") !== "pro") {
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
    const thread = threadList.find((x) => x.id === id)
    threadRef.current = id
    setKind(thread?.kind)
    void setActiveThread(id)
    setMessages(thread?.m ?? [])
    setError(null)
    setView("chat")
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
            <QIcon.Cursor /> {t("qiInsertIntoField")}
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
    void renameThread(id, name).then(() => loadThreads()).then(({ threads }) => setThreadList(chatList(threads)))
  }, [])

  const removeThread = useCallback((id: string) => {
    void deleteThread(id)
    setThreadList((list) => list.filter((x) => x.id !== id))
    if (id === threadRef.current) {
      const id2 = newThreadId()
      threadRef.current = id2
      setKind(undefined)
      void setActiveThread(id2)
      setMessages([])
      setError(null)
    }
  }, [])

  /** A chat deleted from the list (its trash button or a swipe), with "Chat deleted · Undo" (2.5). */
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
          void (async () => {
            await saveThread(gone.id, gone.m, gone.kind)
            if (gone.title) await renameThread(gone.id, gone.title)
            if (gone.tags?.length) await setThreadTags(gone.id, gone.tags)
            if (gone.pin) await pinThread(gone.id, gone.pin)
            const { threads } = await loadThreads()
            setThreadList(chatList(threads))
            void sendBackground({ type: "uxEvent", kind: "ux_delete", action: "undone", what: "chat" })
          })()
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
  const openApp = useCallback(async (target: "subscribe" | "manage", feature?: "ai" | "organize") => {
    const result = await sendBackground<{ opened: boolean; url: string }>({ type: "openApp", target, feature })
    if (result && !result.opened && result.url) followLink(result.url)
  }, [])

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
  const actions = historyMode ? [] : contextKind === "selection" ? SELECTION_ACTIONS : contextKind === "page" ? PAGE_ACTIONS : []
  const plan = status?.plan ?? "free"
  const ownKeyActive = viaOwnKey || (Boolean(status?.hasOwnKey) && plan !== "free")
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

  // ------------------------------------------------------------ "Come back later" (2.5, later.ts)
  /** The window: Remind (this evening, tomorrow morning, in a week, a date of one's own), then the sections added there. */
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
        title={t("uxLaterTitle")}
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
            openReminders("link")
          }}>{t("uxAllReminders")}</button>
        )}
      </RemindSheet>
    )
  }
  /** The reminders still to ring in every chat (the soonest first), then watching's rows (later.ts). */
  const laterItems = async (): Promise<LaterItem[]> => {
    const [{ threads }, dev] = await Promise.all([loadThreads(), thisDevice()])
    const now = Date.now()
    const reminders: LaterItem[] = []
    for (const [chat, thread] of Object.entries(threads)) {
      if (thread.deleted) continue
      for (const m of thread.m) {
        if (!m.remind || m.remind.at <= now) continue
        const page = m.note ? m.page : undefined
        // It rings on the device that set it (`dev`); one without it was set before 2.5's marks.
        const here = !m.remind.dev || m.remind.dev === dev
        reminders.push({
          id: `remind:${chat}:${entryKey(m)}`,
          kind: "remind",
          title: page ? page.title || page.url : thread.title || threadTitle(thread.m),
          ...(m.remind.page && page ? { url: page.url } : {}),
          status: here ? remindLabel(m.remind.at) : t("uxOnAnotherDevice", remindLabel(m.remind.at)),
          sortAt: m.remind.at,
          here
        })
      }
    }
    const watches = (await Promise.all(laterSources().map((s) => s.items().catch(() => [] as LaterItem[])))).flat()
    return [...reminders.sort((a, b) => a.sortAt - b.sortAt), ...watches.sort((a, b) => b.sortAt - a.sortAt)]
  }
  const openReminders = (via: "menu" | "link") => {
    setLaterList(null)
    setRemindersOpen(true)
    void laterItems().then((items) => {
      setLaterList(items)
      setLaterCount(items.length)
      void sendBackground({ type: "useEvent", f: "later", a: "list", via, reminders: String(items.filter((i) => i.kind === "remind").length), watches: String(items.filter((i) => i.kind === "watch").length) })
    }).catch(() => setLaterList([]))
  }
  /** A page reminder or a watch opens its page in a new tab; a reminder on an answer or a note, its chat at it. */
  const openLaterItem = (item: LaterItem) => {
    if (item.url) {
      window.open(item.url, "_blank", "noopener")
      return
    }
    const [, chat, key] = item.id.split(":")
    const at = threadList.find((x) => x.id === chat)?.m.findIndex((m) => entryKey(m) === key) ?? -1
    setRemindersOpen(false)
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
    setLaterCount(items.length)
  }
  // The actions added to the selection bubble, after Template (watching's eye); none for plain text.
  const bubbleExtras: VNode[] = bubble?.rect && !open && !popup
    ? bubbleActions().flatMap((render, i) => {
        const ctx: BubbleContext = { url: source.href(), key: source.key(), title: source.title(), selection: bubble.text, range: pageRange(HOST_TAG), close: () => setBubble(null) }
        const node = render(ctx)
        return node ? [<Fragment key={i}>{node}</Fragment>] : []
      })
    : []

  // The allowance under the input: short, to share the line with "Whole chat" and Get Pro; in full on hover.
  const usageLine = useMemo(() => {
    if (ownKeyActive) return { short: t("usageOwnKey"), full: t("usageOwnKey") }
    if (!usage) return { short: "", full: "" }
    const left = Math.max(0, usage.limit - usage.used)
    return plan === "pro"
      ? { short: t("usageProShort", left, usage.limit), full: t("usagePro", left, usage.limit) }
      : { short: t("usageFreeShort", left, usage.limit), full: t("usageFree", left, usage.limit) }
  }, [usage, plan, ownKeyActive])

  // ------------------------------------------------------------ organizing (2.5)
  // Suggestions for the chat shown (Pro, with suggestions on): asked once an answer or a note is in, or the chat
  // opens. They belong to the chat as it was (its length) and go when it changes; at most one row under a message.
  const orgCfg = status?.organize?.config ?? DEFAULT_ORGANIZE
  const orgOn = TARGET === "safari" && plan === "pro" && Boolean(status?.organize?.on) && settings.organize
  const [org, setOrg] = useState<{ chat: string; length: number; move: OrganizeMove | null; tags: Array<{ index: number; key: string; tag: string }> } | null>(null)
  const [cards, setCards] = useState<OrganizeCards | null>(null)
  // "Everything in one chat?" showing in this chat; the card after the third tag; the line after the first one taken.
  const [messFor, setMessFor] = useState<string | null>(null)
  const [tagsCard, setTagsCard] = useState(false)
  const [firstWin, setFirstWin] = useState(false)
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

  // The first suggestion taken: a line that from now on they come by themselves (once).
  const won = () => {
    if (!cards || cards.firstWin) return
    setFirstWin(true)
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
    setThreadList(chatList(threads))
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
    setThreadList(chatList(moved.threads))
    const left = moved.threads[source]
    // The panel stays on this chat ("Open" goes to the other one), unless nothing is left in it.
    if (left && !left.deleted) setMessages(left.m)
    else showChat(target, moved.threads)
    orgEvent({ kind: "organize", action: "accepted", what: move.to ? "move" : "new", why: move.why })
    setUndoBar({
      text: t("orgMoved", move.toName),
      actions: [
        { label: t("orgUndo"), run: () => void undoChatMove(moved.undo) },
        { label: t("orgOpen"), run: () => { setUndoBar(null); void loadThreads().then(({ threads }) => showChat(target, threads)) } }
      ]
    })
    won()
  }
  const refuseMove = (move: OrganizeMove) => {
    setMessages((list) => list.map((m, i) => (i < move.start || i > move.end ? m : { ...m, dismissed: { ...m.dismissed, move: true as const } })))
    setOrg((o) => o && { ...o, move: null })
    orgEvent({ kind: "organize", action: "dismissed", what: move.to ? "move" : "new", why: move.why })
  }

  // The bar lives its seconds, then goes; before that only an action takes it: a question, a note, another chat, a
  // new bar or its own buttons (they clear it there). Touching or scrolling the chat leaves it (2.5: a scroll used
  // to take the Undo away).
  useEffect(() => {
    if (!undoBar) return
    const timer = setTimeout(() => setUndoBar(null), UNDO_BAR_MS)
    return () => clearTimeout(timer)
  }, [undoBar])

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
  const consentCard = TARGET === "safari" && plan === "pro" && Boolean(status?.organize?.on) && !settings.organize && cards !== null && !cards.consent && idle && (mixed || pageElsewhere)
  const promoOk = TARGET === "safari" && plan !== "pro" && cards !== null && idle
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
    if (upsell && TARGET === "safari" && plan !== "pro") orgEvent({ kind: "organize_promo", action: "shown", where: "pro_card" })
  }, [upsell])

  /** Tags the user set on a message: after their third tag in all, what organizing does (without Pro, once). */
  const userTags = (index: number, next: string[]) => {
    const known = new Set(allTags(threadList).map((x) => x.tag.toLowerCase()))
    for (const m of messages) for (const tag of m.tags ?? []) known.add(tag.toLowerCase())
    const added = cleanTags(next).filter((tag) => !known.has(tag.toLowerCase())).length
    tagMessage(index, next)
    if (known.size < 3 && known.size + added >= 3 && TARGET === "safari" && plan !== "pro" && cards && !cards.thirdTag) {
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
      {firstWin && orgOn && <div class="cf-org-win" role="status"><Icon.Sparkle size={13} /> {t("orgFirstWin")}</div>}
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
          class={`cf-fab ${settings.fabSide === "left" ? "left" : "right"}`}
          style={{ top: `${dragY ?? settings.fabY}%` }}
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
        </button>
      )}

      {/* The page reminder is set: said here too (on iPhone the selection, and its buttons, are gone by now). */}
      {remindSaved !== null && !bubble?.rect && !open && (
        <div class="cf-toast cf-snack" role="status" style={{ top: `${(window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight) - 64}px` }}>
          <Bell size={14} /> {remindSaved > 0 ? t("uxRemindSaved", remindLabel(remindSaved)) : remindSaved < 0 ? t("uxRemindNotSet") : t("uxRemindNoApp")}
        </div>
      )}
      {later && !open && laterSheet(true)}

      {bubble?.rect && !open && !popup && (
        <SelectionBubble rect={bubble.rect} touch={touch}>
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
                    {/* "Ask AI" on narrow screens (320 pt: iPhone mini and SE with Display Zoom), so the buttons fit. */}
                    <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={16} /> {t(narrowScreen() || (bubbleExtras.length > 0 && compactRow()) ? "selAsk" : "fabLabel")}</button>
                    <button type="button" class="cf-sel-icon" aria-label={t("actGoogle")} title={t("actGoogle")} {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}><Icon.Search size={15} /></button>
                    {/* Template keeps its word next to watching's eye (the audit, 27): below 400 pt "Ask ContextFlow" is the one that shortens. */}
                    <button type="button" class="cf-sel-template" aria-label={t("qiTemplateButton")} title={t("qiTemplateButton")} {...press(() => newTemplate(bubble))}><QIcon.Template /> {t("qiTemplateButton")}</button>
                    {bubbleExtras}
                  </>
                ) : (
                  <>
                    <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={14} /> {t("selAsk")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[0]), 60) })}>{t("selExplain")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[2]), 60) })}>{t("selTranslate")}</button>
                    <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}><Icon.Search size={13} /> {t("actGoogle")}</button>
                    <button type="button" class="cf-sel-template" {...press(() => newTemplate(bubble))}><QIcon.Template size={14} /> {t("qiTemplateButton")}</button>
                    {bubbleExtras}
                  </>
                )}
              </div>
              <div class="cf-bubble-ask">
                <input
                  type="text"
                  value={selDraft}
                  placeholder={t(touch ? "selQuestion" : "placeholderSelection")}
                  aria-label={t("placeholderSelection")}
                  enterKeyHint="send"
                  autoComplete="off"
                  onFocus={() => (selTyping.current = true)}
                  onBlur={() => (selTyping.current = false)}
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
                {/* iPhone and iPad: send shows once there's a question, so the field has room for it. */}
                {(!touch || selDraft.trim()) && <button type="button" class="cf-bubble-send" disabled={!selDraft.trim()} aria-label={t("send")} title={t("send")} {...press(() => askAboutSelection(bubble, selDraft))}><Icon.ArrowUp /></button>}
                <button type="button" class="cf-sel-note" title={t("selNoteTitle")} aria-label={t("selNote")} {...press(() => void noteSelection(bubble, selDraft))}><Icon.Pencil />{!(touch && narrowScreen()) && ` ${t("selNote")}`}</button>
              </div>
              {selHint && <div class="cf-bubble-hint">{t("selHint")}</div>}
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
              <button type="button" class="cf-icon" onClick={() => setView("chat")} aria-label={t("back")}><Icon.Back /></button>
            ) : (
              <span class="cf-logo"><Icon.Sparkle size={18} /></span>
            )}
            <div class="cf-title">
              {view !== "chat" ? (
                <strong>{view === "settings" ? t("settings") : view === "templates" ? t("qiTemplatesTitle") : t("chatsTitle")}</strong>
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
            {view === "chat" && threadList.length > 0 && (
              <button type="button" class="cf-icon cf-chats-button" onClick={() => setView("threads")} aria-label={t("allChats")} title={t("allChats")}>
                <Icon.Chats />
                <span class="cf-badge">{threadList.length}</span>
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
                    void laterItems().then((items) => setLaterCount(items.length)).catch(() => setLaterCount(0))
                  }
                  setPageMenu(!pageMenu)
                }}><More size={18} /></button>
                {pageMenu && (
                  <PageMenu
                    onLater={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "later" })
                      void sendBackground({ type: "useEvent", f: "later", a: "open", via: "menu" })
                      setLater({ selection, range: pageRange(HOST_TAG) })
                    }}
                    reminders={laterCount}
                    onReminders={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "reminders" })
                      openReminders("menu")
                    }}
                    onSettings={() => {
                      setPageMenu(false)
                      void sendBackground({ type: "useEvent", f: "menu", a: "pick", what: "settings" })
                      setView("settings")
                    }}
                    onClose={() => setPageMenu(false)}
                  />
                )}
              </span>
            )}
            <button type="button" class="cf-icon" onClick={hide} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
          </header>

          {view === "threads" ? (
            <>
              {hintDue("chats") && threadList.length > 0 && (
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
                onOpen={openThread}
                onRename={renameChat}
                onDelete={deleteChatWithUndo}
                onNew={newChat}
                onPin={pinChat}
                onMove={moveChat}
                onOpenPage={openPage}
                pro={plan === "pro"}
                onAskHistory={askHistory}
                onFind={findChats}
                findWaiting={findConsent !== null}
                onUpsell={setUpsell}
                findError={(code) => (code === "LIMIT_REACHED" ? t("limitProTitle") : errorText({ code: code as ErrorCode }))}
                onTags={tagChat}
                grouped={settings.groupByTags}
                onGrouped={(on) => updateSettings({ groupByTags: on })}
                touch={touch}
              />
              <div class="cf-undo-host">{undoBar && <UndoBar text={undoBar.text} actions={undoBar.actions} />}</div>
            </>
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
                          <button type="button" key={a.id} class="cf-chip" onClick={() => runAction(a)}>{t(a.label)}</button>
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
                          <div class="cf-bubble-note">
                            <span class="cf-note-mark" aria-label={t("shareNote")}><Icon.Pencil /></span>{m.content}
                          </div>
                        ), !picked)
                      ) : (
                        <div class="cf-bubble-user">{m.mode === "google" && <span class="cf-user-mode"><Icon.Search size={12} /></span>}{m.label ?? m.content}</div>
                      )}
                      {m.sources && m.sources.length > 0 && <UsedSources notes={m.sources} />}
                      {m.note && messageFooter(m, idx, () => noteCopyText(m), () => noteShareText(messages, idx, shareLabels(chatLanguage(messages)), shareLinks()))}
                    </div>
                  ) : (
                    <div class={`cf-msg ai ${m.pinned ? "pinned-msg" : ""} ${picked ? "pickable" : ""} ${picked?.has(idx) ? "picked" : ""}`} key={idx} data-index={idx} {...pickProps(idx)} onContextMenu={picked ? undefined : ux.contextMenu(idx)}>
                      {ux.wrap(m, idx, (
                        <>
                          {m.grounding && <div class="cf-grounded"><Icon.Search size={13} /> {t("googleBadge")}</div>}
                          <Markdown text={m.content} marks={m.marks} onCopyCode={(code) => void copyText(code)} />
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
                    {partial ? <Markdown text={partial} /> : <div class="cf-thinking"><span /><span /><span /> {t(reading === "video" ? "readingVideo" : reading === "pdf" ? "readingPdf" : streamMode === "google" ? "searching" : "thinking")}</div>}
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && onNewPage && (
                  <div class="cf-newpage">
                    <div class="cf-divider"><span>{t("nowOnPage", source.title() || source.site())}</span></div>
                    <div class="cf-actions follow">
                      {actions.slice(0, 4).map((a) => (
                        <button type="button" key={a.id} class="cf-chip small" onClick={() => runAction(a)}>{t(a.label)}</button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && !onNewPage && messages.length < 3 && (
                  <div class="cf-actions follow">
                    {actions.filter((a) => !messages.some((m) => m.label === t(a.label))).slice(0, 3).map((a) => (
                      <button type="button" key={a.id} class="cf-chip small" onClick={() => runAction(a)}>{t(a.label)}</button>
                    ))}
                  </div>
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
                  return (
                    <div class="cf-card limit">
                      <strong>{long ? t("limitLongTitle") : plan === "pro" ? t("limitProTitle") : byok ? t("byokLimitTitle") : t("limitFreeTitle")}</strong>
                      <p>
                        {long && `${t("limitLongBody", error.weight!, left)} `}
                        {plan === "pro"
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
                      {plan !== "pro" && !byok && (
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

                {error && error.code === "PRO_ONLY" && (
                  <ProUpsell
                    feature="history"
                    offer={offer}
                    byok={byok ? { discount: byokDiscount } : undefined}
                    onPro={() => (byok ? upgrade("pro_only") : void openApp("subscribe", "ai"))}
                    onOffer={redeemOffer}
                    onClose={() => setError(null)}
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
                  {undoBar && <UndoBar text={undoBar.text} actions={undoBar.actions} />}
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
                      <button type="button" class="cf-send stop" onClick={stop} aria-label={t("stop")} title={t("stop")}><Icon.Stop /></button>
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
                      <input type="checkbox" role="switch" checked={settings.wholeChat} onChange={(e) => updateSettings({ wholeChat: e.currentTarget.checked })} />
                      <span class="cf-switch" aria-hidden="true" />
                      {t("wholeChat")}
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
          {touring && view === "chat" && panelRef.current && (
            <Tour panel={panelRef.current} steps={tourSteps(TARGET === "safari" && settings.syncChats, touch)} onDone={endTour} />
          )}
          {view === "chat" && !picked && ux.overlay}
          {view === "chat" && later && laterSheet(false)}
          {view === "chat" && remindersOpen && (
            <RemindersSheet items={laterList} onOpen={openLaterItem} onCancel={(item) => void cancelLaterItem(item)} onClose={() => setRemindersOpen(false)} />
          )}
        </section>
      )}

      {!popup && (
        <QuickInsert
          platform={platform}
          touch={touch}
          bus={bus}
          panelOpen={open}
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

// How long "… · Undo" stays (the app's bar too, ChatsView).
const UNDO_BAR_MS = 8_000

/** Below 400 pt the selection buttons' top row keeps only "Ask ContextFlow" with its words; the rest are icons. */
function compactRow(): boolean {
  return (window.visualViewport?.width ?? window.innerWidth) < 400
}

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
 * system edit menu, which iOS 26+ shows right below the selection and older versions above it.
 * Always within what's visible: above the keyboard while their field is typed in.
 */
function bubbleTop(rect: DOMRect, touch: boolean, height: number): number {
  const vv = window.visualViewport
  const top0 = vv?.offsetTop ?? 0
  const bottom = top0 + (vv?.height ?? window.innerHeight)
  const clear = touch ? 70 : 8
  let top = rect.bottom + clear
  if (top + height > bottom - 12 && rect.top - clear - height >= top0 + 8) top = rect.top - clear - height
  return Math.max(top0 + 8, Math.min(bottom - height - 12, top))
}

/** 320 pt wide or less room (iPhone mini and SE with Display Zoom): the selection buttons use shorter labels. */
function narrowScreen(): boolean {
  return (window.visualViewport?.width ?? window.innerWidth) < 360
}

/** The buttons shown for a page selection, centered under it and kept on screen. */
function SelectionBubble({ rect, touch, children }: { rect: DOMRect; touch: boolean; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const center = rect.left + rect.width / 2
    const place = () => {
      const vv = window.visualViewport
      const min = (vv?.offsetLeft ?? 0) + 8
      const max = min + (vv?.width ?? window.innerWidth) - 16 - el.offsetWidth
      el.style.left = `${Math.max(min, Math.min(max, center - el.offsetWidth / 2))}px`
      el.style.top = `${bubbleTop(rect, touch, el.offsetHeight)}px`
    }
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
  }, [rect, touch])
  return (
    // Clicks on the buttons keep the page selection; the field takes the focus.
    <div ref={ref} class={`cf-bubble ${touch ? "touch" : ""}`} onMouseDown={(e) => (e.target as Element).closest("input") || e.preventDefault()}>
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
                <a href={s.url} target="_blank" rel="noopener noreferrer"><span class="n">{i + 1}</span><span class="t">{s.title}</span></a>
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
      {kind === "page" && media === "video" ? <Icon.Play /> : <Icon.Doc />} <span class="cf-ctx-text">{kind === "page" ? title || t("ctxPage") : t("ctxNone")}</span>
    </span>
  )
}
