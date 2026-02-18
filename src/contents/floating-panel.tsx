import type { PlasmoCSConfig } from "plasmo"
import { useState, useEffect, useCallback, useRef } from "react"
import { createRoot } from "react-dom/client"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseClient } from "~/lib/supabase"
import {
  streamChatResponse,
  syncSubscriptionFromServer,
  LimitReachedError,
  type TrialInfo
} from "~/lib/ai"
import { getStoredApiKey, setStoredApiKey, storage, LICENSE_CONFIG, syncSubscriptionFromNative } from "~/lib/storage"
import { syncUserInfo, openManageSubscriptions, getAppSettings } from "~/lib/appstore"

// --- Lightweight inline markdown renderer (no external deps) ---
function renderMarkdown(text: string, themeColors?: { codeBg: string; linkColor: string }): React.ReactNode[] {
  const codeBg = themeColors?.codeBg || "#e5e7eb"
  const linkColor = themeColors?.linkColor || "#7c3aed"
  const lines = text.split("\n")
  const result: React.ReactNode[] = []
  let listBuffer: { ordered: boolean; items: string[] } | null = null
  let keyIdx = 0

  function flushList() {
    if (!listBuffer) return
    const Tag = listBuffer.ordered ? "ol" : "ul"
    const listStyle: React.CSSProperties = {
      margin: "4px 0", paddingLeft: "20px",
      listStyleType: listBuffer.ordered ? "decimal" : "disc",
    }
    result.push(
      <Tag key={`list-${keyIdx++}`} style={listStyle}>
        {listBuffer.items.map((item, j) => (
          <li key={j} style={{ marginBottom: "2px" }}>{inlineFormat(item)}</li>
        ))}
      </Tag>
    )
    listBuffer = null
  }

  function inlineFormat(s: string): React.ReactNode {
    // Process inline: **bold**, *italic*, `code`, [link](url)
    const parts: React.ReactNode[] = []
    let remaining = s
    let k = 0
    const rx = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g
    let match: RegExpExecArray | null
    let lastIndex = 0
    rx.lastIndex = 0
    while ((match = rx.exec(remaining)) !== null) {
      if (match.index > lastIndex) {
        parts.push(remaining.slice(lastIndex, match.index))
      }
      if (match[2]) {
        parts.push(<strong key={`b${k++}`}>{match[2]}</strong>)
      } else if (match[3]) {
        parts.push(<em key={`i${k++}`}>{match[3]}</em>)
      } else if (match[4]) {
        parts.push(
          <code key={`c${k++}`} style={{
            background: codeBg, borderRadius: "3px",
            padding: "1px 4px", fontSize: "0.9em", fontFamily: "monospace",
          }}>{match[4]}</code>
        )
      } else if (match[5] && match[6]) {
        parts.push(
          <a key={`a${k++}`} href={match[6]} target="_blank" rel="noopener noreferrer"
            style={{ color: linkColor, textDecoration: "underline" }}>{match[5]}</a>
        )
      }
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < remaining.length) {
      parts.push(remaining.slice(lastIndex))
    }
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Ordered list: "1. item", "2. item" etc.
    const olMatch = line.match(/^\s*(\d+)\.\s+(.+)/)
    // Unordered list: "- item" or "* item" (but not bold **)
    const ulMatch = !olMatch && line.match(/^\s*[-*]\s+(.+)/)

    if (olMatch) {
      if (listBuffer && !listBuffer.ordered) flushList()
      if (!listBuffer) listBuffer = { ordered: true, items: [] }
      listBuffer.items.push(olMatch[2])
    } else if (ulMatch) {
      if (listBuffer && listBuffer.ordered) flushList()
      if (!listBuffer) listBuffer = { ordered: false, items: [] }
      listBuffer.items.push(ulMatch[1])
    } else {
      flushList()
      // Heading: ### text
      const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
      if (headingMatch) {
        const level = headingMatch[1].length
        const fontSize = level === 1 ? "1.2em" : level === 2 ? "1.1em" : "1em"
        result.push(
          <div key={`h-${keyIdx++}`} style={{ fontWeight: 700, fontSize, margin: "6px 0" }}>
            {inlineFormat(headingMatch[2])}
          </div>
        )
      } else if (line.trim() === "") {
        result.push(<div key={`br-${keyIdx++}`} style={{ height: "6px" }} />)
      } else {
        result.push(
          <div key={`p-${keyIdx++}`} style={{ margin: "2px 0" }}>
            {inlineFormat(line)}
          </div>
        )
      }
    }
  }
  flushList()
  return result
}

export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  exclude_matches: [
    "https://chrome.google.com/*",
    "https://chromewebstore.google.com/*",
    "*://localhost/*"
  ],
  all_frames: false,
  css: []
}

// Detect if running in Safari (no sidePanel API)
const isSafari = () => {
  try {
    if (typeof chrome !== "undefined" && typeof chrome.sidePanel === "undefined") {
      return true
    }
    if (navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome")) {
      return true
    }
    return false
  } catch {
    return true
  }
}

// --- Selection cache (iOS Safari clears selection when FAB is tapped) ---
let cachedSelectionText = ""

function trackSelection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const text = sel.toString().trim()
  if (text.length <= 10) return

  // Ignore selections inside our own floating panel
  const anchor = sel.anchorNode
  if (anchor) {
    const panel = document.getElementById("contextflow-floating-panel")
    if (panel && panel.contains(anchor)) return
  }

  cachedSelectionText = text
}

document.addEventListener("selectionchange", trackSelection)
document.addEventListener("mouseup", () => setTimeout(trackSelection, 50))

// --- Scroll lock helpers (prevents page jump on iOS Safari) ---
let savedScrollY = 0

function lockBodyScroll() {
  savedScrollY = window.scrollY
  document.body.style.position = "fixed"
  document.body.style.top = `-${savedScrollY}px`
  document.body.style.width = "100%"
  document.body.style.overflow = "hidden"
}

function unlockBodyScroll() {
  document.body.style.position = ""
  document.body.style.top = ""
  document.body.style.width = ""
  document.body.style.overflow = ""
  window.scrollTo(0, savedScrollY)
}

// --- SVG icons ---
const SparklesIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
    <path d="M5 19l1 3 1-3 3-1-3-1-1-3-1 3-3 1 3 1z"/>
  </svg>
)

const SendIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/>
    <polygon points="22,2 15,22 11,13 2,9"/>
  </svg>
)

const ChevronDownIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6,9 12,15 18,9"/>
  </svg>
)

const GearIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)

const XIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
)

const MoreIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
  </svg>
)

const LogOutIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
)

const NewChatIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    <line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/>
  </svg>
)

// --- Theme colors ---
function getThemeColors(dark: boolean) {
  return {
    bg: dark ? "#1f2937" : "white",
    textPrimary: dark ? "#f9fafb" : "#1f2937",
    textSecondary: dark ? "#9ca3af" : "#6b7280",
    textMuted: dark ? "#6b7280" : "#9ca3af",
    border: dark ? "#374151" : "#e5e7eb",
    iconBtnBg: dark ? "#374151" : "#f3f4f6",
    iconBtnColor: dark ? "#d1d5db" : "#374151",
    settingsBg: dark ? "#111827" : "#f9fafb",
    aiBubbleBg: dark ? "#374151" : "#f3f4f6",
    aiBubbleText: dark ? "#f3f4f6" : "#1f2937",
    inputBg: dark ? "#374151" : "white",
    inputBorder: dark ? "#4b5563" : "#e5e7eb",
    codeBg: dark ? "#4b5563" : "#e5e7eb",
    linkColor: dark ? "#a78bfa" : "#7c3aed",
    settingsValue: dark ? "#e5e7eb" : "#1f2937",
    green: dark ? "#86efac" : "#16a34a",
    panelShadow: dark ? "0 -10px 40px rgba(0, 0, 0, 0.4)" : "0 -10px 40px rgba(0, 0, 0, 0.15)",
  }
}

// --- Inline styles ---
const S = {
  fab: {
    position: "fixed" as const,
    bottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
    right: "calc(20px + env(safe-area-inset-right, 0px))",
    width: "56px",
    height: "56px",
    borderRadius: "28px",
    border: "none",
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 20px rgba(124, 58, 237, 0.4)",
    transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    zIndex: 2147483646,
    WebkitAppearance: "none" as const,
    WebkitTapHighlightColor: "transparent",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  fabHidden: { transform: "scale(0)", opacity: 0, pointerEvents: "none" as const },
  backdrop: {
    position: "fixed" as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0, 0, 0, 0.3)",
    zIndex: 2147483645,
    touchAction: "none" as const,
  },
  panel: {
    position: "fixed" as const,
    bottom: 0, left: 0, right: 0,
    width: "100%", maxWidth: "100vw",
    height: "55vh", maxHeight: "500px", minHeight: "350px",
    background: "white",
    borderRadius: "20px 20px 0 0",
    boxShadow: "0 -10px 40px rgba(0, 0, 0, 0.15)",
    zIndex: 2147483647,
    display: "flex", flexDirection: "column" as const,
    transform: "translateY(100%)",
    transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    WebkitOverflowScrolling: "touch" as const,
    overflow: "hidden", boxSizing: "border-box" as const,
    overscrollBehavior: "none" as const,
  },
  panelOpen: { transform: "translateY(0)" },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e5e7eb",
    flexShrink: 0, boxSizing: "border-box" as const,
    width: "100%",
  },
  headerLeft: {
    display: "flex", alignItems: "center", gap: "10px",
    minWidth: 0, flex: 1,
  },
  headerRight: {
    display: "flex", alignItems: "center", gap: "4px",
    flexShrink: 0, marginLeft: "auto",
  },
  logo: { color: "#7c3aed", flexShrink: 0 },
  title: { fontWeight: 600, fontSize: "16px", color: "#1f2937", flexShrink: 0 },
  badge: {
    fontSize: "14px", padding: "2px 10px", borderRadius: "12px",
    fontWeight: 500, whiteSpace: "nowrap" as const, flexShrink: 0, marginLeft: "6px",
  },
  badgeSel: { background: "#dbeafe", color: "#1d4ed8" },
  badgePage: { background: "#f3e8ff", color: "#7c3aed" },
  iconBtn: {
    width: "36px", height: "36px", minWidth: "36px", minHeight: "36px",
    border: "none", background: "#f3f4f6",
    borderRadius: "10px", color: "#374151",
    cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
    padding: "0", margin: "0",
    opacity: 1, visibility: "visible" as const,
    WebkitAppearance: "none" as const,
    boxSizing: "border-box" as const,
  },
  iconBtnActive: { background: "#f3e8ff", color: "#7c3aed" },
  content: {
    flex: 1, display: "flex", flexDirection: "column" as const,
    overflow: "hidden", width: "100%", boxSizing: "border-box" as const,
  },
  // --- Settings ---
  settingsBox: {
    padding: "14px 16px",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
    fontSize: "13px", color: "#374151",
    overflowY: "auto" as const,
    maxHeight: "260px",
  },
  settingsRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    marginBottom: "10px",
  },
  settingsLabel: { color: "#6b7280", fontSize: "12px" },
  settingsValue: { fontSize: "13px", fontWeight: 500, color: "#1f2937" },
  signOutBtn: {
    display: "inline-flex", alignItems: "center", gap: "4px",
    border: "none", background: "none",
    color: "#dc2626", fontSize: "12px", fontWeight: 500,
    cursor: "pointer", padding: "4px 0",
  },
  apiKeyRow: {
    display: "flex", gap: "8px", alignItems: "center", marginTop: "6px",
  },
  apiKeyInput: {
    flex: 1, padding: "8px 10px",
    border: "1px solid #e5e7eb", borderRadius: "8px",
    fontSize: "16px", fontFamily: "monospace",
    outline: "none", boxSizing: "border-box" as const,
    WebkitAppearance: "none" as const,
  },
  apiKeySaveBtn: {
    padding: "8px 14px", border: "none", borderRadius: "8px",
    background: "#7c3aed", color: "white", fontSize: "12px",
    fontWeight: 500, cursor: "pointer",
  },
  // --- Auth ---
  authPrompt: {
    flex: 1, display: "flex", flexDirection: "column" as const,
    alignItems: "center", justifyContent: "center",
    padding: "40px", textAlign: "center" as const,
  },
  authIcon: { color: "#7c3aed", marginBottom: "16px" },
  authTitle: { fontSize: "20px", fontWeight: 600, color: "#1f2937", marginBottom: "8px" },
  authText: { fontSize: "14px", color: "#6b7280", marginBottom: "24px" },
  authBtn: {
    padding: "12px 32px",
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white", border: "none", borderRadius: "12px",
    fontSize: "15px", fontWeight: 500, cursor: "pointer",
  },
  // --- Messages ---
  messages: {
    flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const,
    padding: "16px", width: "100%", boxSizing: "border-box" as const,
    overscrollBehavior: "contain" as const,
  },
  empty: {
    height: "100%", display: "flex", flexDirection: "column" as const,
    alignItems: "center", justifyContent: "center",
    color: "#9ca3af", fontSize: "14px",
  },
  trialInfo: { marginTop: "8px", fontSize: "12px", color: "#7c3aed" },
  msg: { marginBottom: "12px", display: "flex" },
  msgUser: { justifyContent: "flex-end" },
  msgBubble: {
    maxWidth: "85%", padding: "12px 14px", borderRadius: "16px",
    fontSize: "14px", lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
    boxSizing: "border-box" as const, overflow: "hidden",
  },
  msgBubbleUser: {
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white", borderBottomRightRadius: "4px",
  },
  msgBubbleAI: {
    background: "#f3f4f6", color: "#1f2937", borderBottomLeftRadius: "4px",
    whiteSpace: "normal" as const,
  },
  msgWrapper: {
    display: "flex", flexDirection: "column" as const, alignItems: "flex-start",
    maxWidth: "85%",
  },
  shareBtn: {
    border: "none", background: "none", padding: "4px 6px",
    color: "#9ca3af", cursor: "pointer",
    display: "inline-flex", alignItems: "center",
    borderRadius: "6px", marginTop: "2px",
  },
  error: {
    padding: "12px 16px", background: "#fef2f2", color: "#dc2626",
    borderRadius: "12px", fontSize: "13px", marginBottom: "12px",
  },
  inputArea: {
    display: "flex", alignItems: "flex-end", gap: "8px",
    padding: "12px 16px 20px",
    borderTop: "1px solid #e5e7eb", background: "white",
    boxSizing: "border-box" as const, width: "100%", overflow: "hidden",
  },
  input: {
    flex: 1, minWidth: 0, width: "100%",
    padding: "12px 14px",
    border: "1px solid #e5e7eb", borderRadius: "12px",
    fontSize: "16px", fontFamily: "inherit",
    resize: "none" as const, outline: "none",
    maxHeight: "120px", minHeight: "44px",
    boxSizing: "border-box" as const,
    WebkitAppearance: "none" as const,
  },
  sendBtn: {
    width: "44px", height: "44px", minWidth: "44px",
    border: "none", borderRadius: "12px",
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, boxSizing: "border-box" as const,
  },
}

interface Message { role: "user" | "assistant"; content: string }
type ContextInfo = { type: "page" | "selection"; title: string }

function FloatingPanelContent() {
  const [isOpen, setIsOpen] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [pageContext, setPageContext] = useState<string | null>(null)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [trialInfo, setTrialInfo] = useState<TrialInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [editingKey, setEditingKey] = useState(false)
  const [largeFont, setLargeFont] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [isDark, setIsDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Theme colors derived from isDark state
  const T = getThemeColors(isDark)

  // Lock/unlock body scroll when panel opens/closes
  useEffect(() => {
    if (isOpen) lockBodyScroll()
    else unlockBodyScroll()
    return () => unlockBodyScroll()
  }, [isOpen])

  // Detect theme from native settings or system preference
  useEffect(() => {
    let themeMode: "dark" | "light" | "system" = "system"

    function applyTheme(mode: "dark" | "light" | "system") {
      if (mode === "dark") setIsDark(true)
      else if (mode === "light") setIsDark(false)
      else setIsDark(window.matchMedia("(prefers-color-scheme: dark)").matches)
    }

    getAppSettings()
      .then((settings) => {
        if (settings.theme === "dark" || settings.theme === "light") {
          themeMode = settings.theme
        }
        applyTheme(themeMode)
      })
      .catch(() => applyTheme("system"))

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if (themeMode === "system") applyTheme("system")
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  // Listen for toggle message from background script
  useEffect(() => {
    const handleMessage = (message: { action: string }) => {
      if (message.action === "toggleFloatingPanel") {
        setIsOpen(prev => !prev)
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage)
    return () => chrome.runtime.onMessage.removeListener(handleMessage)
  }, [])

  // Initialize auth + load API key
  useEffect(() => {
    const init = async () => {
      try {
        const storedKey = await getStoredApiKey()
        setApiKey(storedKey)
        setApiKeyInput(storedKey)

        const storedFont = await storage.get<boolean>("cf_large_font")
        if (storedFont) setLargeFont(true)

        const supabase = getSupabaseClient()
        const { data: { session: s } } = await supabase.auth.getSession()
        setSession(s)

        if (s) {
          const info = await syncSubscriptionFromServer()
          setTrialInfo(info)
        }

        // Also sync from native App Store bridge (Safari).
        // This catches purchases made in the native app that
        // haven't been synced to Supabase yet.
        try {
          const nativeInfo = await syncSubscriptionFromNative()
          if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) {
            setTrialInfo(nativeInfo)
          }
        } catch {
          // Not on Safari or bridge unavailable — ignore
        }

        // Sync user email to native app on initial load
        if (s?.user?.email) {
          syncUserInfo(s.user.email)
        }

        supabase.auth.onAuthStateChange((_event, newSession) => {
          setSession(newSession)
          if (newSession) {
            syncSubscriptionFromServer()
              .then(async (info) => {
                // After server sync, also check native App Store bridge.
                // Native subscription may not be in Supabase yet.
                if (!info.hasLicense) {
                  try {
                    const nativeInfo = await syncSubscriptionFromNative()
                    if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) {
                      setTrialInfo(nativeInfo)
                      return
                    }
                  } catch { /* ignore */ }
                }
                setTrialInfo(info)
              })
            if (newSession.user?.email) syncUserInfo(newSession.user.email)
          } else {
            syncUserInfo(null)
          }
        })
      } catch {
        setSession(null)
      }
      setIsLoading(false)
    }
    init()
  }, [])

  // Fetch page context (or cached selection) when panel opens
  const fetchContext = useCallback(() => {
    const title = document.title
    // Check live selection first, then cached selection (but only from the page, not our panel)
    const sel = window.getSelection()
    let liveSel = ""
    if (sel && sel.rangeCount > 0) {
      const anchor = sel.anchorNode
      const panel = document.getElementById("contextflow-floating-panel")
      if (!panel || !panel.contains(anchor)) {
        liveSel = sel.toString().trim()
      }
    }
    const selText = liveSel.length > 10 ? liveSel : cachedSelectionText
    if (selText.length > 10) {
      setPageContext(selText)
      setContextInfo({ type: "selection", title })
      return
    }
    const bodyText = document.body?.innerText?.slice(0, 15000) || ""
    setPageContext(bodyText)
    setContextInfo({ type: "page", title })
  }, [])

  // Clear cached selection and revert to full page context
  const clearSelection = useCallback(() => {
    cachedSelectionText = ""
    window.getSelection()?.removeAllRanges()
    const bodyText = document.body?.innerText?.slice(0, 15000) || ""
    setPageContext(bodyText)
    setContextInfo({ type: "page", title: document.title })
  }, [])

  useEffect(() => {
    if (isOpen) fetchContext()
  }, [isOpen, fetchContext])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 300)
    }
  }, [isOpen])

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return
    const userMessage = text.trim()
    setInput("")
    setError(null)
    setMessages(prev => [...prev, { role: "user", content: userMessage }])
    setIsStreaming(true)
    let assistantMessage = ""
    setMessages(prev => [...prev, { role: "assistant", content: "" }])

    try {
      await streamChatResponse(
        [...messages, { role: "user", content: userMessage }],
        pageContext, apiKey,
        {
          onChunk: (chunk) => {
            assistantMessage += chunk
            setMessages(prev => {
              const n = [...prev]
              n[n.length - 1] = { role: "assistant", content: assistantMessage }
              return n
            })
          },
          onComplete: async () => {
            setIsStreaming(false)
            const info = await syncSubscriptionFromServer()
            if (!info.hasLicense) {
              try {
                const nativeInfo = await syncSubscriptionFromNative()
                if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) { setTrialInfo(nativeInfo); return }
              } catch { /* ignore */ }
            }
            setTrialInfo(info)
          },
          onError: (err) => {
            setIsStreaming(false)
            if (err instanceof LimitReachedError) {
              setLimitReached(true)
              setMessages(prev => prev.slice(0, -2)) // remove user msg + empty assistant msg
            } else {
              setError(err.message)
              setMessages(prev => prev.slice(0, -1))
            }
          }
        },
        contextInfo?.type || "page"
      )
    } catch (err) {
      setIsStreaming(false)
      setError(err instanceof Error ? err.message : "Failed to send message")
      setMessages(prev => prev.slice(0, -1))
    }
  }

  const handleSend = () => sendMessage(input)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleShare = async (text: string) => {
    const pageUrl = window.location.href
    const shareText = `${text}\n\n— Source: ${pageUrl}`

    if (navigator.share) {
      try {
        await navigator.share({ text: shareText })
      } catch {
        // User cancelled share sheet — ignore
      }
    } else {
      // Fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(shareText)
      } catch {
        // Clipboard API blocked — ignore
      }
    }
  }

  const handleUpgrade = () => {
    // Open the sidepanel page with paywall — StoreKit purchases require the native WKWebView context
    chrome.runtime.sendMessage({ action: "openPaywall" })
  }

  const openAuth = () => chrome.runtime.sendMessage({ action: "openAuth" })

  const handleSignOut = async () => {
    try {
      const supabase = getSupabaseClient()
      await supabase.auth.signOut()
      setSession(null)
      setShowSettings(false)
      syncUserInfo(null)
    } catch {
      // Sign out error — ignore
    }
  }

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim()
    await setStoredApiKey(trimmed)
    setApiKey(trimmed)
    setEditingKey(false)
  }

  const maskedKey = apiKey ? `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}` : ""
  const hasLicense = trialInfo?.hasLicense || false

  return (
    <>
      {/* FAB */}
      <button
        onClick={() => { if (!isLoading) setIsOpen(!isOpen) }}
        style={{ ...S.fab, ...(isOpen ? S.fabHidden : {}), ...(isLoading ? { opacity: 0.7 } : {}) }}
      >
        {isLoading ? (
          <div style={{
            width: "20px", height: "20px", border: "3px solid rgba(255,255,255,0.3)",
            borderTopColor: "white", borderRadius: "50%",
            animation: "cfSpin 0.8s linear infinite",
          }} />
        ) : (
          <SparklesIcon size={24} />
        )}
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          style={S.backdrop}
          onClick={() => setIsOpen(false)}
          onTouchMove={(e) => e.preventDefault()}
        />
      )}

      {/* Panel */}
      <div style={{ ...S.panel, ...(isOpen ? S.panelOpen : {}), background: T.bg, boxShadow: T.panelShadow }}>
        {/* Header */}
        <div style={{ ...S.header, borderBottomColor: T.border }}>
          <div style={S.headerLeft}>
            <span style={S.logo}><SparklesIcon size={20} /></span>
            <span style={{ ...S.title, color: T.textPrimary }}>ContextFlow</span>
            {contextInfo && (
              contextInfo.type === "selection" ? (
                <button
                  onClick={clearSelection}
                  style={{ ...S.badge, ...S.badgeSel, border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  Selection <span style={{ fontSize: "14px", lineHeight: 1 }}>&times;</span>
                </button>
              ) : (
                <span style={{ ...S.badge, ...S.badgePage }}>Page</span>
              )
            )}
          </div>
          <div style={S.headerRight}>
            {session && (
              <>
                <button
                  onClick={() => {
                    setMessages([])
                    setError(null)
                    setLimitReached(false)
                    fetchContext()
                  }}
                  title="New Chat"
                  style={{ ...S.iconBtn, background: T.iconBtnBg, color: T.iconBtnColor }}
                >
                  <NewChatIcon size={18} />
                </button>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  style={{ ...S.iconBtn, background: showSettings ? (isDark ? "#2e1065" : "#f3e8ff") : T.iconBtnBg, color: showSettings ? "#7c3aed" : T.iconBtnColor }}
                >
                  {showSettings ? <XIcon size={18} /> : <GearIcon size={18} />}
                </button>
              </>
            )}
            <button onClick={() => setIsOpen(false)} style={{ ...S.iconBtn, background: T.iconBtnBg, color: T.iconBtnColor }}>
              <ChevronDownIcon size={20} />
            </button>
          </div>
        </div>

        {/* Settings panel (collapsible) */}
        {showSettings && session && (
          <div style={{ ...S.settingsBox, background: T.settingsBg, borderBottomColor: T.border, color: T.textPrimary }}>
            {/* Email + Sign out */}
            <div style={S.settingsRow}>
              <div>
                <div style={{ ...S.settingsLabel, color: T.textSecondary }}>Account</div>
                <div style={{ ...S.settingsValue, color: T.settingsValue }}>{session.user?.email || "—"}</div>
              </div>
              <button onClick={handleSignOut} style={S.signOutBtn}>
                <LogOutIcon size={14} /> Sign Out
              </button>
            </div>

            {/* Plan */}
            <div style={{ ...S.settingsRow, marginBottom: "4px" }}>
              <div>
                <div style={{ ...S.settingsLabel, color: T.textSecondary }}>Plan</div>
                <div style={{ ...S.settingsValue, color: T.settingsValue }}>{hasLicense
                  ? (trialInfo?.planType === "byok_license" ? "BYOK License" : "Pro License")
                  : "Free Trial"}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {hasLicense && (
                  <button
                    onClick={() => openManageSubscriptions()}
                    style={{
                      padding: "3px 10px", border: `1px solid ${T.border}`, borderRadius: "8px",
                      background: T.bg, color: "#7c3aed", fontSize: "11px",
                      fontWeight: 500, cursor: "pointer",
                    }}
                  >
                    Manage
                  </button>
                )}
                {trialInfo && !hasLicense && (
                  <>
                    <span style={{ fontSize: "12px", color: "#7c3aed" }}>
                      {trialInfo.remaining}/{LICENSE_CONFIG.TRIAL_LIMIT} left
                    </span>
                    <button
                      onClick={handleUpgrade}
                      style={{
                        padding: "3px 10px", border: "none", borderRadius: "8px",
                        background: "#7c3aed", color: "white", fontSize: "11px",
                        fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      Upgrade
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Pro usage progress */}
            {trialInfo && hasLicense && trialInfo.planType === "pro_subscription" && trialInfo.proUsageCount != null && (
              <div style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#7c3aed", marginBottom: "4px" }}>
                  <span>Weekly requests</span>
                  <span>{trialInfo.proUsageCount} / {trialInfo.proWeeklyLimit || 375}</span>
                </div>
                <div style={{ height: "4px", background: "#e9d5ff", borderRadius: "2px", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", background: "#7c3aed", borderRadius: "2px",
                    width: `${(trialInfo.proUsageCount / (trialInfo.proWeeklyLimit || 375)) * 100}%`,
                    transition: "width 0.3s"
                  }} />
                </div>
                <div style={{ fontSize: "10px", color: "#9ca3af", marginTop: "2px" }}>Resets weekly</div>
              </div>
            )}

            {/* API Key */}
            <div style={{ ...S.settingsLabel, color: T.textSecondary }}>OpenAI API Key</div>
            {!editingKey && apiKey ? (
              <div style={{ ...S.apiKeyRow, marginTop: "4px" }}>
                <span style={{ fontFamily: "monospace", fontSize: "12px", color: T.green }}>
                  {maskedKey}
                </span>
                <button
                  onClick={() => { setEditingKey(true); setApiKeyInput(apiKey) }}
                  style={{ ...S.signOutBtn, color: "#7c3aed" }}
                >
                  Change
                </button>
                <button
                  onClick={async () => {
                    await setStoredApiKey("")
                    setApiKey("")
                    setApiKeyInput("")
                    setEditingKey(false)
                  }}
                  style={{ ...S.signOutBtn, color: "#dc2626" }}
                >
                  Clear
                </button>
              </div>
            ) : (
              <div style={S.apiKeyRow}>
                <input
                  type="text"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="sk-..."
                  style={{ ...S.apiKeyInput, background: T.inputBg, borderColor: T.inputBorder, color: T.textPrimary }}
                />
                <button
                  onClick={handleSaveApiKey}
                  disabled={!apiKeyInput.trim()}
                  style={{ ...S.apiKeySaveBtn, opacity: apiKeyInput.trim() ? 1 : 0.5 }}
                >
                  Save
                </button>
              </div>
            )}
            <div style={{ fontSize: "11px", color: T.textMuted, marginTop: "4px" }}>
              Stored locally. Never sent to our servers.
            </div>

            {/* Font size toggle */}
            <div style={{ ...S.settingsRow, marginTop: "14px", marginBottom: 0 }}>
              <div style={{ ...S.settingsLabel, color: T.textSecondary }}>Font Size</div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => { setLargeFont(false); storage.set("cf_large_font", false) }}
                  style={{
                    padding: "4px 12px", border: `1px solid ${T.border}`, borderRadius: "8px",
                    fontSize: "12px", cursor: "pointer",
                    background: !largeFont ? "#7c3aed" : T.bg,
                    color: !largeFont ? "white" : T.textPrimary,
                    fontWeight: 500,
                  }}
                >Normal</button>
                <button
                  onClick={() => { setLargeFont(true); storage.set("cf_large_font", true) }}
                  style={{
                    padding: "4px 12px", border: `1px solid ${T.border}`, borderRadius: "8px",
                    fontSize: "12px", cursor: "pointer",
                    background: largeFont ? "#7c3aed" : T.bg,
                    color: largeFont ? "white" : T.textPrimary,
                    fontWeight: 500,
                  }}
                >Large</button>
              </div>
            </div>

          </div>
        )}

        {/* Content */}
        <div style={S.content}>
          {!session ? (
            <div style={S.authPrompt}>
              <div style={S.authIcon}><SparklesIcon size={48} /></div>
              <div style={{ ...S.authTitle, color: T.textPrimary }}>Sign in to ContextFlow</div>
              <div style={{ ...S.authText, color: T.textSecondary }}>Get AI-powered answers about any webpage</div>
              <button onClick={openAuth} style={S.authBtn}>Sign In</button>
            </div>
          ) : (
            <>
              <div style={S.messages}>
                {messages.length === 0 ? (
                  <div style={{ ...S.empty, color: T.textMuted }}>
                    <p>Ask anything about this page</p>
                    {pageContext && (
                      <button
                        onClick={() => sendMessage("Summarize this page")}
                        disabled={isStreaming}
                        style={{
                          marginTop: "10px", padding: "6px 16px",
                          fontSize: "13px", borderRadius: "20px",
                          border: `1px solid ${isDark ? "#6d28d9" : "#e9d5ff"}`,
                          background: "transparent",
                          color: isDark ? "#a78bfa" : "#7c3aed",
                          cursor: isStreaming ? "not-allowed" : "pointer",
                          opacity: isStreaming ? 0.5 : 1,
                          fontFamily: "inherit",
                        }}
                      >
                        Summarize this page
                      </button>
                    )}
                    {trialInfo && !hasLicense && (
                      <p style={S.trialInfo}>{trialInfo.remaining} free messages left</p>
                    )}
                  </div>
                ) : (
                  messages.map((msg, i) => {
                    const fontScale = largeFont ? 1.5 : 1
                    const bubbleFontSize = `${14 * fontScale}px`
                    return (
                      <div key={i} style={{ ...S.msg, ...(msg.role === "user" ? S.msgUser : {}) }}>
                        {msg.role === "assistant" ? (
                          <div style={S.msgWrapper}>
                            <div style={{ ...S.msgBubble, ...S.msgBubbleAI, fontSize: bubbleFontSize, background: T.aiBubbleBg, color: T.aiBubbleText }}>
                              {msg.content ? renderMarkdown(msg.content, { codeBg: T.codeBg, linkColor: T.linkColor }) : (
                                <span style={{ display: "inline-flex", gap: "4px", alignItems: "center", letterSpacing: "2px", color: "#9ca3af" }}>
                                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#9ca3af", display: "inline-block" }} />
                                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#b4b8c0", display: "inline-block" }} />
                                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#d1d5db", display: "inline-block" }} />
                                </span>
                              )}
                            </div>
                            {msg.content && !isStreaming && (
                              <button
                                onClick={() => handleShare(msg.content)}
                                style={S.shareBtn}
                              >
                                <MoreIcon size={16} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <div style={{ ...S.msgBubble, ...S.msgBubbleUser, fontSize: bubbleFontSize }}>
                            {msg.content || "..."}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
                {limitReached && (
                  <div style={{
                    padding: "16px", background: "#faf5ff", borderRadius: "12px",
                    marginBottom: "12px", border: "1px solid #e9d5ff", textAlign: "center" as const,
                  }}>
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "#6b21a8", marginBottom: "6px" }}>
                      Free trial ended
                    </div>
                    <div style={{ fontSize: "12px", color: "#7e22ce", marginBottom: "12px" }}>
                      You've used all {LICENSE_CONFIG.TRIAL_LIMIT} free requests. Upgrade to continue.
                    </div>
                    <button
                      onClick={handleUpgrade}
                      style={{
                        padding: "10px 24px", border: "none", borderRadius: "10px",
                        background: "linear-gradient(135deg, #7c3aed, #a855f7)", color: "white",
                        fontSize: "13px", fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      View Plans
                    </button>
                  </div>
                )}
                {error && !limitReached && <div style={S.error}>{error}</div>}
                <div ref={messagesEndRef} />
              </div>

              <div style={{ ...S.inputArea, background: T.bg, borderTopColor: T.border }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about this page..."
                  style={{ ...S.input, background: T.inputBg, borderColor: T.inputBorder, color: T.textPrimary }}
                  rows={1}
                  disabled={isStreaming}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  style={{ ...S.sendBtn, opacity: !input.trim() || isStreaming ? 0.5 : 1 }}
                >
                  <SendIcon size={18} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// Manual initialization for Safari compatibility
function initFloatingPanel() {
  if (!isSafari()) return

  // Inject scoped CSS reset — only protect against common page CSS interference
  // IMPORTANT: Do NOT override position, transform, display, width, height —
  // those are set by our inline styles and must not be clobbered
  const style = document.createElement("style")
  style.textContent = `
    #contextflow-floating-panel,
    #contextflow-floating-panel * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: normal;
      letter-spacing: normal;
      text-transform: none;
      text-indent: 0;
      text-shadow: none;
      text-decoration: none;
      float: none;
    }
    #contextflow-floating-panel button {
      -webkit-appearance: none;
      appearance: none;
      text-align: center;
      outline: none;
    }
    #contextflow-floating-panel svg {
      vertical-align: middle;
    }
    #contextflow-floating-panel strong { font-weight: 700 !important; }
    #contextflow-floating-panel em { font-style: italic !important; }
    #contextflow-floating-panel ol { list-style-type: decimal !important; padding-left: 20px; }
    #contextflow-floating-panel ul { list-style-type: disc !important; padding-left: 20px; }
    #contextflow-floating-panel li { display: list-item !important; }
    #contextflow-floating-panel code { font-family: monospace !important; }
    @keyframes cfSpin { to { transform: rotate(360deg); } }
  `
  document.head.appendChild(style)

  const container = document.createElement("div")
  container.id = "contextflow-floating-panel"
  container.style.cssText = "all: initial !important;"
  document.body.appendChild(container)

  const root = createRoot(container)
  root.render(<FloatingPanelContent />)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFloatingPanel)
} else {
  initFloatingPanel()
}

export default function PlasmoOverlay() {
  return null
}
