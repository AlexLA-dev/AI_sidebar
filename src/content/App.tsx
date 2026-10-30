import type { ComponentChildren, VNode } from "preact"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"

import { LINKS, TARGET } from "../shared/config"
import { t, type MessageKey } from "../shared/i18n"
import {
  DEFAULT_SETTINGS,
  type AskPayload,
  type ErrorCode,
  type Grounding,
  type Platform,
  type Settings,
  type StatusInfo,
  type StreamEvent,
  type Usage
} from "../shared/types"
import * as Icon from "./icons"
import { historyForModel, lastPage, pageHasChanged, textFingerprint, type Entry } from "../shared/conversation"
import { Markdown } from "./markdown"
import { answerShareText, chatLanguage, chatShareText, toPlainText, type ShareLinks } from "../shared/share"
import {
  extractPage,
  forgetSelection,
  isTouch,
  MIN_SELECTION_WORDS,
  pageKey,
  readSelection,
  recentSelection,
  rememberSelection,
  siteName,
  trackSelection,
  type SelectionInfo
} from "./page"
import { SettingsView } from "./Settings"
import { shareLabels } from "./shareLabels"
import { deleteThread, giveConsent, hasConsent, hasSeenTour, loadSettings, loadThreads, markTourSeen, onSettingsChanged, onThreadsChanged, renameThread, saveSettings, saveThread, setActiveThread } from "./store"
import { ThreadsView } from "./Threads"
import { Tour, tourSteps } from "./Tour"
import { liveThreads, newThreadId, shownThread, type Thread } from "../shared/threads"

export type Bus = EventTarget

type Turn = Entry

interface ChatError {
  code: ErrorCode
  message?: string
  usage?: Usage | null
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

function errorText(error: ChatError): string {
  switch (error.code) {
    case "NETWORK":
      return t("errNetwork")
    case "BUSY":
      return error.message || t("errBusy")
    case "UPSTREAM":
      return t("errUpstream")
    case "STREAM":
    case "EMPTY":
      return t("errInterrupted")
    case "BAD_KEY":
      return t("errBadKey")
    case "SEARCH_LIMIT":
      return t("errSearchLimit")
    case "SEARCH_UNAVAILABLE":
      return t("errSearchUnavailable")
    default:
      return t("errGeneric")
  }
}

export function App({ platform, bus }: { platform: Platform; bus: Bus }): VNode {
  const touch = isTouch(platform)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<"chat" | "settings" | "threads">("chat")
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [viaOwnKey, setViaOwnKey] = useState(false)
  const [consent, setConsent] = useState(true)
  const [messages, setMessages] = useState<Turn[]>([])
  // Chats as threads: the list (newest first) and the one shown, which every page and tab continues.
  const [threadList, setThreadList] = useState<Thread[]>([])
  const threadRef = useRef("")
  const [partial, setPartial] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<ChatError | null>(null)
  const [pending, setPending] = useState<{ text: string; label?: string; action?: string; mode?: "google" } | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [pageReadable, setPageReadable] = useState(true)
  const [wide, setWide] = useState(() => window.innerWidth >= 700)
  const [keyboard, setKeyboard] = useState(0)
  const [bubble, setBubble] = useState<SelectionInfo | null>(null)
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
  const [pageUrl, setPageUrl] = useState(pageKey())
  const pageUrlRef = useRef(pageUrl)
  const [chatCopied, setChatCopied] = useState(false)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const partialRef = useRef("")
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loadedRef = useRef(false)
  const openedAt = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const streaming = partial !== null
  const layout = wide ? "side" : "sheet"

  // ------------------------------------------------------------ settings
  useEffect(() => {
    void loadSettings().then(setSettings)
    void hasConsent().then(setConsent)
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
    setVisible(false)
    setTimeout(() => setOpen(false), 220)
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
    const key = pageKey()
    pageUrlRef.current = key
    setPageUrl(key)
    if (!portRef.current) {
      // Show the end of the conversation (and this page's actions under it).
      const scrollToEnd = () => requestAnimationFrame(() => {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
      })
      void loadThreads().then(({ threads, active }) => {
        loadedRef.current = true
        threadRef.current = active.id
        const entries = threads[active.id]?.m ?? []
        setThreadList(liveThreads(threads))
        setMessages(entries)
        scrollToEnd()
        // Other devices may have continued a chat (iCloud): show it unless something was asked here meanwhile.
        void sendBackground<{ changed: boolean }>({ type: "syncThreads" }).then(async (result) => {
          if (!result?.changed || portRef.current) return
          const fresh = await loadThreads()
          const next = shownThread(fresh.threads, fresh.active)
          setThreadList(liveThreads(fresh.threads))
          setMessages((current) => {
            if (current !== entries) return current
            if (next.id !== threadRef.current) {
              threadRef.current = next.id
              void setActiveThread(next.id)
            }
            return next.m
          })
          scrollToEnd()
        })
      })
    }
    setPageReadable(Boolean(document.body && (document.body.innerText || "").trim().length > 40))
    void refreshStatus()
    if (!touch) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 250)
  }, [open, refreshStatus, touch])

  // Single-page apps: follow URL changes while open (the conversation carries on).
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      const key = pageKey()
      if (key !== pageUrlRef.current) {
        pageUrlRef.current = key
        setPageUrl(key)
        forgetSelection()
        setSelection(null)
        setPageReadable(Boolean(document.body && (document.body.innerText || "").trim().length > 40))
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [open])

  // While open: the chat list follows other tabs and devices, and the answer counter other devices.
  useEffect(() => {
    if (!open) return
    const off = onThreadsChanged(() => void loadThreads().then(({ threads }) => setThreadList(liveThreads(threads))))
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
    if (tourSeen || touring || !visible || view !== "chat" || streaming || pending) return
    const timer = setTimeout(() => setTouring(true), 450)
    return () => clearTimeout(timer)
  }, [tourSeen, touring, visible, view, streaming, pending])

  // Persist the chat shown.
  useEffect(() => {
    if (!loadedRef.current) return
    const id = threadRef.current
    const timer = setTimeout(() => void saveThread(id, messages), 300)
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (touringRef.current) {
        endTour()
        return
      }
      // Escape in a chat's name field only cancels the renaming.
      if ((e.composedPath()[0] as HTMLElement | undefined)?.classList?.contains("cf-thread-name")) return
      hide()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, hide, endTour])

  // Keep the newest text in view while streaming.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, partial, error])

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
    partialRef.current = ""
    setPartial(null)
    setStreamMode(null)
    if (text) {
      const next: Turn[] = [...history, grounding ? { role: "assistant", content: text, grounding } : { role: "assistant", content: text }]
      setMessages(next)
      // Right away, not on the debounced save: the user may go to another page as soon as the answer is in.
      void saveThread(threadRef.current, next)
    }
    if (err) setError(err)
  }, [])

  const ask = useCallback((text: string, opts: { label?: string; action?: string; retry?: boolean; mode?: "google" } = {}) => {
    const content = text.trim()
    if (!content || portRef.current) return
    if (!consent) {
      setPending({ text: content, label: opts.label, action: opts.action, mode: opts.mode })
      return
    }
    const base = opts.retry ? messages.slice(0, messages.length - 1) : messages
    // The page as it is now: read fresh for every question, so new content is always in the request.
    const url = pageKey()
    const full = extractPage()
    const hash = textFingerprint(full.text)
    const changed = pageHasChanged(base, url, hash)
    const user: Turn = { role: "user", content, label: opts.label, page: { url, title: full.title, hash } }
    if (opts.mode) user.mode = opts.mode
    if (changed) user.pageChanged = true
    const history: Turn[] = [...base, user]
    setMessages(history)
    setDraft("")
    if (inputRef.current) inputRef.current.style.height = "auto"
    setError(null)
    setPartial("")
    setStreamMode(opts.mode ?? null)
    partialRef.current = ""

    const page: AskPayload["page"] = selection
      ? { kind: "selection", title: document.title.slice(0, 300), url: location.href, text: selection.text }
      : full.text ? { kind: "page", title: full.title, url: location.href, text: full.text, changed } : null
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
    port.onMessage.addListener((event: StreamEvent) => {
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
        finish(history, partialRef.current, { code: event.code, message: event.message, usage: event.usage })
      }
    })
    port.onDisconnect.addListener(() => {
      if (!settled && portRef.current === port) finish(history, partialRef.current, partialRef.current ? null : { code: "STREAM" })
    })
    port.postMessage({
      type: "ask",
      payload: {
        messages: historyForModel(history, url),
        page,
        action: opts.action,
        mode: opts.mode
      }
    })
  }, [consent, messages, selection, finish])

  const stop = useCallback(() => {
    const port = portRef.current
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
    if (text) setMessages((prev) => [...prev, { role: "assistant", content: text }])
  }, [])

  // `withoutGoogle`: ask the same question as a normal answer (e.g. after the Google limit).
  const retry = useCallback((withoutGoogle = false) => {
    const last = messages[messages.length - 1]
    if (last?.role !== "user") return
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
    setConsent(true)
    const p = pending
    setPending(null)
    if (p) setTimeout(() => askRef.current(p.text, { label: p.label, action: p.action, mode: p.mode }), 0)
  }, [pending])
  const askRef = useRef(ask)
  askRef.current = ask

  /** Starts a new thread; the previous one stays in the list. */
  const newChat = useCallback(() => {
    stop()
    const id = newThreadId()
    threadRef.current = id
    void setActiveThread(id)
    setMessages([])
    setError(null)
    setView("chat")
  }, [stop])

  const openThread = useCallback((id: string) => {
    stop()
    const thread = threadList.find((x) => x.id === id)
    threadRef.current = id
    void setActiveThread(id)
    setMessages(thread?.m ?? [])
    setError(null)
    setView("chat")
    requestAnimationFrame(() => {
      const list = listRef.current
      if (list) list.scrollTop = list.scrollHeight
    })
  }, [stop, threadList])

  const renameChat = useCallback((id: string, name: string) => {
    void renameThread(id, name).then(() => loadThreads()).then(({ threads }) => setThreadList(liveThreads(threads)))
  }, [])

  const removeThread = useCallback((id: string) => {
    void deleteThread(id)
    setThreadList((list) => list.filter((x) => x.id !== id))
    if (id === threadRef.current) {
      const id2 = newThreadId()
      threadRef.current = id2
      void setActiveThread(id2)
      setMessages([])
      setError(null)
    }
  }, [])

  // ------------------------------------------------------------ sharing
  const shareLinks = (): ShareLinks => ({ page: location.href, app: LINKS.appStoreShare })

  /** Shares text (copies it where sharing isn't available). True when it was copied. */
  const shareText = useCallback(async (text: string): Promise<boolean> => {
    if (typeof navigator.share === "function") {
      // Text only: with a `url` as well, iOS shares the App Store page and the text gets lost.
      await navigator.share({ text }).catch(() => undefined)
      return false
    }
    return copyText(text)
  }, [])

  /** Shares (or copies, where sharing isn't available) the whole conversation. */
  const shareChat = useCallback(async () => {
    if (await shareText(chatShareText(messages, shareLabels(chatLanguage(messages)), shareLinks()))) {
      setChatCopied(true)
      setTimeout(() => setChatCopied(false), 1500)
    }
  }, [messages, shareText])

  // ------------------------------------------------------------ upgrade
  const openApp = useCallback(async (target: "subscribe" | "manage") => {
    const result = await sendBackground<{ opened: boolean; url: string }>({ type: "openApp", target })
    if (result && !result.opened && result.url) followLink(result.url)
  }, [])

  // ------------------------------------------------------------ FAB
  const fabEnabled = settings.fab !== "off"
  const fabVisible = fabEnabled && !open && !settings.fabHiddenSites.includes(siteName())
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
  const actions = contextKind === "selection" ? SELECTION_ACTIONS : contextKind === "page" ? PAGE_ACTIONS : []
  const plan = status?.plan ?? "free"
  const ownKeyActive = viaOwnKey || (Boolean(status?.hasOwnKey) && plan !== "free")

  const usageLine = useMemo(() => {
    if (ownKeyActive) return t("usageOwnKey")
    if (!usage) return ""
    const left = Math.max(0, usage.limit - usage.used)
    return plan === "pro" ? t("usagePro", left, usage.limit) : t("usageFree", left, usage.limit)
  }, [usage, plan, ownKeyActive])

  const theme = settings.theme === "auto" ? undefined : settings.theme
  const lastIsUser = messages[messages.length - 1]?.role === "user"
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

      {bubble?.rect && !open && (
        <SelectionBubble rect={bubble.rect} touch={touch}>
          {touch ? (
            <>
              <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={16} /> {t("fabLabel")}</button>
              <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}><Icon.Search size={15} /> {t("actGoogle")}</button>
            </>
          ) : (
            <>
              <button type="button" class="primary" {...press(() => show(bubble))}><Icon.Sparkle size={14} /> {t("selAsk")}</button>
              <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[0]), 60) })}>{t("selExplain")}</button>
              <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[2]), 60) })}>{t("selTranslate")}</button>
              <button type="button" {...press(() => { show(bubble); setTimeout(() => runActionRef.current(SEL_GOOGLE), 60) })}><Icon.Search size={13} /> {t("actGoogle")}</button>
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
                <strong>{view === "settings" ? t("settings") : t("chatsTitle")}</strong>
              ) : (
                <ContextChip
                  kind={contextKind}
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
              <button type="button" class="cf-icon" onClick={() => void shareChat()} aria-label={t("shareChat")} title={chatCopied ? t("copied") : t("shareChat")}>
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
              <button type="button" class="cf-icon cf-settings-button" onClick={() => setView("settings")} aria-label={t("settings")} title={t("settings")}><Icon.Gear /></button>
            )}
            <button type="button" class="cf-icon" onClick={hide} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
          </header>

          {view === "threads" ? (
            <ThreadsView threads={threadList} activeId={threadRef.current} onOpen={openThread} onRename={renameChat} onDelete={removeThread} onNew={newChat} />
          ) : view === "settings" ? (
            <SettingsView
              settings={settings}
              status={status}
              usage={usage}
              platform={platform}
              site={siteName()}
              onChange={updateSettings}
              onUpgrade={() => void openApp("subscribe")}
              onManage={() => void openApp("manage")}
              onStatusChange={() => void refreshStatus(true)}
              onOpenUrl={(url) => void sendBackground({ type: "openUrl", url })}
              onShowTour={() => {
                setView("chat")
                setTouring(true)
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
              <div class="cf-messages" ref={listRef}>
                {messages.length === 0 && partial === null && (
                  <div class="cf-empty">
                    <div class="cf-empty-icon"><Icon.Sparkle size={28} /></div>
                    <h2>{t("emptyTitle")}</h2>
                    <p>{t(contextKind === "selection" ? "emptySelection" : contextKind === "page" ? "emptyPage" : "emptyNone")}</p>
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
                    <div class="cf-msg user" key={idx}>
                      <PageDivider entries={messages} index={idx} />
                      <div class="cf-bubble-user">{m.mode === "google" && <span class="cf-user-mode"><Icon.Search size={12} /></span>}{m.label ?? m.content}</div>
                    </div>
                  ) : (
                    <div class="cf-msg ai" key={idx}>
                      {m.grounding && <div class="cf-grounded"><Icon.Search size={13} /> {t("googleBadge")}</div>}
                      <Markdown text={m.content} onCopyCode={(code) => void copyText(code)} />
                      {m.grounding && <Sources grounding={m.grounding} />}
                      <div class="cf-msg-tools">
                        <button type="button" onClick={async () => { if (await copyText(toPlainText(m.content))) { setCopied(idx); setTimeout(() => setCopied(null), 1500) } }}>
                          {copied === idx ? <Icon.Check /> : <Icon.Copy />} {copied === idx ? t("copied") : t("copy")}
                        </button>
                        {typeof navigator.share === "function" && (
                          <button type="button" onClick={() => void shareText(answerShareText(messages, idx, shareLabels(chatLanguage(messages)), shareLinks()))}>
                            <Icon.Share /> {t("share")}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                )}

                {partial !== null && (
                  <div class="cf-msg ai">
                    {partial ? <Markdown text={partial} /> : <div class="cf-thinking"><span /><span /><span /> {t(streamMode === "google" ? "searching" : "thinking")}</div>}
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && onNewPage && (
                  <div class="cf-newpage">
                    <div class="cf-divider"><span>{t("nowOnPage", document.title || siteName())}</span></div>
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

                {error && error.code === "LIMIT_REACHED" && (
                  <div class="cf-card limit">
                    <strong>{plan === "pro" ? t("limitProTitle") : t("limitFreeTitle")}</strong>
                    <p>
                      {plan === "pro"
                        ? t("limitProBody", timeUntil(error.usage?.resetsAt ?? usage?.resetsAt))
                        : t("limitFreeBody", timeUntil(error.usage?.resetsAt ?? usage?.resetsAt), 375)}
                    </p>
                    {plan !== "pro" && (
                      <div class="cf-card-actions">
                        <button type="button" class="cf-primary" onClick={() => void openApp("subscribe")}><Icon.Sparkle size={14} /> {t("getPro")}</button>
                        <button type="button" class="cf-secondary" onClick={() => setView("settings")}>{t("useOwnKey")}</button>
                      </div>
                    )}
                  </div>
                )}

                {error && error.code !== "LIMIT_REACHED" && (
                  <div class="cf-card error">
                    <p>{errorText(error)}</p>
                    <div class="cf-card-actions">
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

                {pending && (
                  <div class="cf-card consent">
                    <strong>{t("consentTitle")}</strong>
                    <p>{t("consentBody")}</p>
                    <div class="cf-card-actions">
                      <button type="button" class="cf-primary" onClick={() => void acceptConsent()}>{t("consentAccept")}</button>
                      <button type="button" class="cf-link" onClick={() => void sendBackground({ type: "openUrl", url: LINKS.privacy })}>{t("privacyPolicy")}</button>
                    </div>
                  </div>
                )}
              </div>

              <footer class="cf-composer">
                <div class="cf-input">
                  <button
                    type="button"
                    class={`cf-mode ${googleMode ? "on" : ""}`}
                    aria-pressed={googleMode}
                    title={t("googleModeHint")}
                    onClick={() => setGoogleMode(!googleMode)}
                  >
                    <Icon.Search size={14} /> {t("actGoogle")}
                  </button>
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={draft}
                    placeholder={t(googleMode ? "placeholderGoogle" : contextKind === "selection" ? "placeholderSelection" : contextKind === "page" ? "placeholderPage" : "placeholderNone")}
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
                        ask(draft, { mode: googleMode ? "google" : undefined })
                      }
                      e.stopPropagation()
                    }}
                    onKeyUp={(e) => e.stopPropagation()}
                    onKeyPress={(e) => e.stopPropagation()}
                  />
                  {streaming ? (
                    <button type="button" class="cf-send stop" onClick={stop} aria-label={t("stop")} title={t("stop")}><Icon.Stop /></button>
                  ) : (
                    <button type="button" class="cf-send" disabled={!draft.trim()} onClick={() => ask(draft, { mode: googleMode ? "google" : undefined })} aria-label={t("send")} title={t("send")}><Icon.ArrowUp /></button>
                  )}
                </div>
                {usageLine && (
                  <div class="cf-usage">
                    <span>{usageLine}</span>
                    {plan === "free" && !ownKeyActive && TARGET === "safari" && (
                      <button type="button" class="cf-link" onClick={() => void openApp("subscribe")}>{t("getPro")}</button>
                    )}
                  </div>
                )}
              </footer>
            </>
          )}
          {touring && view === "chat" && panelRef.current && (
            <Tour panel={panelRef.current} steps={tourSteps(TARGET === "safari" && settings.syncChats)} onDone={endTour} />
          )}
        </section>
      )}
    </div>
  )
}

const runActionRef: { current: (a: Action) => void } = { current: () => undefined }

/** Above a question: "New page: …" when it moved to another page, "Page updated" when the page changed. */
function PageDivider({ entries, index }: { entries: Entry[]; index: number }): VNode | null {
  const m = entries[index]
  const previous = lastPage(entries.slice(0, index))
  if (m.page && previous && previous.url !== m.page.url) {
    return <div class="cf-divider"><span>{t("newPage", m.page.title || m.page.url)}</span></div>
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
 * Where the selection button goes. iPhone and iPad: below the selection (above it when there's no
 * room), clear of the selection handles and of the system edit menu, which iOS 26+ shows right
 * below the selection and older versions above it.
 */
function bubbleTop(rect: DOMRect, touch: boolean): number {
  const vv = window.visualViewport
  const top0 = vv?.offsetTop ?? 0
  const bottom = top0 + (vv?.height ?? window.innerHeight)
  const HEIGHT = 48
  if (!touch) return Math.min(bottom - 52, rect.bottom + 8)
  const CLEAR = 70
  let top = rect.bottom + CLEAR
  if (top + HEIGHT > bottom - 12) top = rect.top - CLEAR - HEIGHT
  return Math.max(top0 + 8, Math.min(bottom - HEIGHT - 12, top))
}

/** The buttons shown for a page selection, centered under it and kept on screen. */
function SelectionBubble({ rect, touch, children }: { rect: DOMRect; touch: boolean; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const center = rect.left + rect.width / 2
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const vv = window.visualViewport
    const min = (vv?.offsetLeft ?? 0) + 8
    const max = min + (vv?.width ?? window.innerWidth) - 16 - el.offsetWidth
    el.style.left = `${Math.max(min, Math.min(max, center - el.offsetWidth / 2))}px`
  }, [center])
  return (
    <div ref={ref} class={`cf-bubble ${touch ? "touch" : ""}`} style={{ top: `${bubbleTop(rect, touch)}px` }} onMouseDown={(e) => e.preventDefault()}>
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
  useEffect(() => {
    const host = ref.current
    if (!host) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })
    root.replaceChildren(suggestionNodes(html))
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

function ContextChip({ kind, words, text, onClear }: { kind: "selection" | "page" | "none"; words: number; text: string; onClear: () => void }): VNode {
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
      <Icon.Doc /> <span class="cf-ctx-text">{kind === "page" ? document.title || t("ctxPage") : t("ctxNone")}</span>
    </span>
  )
}
