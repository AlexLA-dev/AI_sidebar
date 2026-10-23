import type { VNode } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"

import { LINKS, TARGET } from "../shared/config"
import { t, type MessageKey } from "../shared/i18n"
import {
  DEFAULT_SETTINGS,
  type ChatTurn,
  type ErrorCode,
  type Platform,
  type Settings,
  type StatusInfo,
  type StreamEvent,
  type Usage
} from "../shared/types"
import * as Icon from "./icons"
import { Markdown, toPlainText } from "./markdown"
import {
  buildContext,
  forgetSelection,
  isTouch,
  pageKey,
  readSelection,
  recentSelection,
  siteName,
  trackSelection,
  type SelectionInfo
} from "./page"
import { SettingsView } from "./Settings"
import { giveConsent, hasConsent, loadChat, loadSettings, onSettingsChanged, saveChat, saveSettings } from "./store"

export type Bus = EventTarget

interface Turn extends ChatTurn {
  label?: string
}

interface ChatError {
  code: ErrorCode
  message?: string
  usage?: Usage | null
}

interface Action {
  id: string
  label: MessageKey
  prompt: MessageKey
}

const PAGE_ACTIONS: Action[] = [
  { id: "summarize", label: "actSummarize", prompt: "promptSummarize" },
  { id: "key_points", label: "actKeyPoints", prompt: "promptKeyPoints" },
  { id: "explain", label: "actExplain", prompt: "promptExplain" },
  { id: "translate", label: "actTranslate", prompt: "promptTranslate" }
]

const SELECTION_ACTIONS: Action[] = [
  { id: "sel_explain", label: "actExplain", prompt: "promptSelExplain" },
  { id: "sel_summarize", label: "actSummarize", prompt: "promptSelSummarize" },
  { id: "sel_translate", label: "actTranslate", prompt: "promptSelTranslate" },
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
    default:
      return t("errGeneric")
  }
}

export function App({ platform, bus }: { platform: Platform; bus: Bus }): VNode {
  const touch = isTouch(platform)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<"chat" | "settings">("chat")
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [viaOwnKey, setViaOwnKey] = useState(false)
  const [consent, setConsent] = useState(true)
  const [messages, setMessages] = useState<Turn[]>([])
  const [partial, setPartial] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<ChatError | null>(null)
  const [pending, setPending] = useState<{ text: string; label?: string; action?: string } | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [pageReadable, setPageReadable] = useState(true)
  const [wide, setWide] = useState(() => window.innerWidth >= 700)
  const [keyboard, setKeyboard] = useState(0)
  const [bubble, setBubble] = useState<SelectionInfo | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)

  const keyRef = useRef(pageKey())
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const partialRef = useRef("")
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const streaming = partial !== null
  const layout = wide ? "side" : "sheet"

  // ------------------------------------------------------------ settings
  useEffect(() => {
    void loadSettings().then(setSettings)
    void hasConsent().then(setConsent)
    return onSettingsChanged(setSettings)
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch }
    setSettings(next)
    void saveSettings(next)
  }, [])

  // ------------------------------------------------------------ status
  const refreshStatus = useCallback(async (refresh = false) => {
    const next = await sendBackground<StatusInfo>({ type: "status", refresh, platform })
    if (next) {
      setStatus(next)
      setUsage(next.usage)
    }
  }, [platform])

  // ------------------------------------------------------------ open/close
  const show = useCallback((preferSelection = true) => {
    const sel = preferSelection ? recentSelection() : null
    setSelection(sel)
    setBubble(null)
    setView("chat")
    setOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }, [])

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

  // Load the conversation of this page and fresh status whenever the panel opens.
  useEffect(() => {
    if (!open) return
    const key = pageKey()
    keyRef.current = key
    if (loadedKeyRef.current !== key) {
      loadedKeyRef.current = key
      setError(null)
      void loadChat(key).then(setMessages)
    }
    setPageReadable(Boolean(document.body && (document.body.innerText || "").trim().length > 40))
    void refreshStatus()
    if (!touch) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 250)
  }, [open, refreshStatus, touch])

  // Single-page apps: follow URL changes while open.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      const key = pageKey()
      if (key !== keyRef.current && !portRef.current) {
        keyRef.current = key
        loadedKeyRef.current = key
        forgetSelection()
        setSelection(null)
        setError(null)
        void loadChat(key).then(setMessages)
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [open])

  // Coming back from the ContextFlow app (e.g. after subscribing) → re-check the plan.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && open) void refreshStatus(true)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [open, refreshStatus])

  // Persist conversations per page.
  useEffect(() => {
    if (loadedKeyRef.current !== keyRef.current) return
    const timer = setTimeout(() => void saveChat(keyRef.current, document.title, messages), 300)
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
      if (e.key === "Escape") hide()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, hide])

  // Keep the newest text in view while streaming.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, partial, error])

  // ------------------------------------------------------------ selection
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onSelectionChange = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const sel = trackSelection()
        if (open && sel && sel.words >= 3) setSelection(sel)
        if (!sel) setBubble(null)
      }, 250)
    }
    const onMouseUp = (e: MouseEvent) => {
      if (touch || !settingsRef.current.selectionButton || open) return
      if ((e.target as Element | null)?.closest?.("contextflow-root")) return
      setTimeout(() => {
        const sel = readSelection()
        setBubble(sel && sel.words >= 3 && sel.rect ? sel : null)
      }, 10)
    }
    const onScroll = () => setBubble(null)
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("mouseup", onMouseUp)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      clearTimeout(timer)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("scroll", onScroll)
    }
  }, [open, touch])

  // ------------------------------------------------------------ chat
  const finish = useCallback((history: Turn[], text: string, err: ChatError | null) => {
    portRef.current = null
    partialRef.current = ""
    setPartial(null)
    if (text) setMessages([...history, { role: "assistant", content: text }])
    if (err) setError(err)
  }, [])

  const ask = useCallback((text: string, opts: { label?: string; action?: string; retry?: boolean } = {}) => {
    const content = text.trim()
    if (!content || portRef.current) return
    if (!consent) {
      setPending({ text: content, label: opts.label, action: opts.action })
      return
    }
    const base = opts.retry ? messages.slice(0, messages.length - 1) : messages
    const history: Turn[] = [...base, { role: "user", content, label: opts.label }]
    setMessages(history)
    setDraft("")
    setError(null)
    setPartial("")
    partialRef.current = ""

    const page = buildContext(Boolean(selection))
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: "chat" })
    } catch {
      finish(history, "", { code: "NETWORK" })
      return
    }
    portRef.current = port
    let settled = false
    port.onMessage.addListener((event: StreamEvent) => {
      if (event.type === "meta") {
        setViaOwnKey(event.viaOwnKey)
        if (event.usage) setUsage(event.usage)
      } else if (event.type === "delta") {
        partialRef.current += event.text
        setPartial(partialRef.current)
      } else if (event.type === "done") {
        settled = true
        if (event.usage) setUsage(event.usage)
        finish(history, partialRef.current, null)
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
      payload: { messages: history.slice(-12).map(({ role, content: c }) => ({ role, content: c })), page, action: opts.action }
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
    if (text) setMessages((prev) => [...prev, { role: "assistant", content: text }])
  }, [])

  const retry = useCallback(() => {
    const last = messages[messages.length - 1]
    if (last?.role === "user") ask(last.content, { label: last.label, retry: true })
  }, [messages, ask])

  const runAction = useCallback((action: Action) => {
    const language = t("languageName")
    ask(t(action.prompt, language), { label: t(action.label), action: action.id })
  }, [ask])
  runActionRef.current = runAction

  const acceptConsent = useCallback(async () => {
    await giveConsent()
    setConsent(true)
    const p = pending
    setPending(null)
    if (p) setTimeout(() => askRef.current(p.text, { label: p.label, action: p.action }), 0)
  }, [pending])
  const askRef = useRef(ask)
  askRef.current = ask

  const newChat = useCallback(() => {
    stop()
    setMessages([])
    setError(null)
    void saveChat(keyRef.current, "", [])
  }, [stop])

  // ------------------------------------------------------------ upgrade
  const openApp = useCallback(async (target: "subscribe" | "manage") => {
    const result = await sendBackground<{ opened: boolean; url: string }>({ type: "openApp", target })
    if (result && !result.opened && result.url) followLink(result.url)
  }, [])

  // ------------------------------------------------------------ FAB
  const fabEnabled = settings.fab === "on" || (settings.fab === "auto" && touch)
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
        <div
          class="cf-bubble"
          style={{
            top: `${Math.min(window.innerHeight - 52, bubble.rect.bottom + 8)}px`,
            left: `${Math.max(8, Math.min(window.innerWidth - 300, bubble.rect.left))}px`
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" class="primary" onClick={() => show(true)}><Icon.Sparkle size={14} /> {t("selAsk")}</button>
          <button type="button" onClick={() => { show(true); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[0]), 60) }}>{t("selExplain")}</button>
          <button type="button" onClick={() => { show(true); setTimeout(() => runActionRef.current(SELECTION_ACTIONS[2]), 60) }}>{t("selTranslate")}</button>
        </div>
      )}

      {open && layout === "sheet" && <div class={`cf-backdrop ${visible ? "in" : ""}`} onClick={hide} onTouchMove={(e) => e.preventDefault()} />}

      {open && (
        <section
          class={`cf-panel ${visible ? "in" : ""}`}
          role="dialog"
          aria-label="ContextFlow"
          style={layout === "sheet" && keyboard ? { bottom: `${keyboard}px`, maxHeight: `${window.visualViewport?.height ?? window.innerHeight}px` } : undefined}
        >
          {layout === "sheet" && <div class="cf-grabber" onClick={hide} />}
          <header class="cf-header">
            {view === "settings" ? (
              <button type="button" class="cf-icon" onClick={() => setView("chat")} aria-label={t("back")}><Icon.Back /></button>
            ) : (
              <span class="cf-logo"><Icon.Sparkle size={18} /></span>
            )}
            <div class="cf-title">
              {view === "settings" ? (
                <strong>{t("settings")}</strong>
              ) : (
                <ContextChip
                  kind={contextKind}
                  words={selection?.words ?? 0}
                  onClear={() => {
                    forgetSelection()
                    setSelection(null)
                  }}
                />
              )}
            </div>
            {view === "chat" && messages.length > 0 && (
              <button type="button" class="cf-icon" onClick={newChat} aria-label={t("newChat")} title={t("newChat")}><Icon.Plus /></button>
            )}
            {view === "chat" && (
              <button type="button" class="cf-icon" onClick={() => setView("settings")} aria-label={t("settings")} title={t("settings")}><Icon.Gear /></button>
            )}
            <button type="button" class="cf-icon" onClick={hide} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
          </header>

          {view === "settings" ? (
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
              onChatsDeleted={() => {
                setMessages([])
                setError(null)
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
                    <div class="cf-msg user" key={idx}><div class="cf-bubble-user">{m.label ?? m.content}</div></div>
                  ) : (
                    <div class="cf-msg ai" key={idx}>
                      <Markdown text={m.content} onCopyCode={(code) => void copyText(code)} />
                      <div class="cf-msg-tools">
                        <button type="button" onClick={async () => { if (await copyText(toPlainText(m.content))) { setCopied(idx); setTimeout(() => setCopied(null), 1500) } }}>
                          {copied === idx ? <Icon.Check /> : <Icon.Copy />} {copied === idx ? t("copied") : t("copy")}
                        </button>
                        {typeof navigator.share === "function" && (
                          <button type="button" onClick={() => void navigator.share({ text: `${toPlainText(m.content)}\n\n— ${location.href}` }).catch(() => undefined)}>
                            <Icon.Share /> {t("share")}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                )}

                {partial !== null && (
                  <div class="cf-msg ai">
                    {partial ? <Markdown text={partial} /> : <div class="cf-thinking"><span /><span /><span /> {t("thinking")}</div>}
                  </div>
                )}

                {messages.length > 0 && partial === null && !error && actions.length > 0 && lastIsUser === false && messages.length < 3 && (
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
                    {lastIsUser && <button type="button" class="cf-secondary" onClick={retry}><Icon.Retry /> {t("retry")}</button>}
                    {error.code === "BAD_KEY" && <button type="button" class="cf-secondary" onClick={() => setView("settings")}>{t("settings")}</button>}
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
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={draft}
                    placeholder={t(contextKind === "selection" ? "placeholderSelection" : contextKind === "page" ? "placeholderPage" : "placeholderNone")}
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
                        ask(draft)
                      }
                      e.stopPropagation()
                    }}
                    onKeyUp={(e) => e.stopPropagation()}
                    onKeyPress={(e) => e.stopPropagation()}
                  />
                  {streaming ? (
                    <button type="button" class="cf-send stop" onClick={stop} aria-label={t("stop")} title={t("stop")}><Icon.Stop /></button>
                  ) : (
                    <button type="button" class="cf-send" disabled={!draft.trim()} onClick={() => ask(draft)} aria-label={t("send")} title={t("send")}><Icon.ArrowUp /></button>
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
        </section>
      )}
    </div>
  )
}

const runActionRef: { current: (a: Action) => void } = { current: () => undefined }

function ContextChip({ kind, words, onClear }: { kind: "selection" | "page" | "none"; words: number; onClear: () => void }): VNode {
  if (kind === "selection") {
    return (
      <span class="cf-ctx selection">
        <Icon.Cursor /> <span class="cf-ctx-text">{t("ctxSelection", words)}</span>
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
