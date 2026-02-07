import type { PlasmoCSConfig } from "plasmo"
import { useState, useEffect, useCallback, useRef } from "react"
import { createRoot } from "react-dom/client"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseClient } from "~/lib/supabase"
import { streamChatResponse, syncSubscriptionFromServer, type TrialInfo } from "~/lib/ai"

export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  exclude_matches: [
    "https://chrome.google.com/*",
    "https://chromewebstore.google.com/*",
    "*://localhost/*"
  ],
  all_frames: false,
  // Don't use Plasmo's default injection - we'll handle it manually
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

// Styles as objects for inline styling (Safari compatibility)
const styles = {
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
  fabHidden: {
    transform: "scale(0)",
    opacity: 0,
    pointerEvents: "none" as const,
  },
  backdrop: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0, 0, 0, 0.3)",
    zIndex: 2147483645,
  },
  panel: {
    position: "fixed" as const,
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    maxWidth: "100vw",
    height: "55vh",
    maxHeight: "500px",
    minHeight: "350px",
    background: "white",
    borderRadius: "20px 20px 0 0",
    boxShadow: "0 -10px 40px rgba(0, 0, 0, 0.15)",
    zIndex: 2147483647,
    display: "flex",
    flexDirection: "column" as const,
    transform: "translateY(100%)",
    transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    WebkitOverflowScrolling: "touch" as const,
    overflow: "hidden",
    boxSizing: "border-box" as const,
  },
  panelOpen: {
    transform: "translateY(0)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #e5e7eb",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  logo: {
    color: "#7c3aed",
  },
  title: {
    fontWeight: 600,
    fontSize: "16px",
    color: "#1f2937",
  },
  iconBtn: {
    width: "36px",
    height: "36px",
    border: "none",
    background: "transparent",
    borderRadius: "8px",
    color: "#6b7280",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  authPrompt: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "40px",
    textAlign: "center" as const,
  },
  authIcon: {
    color: "#7c3aed",
    marginBottom: "16px",
  },
  authTitle: {
    fontSize: "20px",
    fontWeight: 600,
    color: "#1f2937",
    marginBottom: "8px",
  },
  authText: {
    fontSize: "14px",
    color: "#6b7280",
    marginBottom: "24px",
  },
  authBtn: {
    padding: "12px 32px",
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white",
    border: "none",
    borderRadius: "12px",
    fontSize: "15px",
    fontWeight: 500,
    cursor: "pointer",
  },
  messages: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "16px 20px",
  },
  empty: {
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    color: "#9ca3af",
    fontSize: "14px",
  },
  trialInfo: {
    marginTop: "8px",
    fontSize: "12px",
    color: "#7c3aed",
  },
  message: {
    marginBottom: "12px",
    display: "flex",
  },
  messageUser: {
    justifyContent: "flex-end",
  },
  messageContent: {
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: "16px",
    fontSize: "14px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  messageContentUser: {
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white",
    borderBottomRightRadius: "4px",
  },
  messageContentAssistant: {
    background: "#f3f4f6",
    color: "#1f2937",
    borderBottomLeftRadius: "4px",
  },
  error: {
    padding: "12px 16px",
    background: "#fef2f2",
    color: "#dc2626",
    borderRadius: "12px",
    fontSize: "13px",
    marginBottom: "12px",
  },
  inputArea: {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
    padding: "12px 20px 20px",
    borderTop: "1px solid #e5e7eb",
    background: "white",
  },
  input: {
    flex: 1,
    padding: "12px 16px",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    fontSize: "14px",
    fontFamily: "inherit",
    resize: "none" as const,
    outline: "none",
    maxHeight: "120px",
    minHeight: "44px",
  },
  sendBtn: {
    width: "44px",
    height: "44px",
    border: "none",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
    color: "white",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
}

// Simple SVG icons (no external dependencies)
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

interface Message {
  role: "user" | "assistant"
  content: string
}

function FloatingPanelContent() {
  const [isOpen, setIsOpen] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [pageContext, setPageContext] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [trialInfo, setTrialInfo] = useState<TrialInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  // Initialize auth
  useEffect(() => {
    const init = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data: { session: s } } = await supabase.auth.getSession()
        setSession(s)

        if (s) {
          const info = await syncSubscriptionFromServer()
          setTrialInfo(info)
        }

        supabase.auth.onAuthStateChange((_event, newSession) => {
          setSession(newSession)
          if (newSession) {
            syncSubscriptionFromServer().then(setTrialInfo)
          }
        })
      } catch {
        setSession(null)
      }
      setIsLoading(false)
    }
    init()
  }, [])

  // Fetch page context when panel opens
  const fetchContext = useCallback(() => {
    const title = document.title
    const bodyText = document.body?.innerText?.slice(0, 15000) || ""
    setPageTitle(title)
    setPageContext(bodyText)
  }, [])

  useEffect(() => {
    if (isOpen && !pageContext) {
      fetchContext()
    }
  }, [isOpen, pageContext, fetchContext])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [isOpen])

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return

    const userMessage = input.trim()
    setInput("")
    setError(null)
    setMessages(prev => [...prev, { role: "user", content: userMessage }])
    setIsStreaming(true)

    let assistantMessage = ""
    setMessages(prev => [...prev, { role: "assistant", content: "" }])

    try {
      // streamChatResponse(messages, pageContext, apiKey, callbacks, contextType)
      await streamChatResponse(
        [...messages, { role: "user", content: userMessage }],
        pageContext,  // pageContext (2nd arg)
        "",           // apiKey - empty to use proxy (3rd arg)
        {             // callbacks (4th arg)
          onChunk: (chunk) => {
            assistantMessage += chunk
            setMessages(prev => {
              const newMessages = [...prev]
              newMessages[newMessages.length - 1] = {
                role: "assistant",
                content: assistantMessage
              }
              return newMessages
            })
          },
          onComplete: () => {
            setIsStreaming(false)
            syncSubscriptionFromServer().then(setTrialInfo)
          },
          onError: (err) => {
            setIsStreaming(false)
            setError(err.message)
            setMessages(prev => prev.slice(0, -1))
          }
        },
        "page"        // contextType (5th arg)
      )
    } catch (err) {
      setIsStreaming(false)
      setError(err instanceof Error ? err.message : "Failed to send message")
      setMessages(prev => prev.slice(0, -1))
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const openAuth = () => {
    chrome.runtime.sendMessage({ action: "openAuth" })
  }

  if (isLoading) return null

  return (
    <>
      {/* Floating Action Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          ...styles.fab,
          ...(isOpen ? styles.fabHidden : {}),
        }}
      >
        <SparklesIcon size={24} />
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          style={styles.backdrop}
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Slide-up Panel */}
      <div style={{
        ...styles.panel,
        ...(isOpen ? styles.panelOpen : {}),
      }}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.logo}><SparklesIcon size={20} /></span>
            <span style={styles.title}>ContextFlow</span>
          </div>
          <button onClick={() => setIsOpen(false)} style={styles.iconBtn}>
            <ChevronDownIcon size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {!session ? (
            <div style={styles.authPrompt}>
              <div style={styles.authIcon}><SparklesIcon size={48} /></div>
              <div style={styles.authTitle}>Sign in to ContextFlow</div>
              <div style={styles.authText}>Get AI-powered answers about any webpage</div>
              <button onClick={openAuth} style={styles.authBtn}>
                Sign In
              </button>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div style={styles.messages}>
                {messages.length === 0 ? (
                  <div style={styles.empty}>
                    <p>Ask anything about this page</p>
                    {trialInfo && !trialInfo.hasLicense && (
                      <p style={styles.trialInfo}>
                        {trialInfo.remaining} free messages left
                      </p>
                    )}
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} style={{
                      ...styles.message,
                      ...(msg.role === "user" ? styles.messageUser : {}),
                    }}>
                      <div style={{
                        ...styles.messageContent,
                        ...(msg.role === "user" ? styles.messageContentUser : styles.messageContentAssistant),
                      }}>
                        {msg.content || "..."}
                      </div>
                    </div>
                  ))
                )}
                {error && <div style={styles.error}>{error}</div>}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div style={styles.inputArea}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about this page..."
                  style={styles.input}
                  rows={1}
                  disabled={isStreaming}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  style={{
                    ...styles.sendBtn,
                    opacity: !input.trim() || isStreaming ? 0.5 : 1,
                  }}
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
// Inject directly into document.body, not Shadow DOM
function initFloatingPanel() {
  if (!isSafari()) {
    console.log("[ContextFlow] Not Safari, skipping floating panel")
    return
  }

  console.log("[ContextFlow] Initializing floating panel for Safari")

  // Create container directly in body
  const container = document.createElement("div")
  container.id = "contextflow-floating-panel"
  container.style.cssText = "all: initial !important;"
  document.body.appendChild(container)

  // Render React component
  const root = createRoot(container)
  root.render(<FloatingPanelContent />)
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFloatingPanel)
} else {
  initFloatingPanel()
}

// Export empty component for Plasmo (we handle rendering manually)
export default function PlasmoOverlay() {
  return null
}
