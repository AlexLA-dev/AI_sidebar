import cssText from "data-text:./floating-panel.css"
import type { PlasmoCSConfig, PlasmoGetStyle } from "plasmo"
import { useState, useEffect, useCallback, useRef } from "react"
import { Sparkles, X, Send, ChevronDown, RefreshCw } from "lucide-react"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseClient } from "~/lib/supabase"
import { streamChatResponse, getTrialInfo, syncSubscriptionFromServer, type TrialInfo } from "~/lib/ai"

export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  exclude_matches: [
    "https://chrome.google.com/*",
    "https://chromewebstore.google.com/*",
    "*://localhost/*"
  ],
  all_frames: false
}

export const getStyle: PlasmoGetStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

// Render at document end for better page load performance
export const getRootContainer = () => {
  const container = document.createElement("div")
  container.id = "contextflow-floating-root"
  document.body.appendChild(container)
  return container
}

interface Message {
  role: "user" | "assistant"
  content: string
}

function FloatingPanel() {
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
    // Get page text directly from DOM (we're in content script context)
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
      await streamChatResponse(
        [...messages, { role: "user", content: userMessage }],
        "", // no API key, use proxy
        pageContext,
        pageTitle || undefined,
        "page",
        {
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
            // Remove empty assistant message
            setMessages(prev => prev.slice(0, -1))
          }
        }
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
        className={`cf-fab ${isOpen ? "cf-fab-hidden" : ""}`}
        title="Open ContextFlow"
      >
        <Sparkles size={24} />
      </button>

      {/* Slide-up Panel */}
      <div className={`cf-panel ${isOpen ? "cf-panel-open" : ""}`}>
        {/* Header */}
        <div className="cf-header">
          <div className="cf-header-left">
            <Sparkles size={20} className="cf-logo" />
            <span className="cf-title">ContextFlow</span>
            {pageTitle && (
              <span className="cf-page-title" title={pageTitle}>
                {pageTitle.length > 30 ? pageTitle.slice(0, 30) + "..." : pageTitle}
              </span>
            )}
          </div>
          <div className="cf-header-actions">
            <button onClick={fetchContext} className="cf-icon-btn" title="Refresh context">
              <RefreshCw size={16} />
            </button>
            <button onClick={() => setIsOpen(false)} className="cf-icon-btn" title="Minimize">
              <ChevronDown size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="cf-content">
          {!session ? (
            <div className="cf-auth-prompt">
              <Sparkles size={48} className="cf-auth-icon" />
              <h3>Sign in to ContextFlow</h3>
              <p>Get AI-powered answers about any webpage</p>
              <button onClick={openAuth} className="cf-auth-btn">
                Sign In
              </button>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div className="cf-messages">
                {messages.length === 0 ? (
                  <div className="cf-empty">
                    <p>Ask anything about this page</p>
                    {trialInfo && !trialInfo.hasLicense && (
                      <p className="cf-trial-info">
                        {trialInfo.remaining} free messages left
                      </p>
                    )}
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`cf-message cf-message-${msg.role}`}>
                      <div className="cf-message-content">{msg.content || "..."}</div>
                    </div>
                  ))
                )}
                {error && <div className="cf-error">{error}</div>}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="cf-input-area">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about this page..."
                  className="cf-input"
                  rows={1}
                  disabled={isStreaming}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  className="cf-send-btn"
                >
                  <Send size={18} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Backdrop */}
      {isOpen && <div className="cf-backdrop" onClick={() => setIsOpen(false)} />}
    </>
  )
}

export default FloatingPanel
