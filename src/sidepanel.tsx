import { useState, useEffect, useCallback, useRef } from "react"
import { Sparkles, RefreshCw, Settings, X, AlertTriangle, MessageSquarePlus } from "lucide-react"
import type { Session } from "@supabase/supabase-js"

import { cn, sendMessageToActiveTab } from "~/lib/utils"
import { getStoredApiKey, setStoredApiKey, getTrialInfo, syncSubscriptionFromServer, type ContextType, type TrialInfo } from "~/lib/ai"
import { getSupabaseClient } from "~/lib/supabase"
import { syncUserInfo, getAppSettings } from "~/lib/appstore"
import { syncSubscriptionFromNative } from "~/lib/storage"
import { ChatInterface, SettingsPanel } from "~/components/chat"
import { OnboardingModal, PaywallModal } from "~/components/onboarding"
import type { RequestBody, ResponseBody } from "~/contents/context-parser"

import "./style.css"

type ContextStatus = "idle" | "loading" | "success" | "error"

function SidePanel() {
  const [apiKey, setApiKey] = useState("")
  const [session, setSession] = useState<Session | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPaywall, setShowPaywall] = useState(false)
  const [pageContext, setPageContext] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [contextType, setContextType] = useState<ContextType>("page")
  const [isReadabilityParsed, setIsReadabilityParsed] = useState(false)
  const [contextStatus, setContextStatus] = useState<ContextStatus>("idle")
  const [contextError, setContextError] = useState<string | null>(null)
  const [trialInfo, setTrialInfo] = useState<TrialInfo | null>(null)
  const [chatKey, setChatKey] = useState(0)

  // Track whether we've already set up listeners
  const listenersSetUp = useRef(false)

  // Check if opened with ?showPaywall=1 query param (from floating panel upgrade)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("showPaywall") === "1") {
      setShowPaywall(true)
    }
  }, [])

  // Apply dark/light theme based on native settings or system preference
  useEffect(() => {
    function applyTheme(mode: "dark" | "light" | "system") {
      if (mode === "dark") {
        document.documentElement.classList.add("dark")
      } else if (mode === "light") {
        document.documentElement.classList.remove("dark")
      } else {
        // System — follow OS preference
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
          document.documentElement.classList.add("dark")
        } else {
          document.documentElement.classList.remove("dark")
        }
      }
    }

    // Try native settings first (Safari), fall back to system preference
    let themeMode: "dark" | "light" | "system" = "system"

    getAppSettings()
      .then((settings) => {
        if (settings.theme === "dark" || settings.theme === "light") {
          themeMode = settings.theme
        }
        applyTheme(themeMode)
      })
      .catch(() => {
        // Native bridge not available (Chrome) — use system preference
        applyTheme("system")
      })

    // Listen for system preference changes (applies when theme is "system")
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if (themeMode === "system") {
        applyTheme("system")
      }
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  // Load settings and auth session on mount
  useEffect(() => {
    const loadSettings = async () => {
      // Load API key
      const storedKey = await getStoredApiKey()
      setApiKey(storedKey)

      // Check Supabase auth session
      try {
        const supabase = getSupabaseClient()
        const { data: { session: currentSession } } = await supabase.auth.getSession()
        setSession(currentSession)

        // If authenticated, sync subscription from Supabase (server is source of truth)
        if (currentSession) {
          const syncedInfo = await syncSubscriptionFromServer()
          setTrialInfo(syncedInfo)
        } else {
          const info = await getTrialInfo()
          setTrialInfo(info)
        }

        // Also sync from native App Store bridge (Safari).
        // Catches purchases made in the native app not yet in Supabase.
        try {
          const nativeInfo = await syncSubscriptionFromNative()
          if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) {
            setTrialInfo(nativeInfo)
          }
        } catch {
          // Not on Safari or bridge unavailable — ignore
        }

        // Sync user email and ID to native app on initial load
        if (currentSession?.user?.email) {
          syncUserInfo(currentSession.user.email, currentSession.user.id)
        }

        // Listen for auth state changes (sign in, sign out, token refresh)
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
          (_event, newSession) => {
            setSession(newSession)
            // Re-sync subscription when auth state changes
            if (newSession) {
              syncSubscriptionFromServer()
                .then(async (info) => {
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
              // Sync user email to native app shared storage
              if (newSession.user?.email) {
                syncUserInfo(newSession.user.email, newSession.user.id)
              }
            } else {
              syncUserInfo(null)
            }
          }
        )

        // Cleanup subscription on unmount
        return () => {
          subscription.unsubscribe()
        }
      } catch {
        // Supabase not configured — load local trial info
        const info = await getTrialInfo()
        setTrialInfo(info)
        setSession(null)
      }

      setIsInitialized(true)
    }

    loadSettings().then(() => {
      setIsInitialized(true)
    })
  }, [])

  // Refresh trial info (sync from server, then native fallback)
  const refreshTrialInfo = useCallback(async () => {
    let info: TrialInfo
    if (session) {
      info = await syncSubscriptionFromServer()
    } else {
      info = await getTrialInfo()
    }
    // Also check native bridge — subscription may not be in Supabase
    if (!info.hasLicense) {
      try {
        const nativeInfo = await syncSubscriptionFromNative()
        if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) { setTrialInfo(nativeInfo); return }
      } catch { /* ignore */ }
    }
    setTrialInfo(info)
  }, [session])

  // Fetch page context
  const fetchPageContext = useCallback(async () => {
    setContextStatus("loading")
    setContextError(null)

    const result = await sendMessageToActiveTab<RequestBody, ResponseBody>({
      action: "getPageText"
    })

    // Handle restricted pages (chrome://, etc.) - show idle state, not error
    if (result.isRestrictedPage) {
      setPageContext(null)
      setPageTitle(null)
      setContextType("page")
      setIsReadabilityParsed(false)
      setContextStatus("idle")
      setContextError(null)
      return
    }

    // Handle errors
    if (!result.success) {
      setPageContext(null)
      setPageTitle(null)
      setContextType("page")
      setIsReadabilityParsed(false)
      setContextStatus("error")
      setContextError(
        result.shouldRetry
          ? "Content script not ready. Please refresh the page."
          : result.error || "Failed to connect"
      )
      return
    }

    // Handle successful response
    const response = result.data
    if (response?.success && response.text) {
      setPageContext(response.text)
      setPageTitle(response.title || null)
      setContextType(response.contextType || "page")
      setIsReadabilityParsed(response.isReadabilityParsed || false)
      setContextStatus("success")
    } else {
      setPageContext(null)
      setPageTitle(null)
      setContextType("page")
      setIsReadabilityParsed(false)
      setContextStatus("error")
      setContextError(response?.error || "Empty response from content script")
    }
  }, [])

  // Auto-fetch context on mount
  useEffect(() => {
    fetchPageContext()
  }, [fetchPageContext])

  // Auto-refresh context on tab changes and navigation
  useEffect(() => {
    if (listenersSetUp.current) return
    listenersSetUp.current = true

    const handleTabActivated = (_activeInfo: chrome.tabs.TabActiveInfo) => {
      fetchPageContext()
    }

    const handleTabUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      _tab: chrome.tabs.Tab
    ) => {
      if (changeInfo.status === "complete") {
        setTimeout(() => fetchPageContext(), 800)
      }
    }

    const handleWindowFocusChanged = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        fetchPageContext()
      }
    }

    const handleMessage = (message: any) => {
      if (message?.action === "contextUpdate" && message.text) {
        const type = message.type === "selection" ? "selection" : "page"
        // Soft update — no loading spinner, just swap data
        setPageContext(message.text)
        setPageTitle(message.title || null)
        setContextType(type as ContextType)
        setIsReadabilityParsed(message.isReadabilityParsed || false)
        setContextStatus("success")
      }
    }

    try {
      chrome.tabs.onActivated.addListener(handleTabActivated)
      chrome.tabs.onUpdated.addListener(handleTabUpdated)
      chrome.windows.onFocusChanged.addListener(handleWindowFocusChanged)
      chrome.runtime.onMessage.addListener(handleMessage)
    } catch (err) {
      console.warn("[ContextFlow] Could not set up tab listeners:", err)
    }

    return () => {
      try {
        chrome.tabs.onActivated.removeListener(handleTabActivated)
        chrome.tabs.onUpdated.removeListener(handleTabUpdated)
        chrome.windows.onFocusChanged.removeListener(handleWindowFocusChanged)
        chrome.runtime.onMessage.removeListener(handleMessage)
      } catch {
        // Ignore cleanup errors
      }
    }
  }, [fetchPageContext])

  const handleApiKeyChange = async (key: string) => {
    setApiKey(key)
    await setStoredApiKey(key)
    if (key) {
      setShowSettings(false)
    }
  }

  const handleOnboardingComplete = (apiKey?: string) => {
    if (apiKey) {
      setApiKey(apiKey)
    }
    // Session will be picked up by onAuthStateChange
    refreshTrialInfo()

    // If this page was opened as a standalone auth tab (from floating panel's "Sign In"),
    // switch back to the original tab and close this one.
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab?.id) {
          // Switch back to the originating tab first, then close this auth tab
          chrome.storage.local.get("_authOriginTabId", (result) => {
            if (result._authOriginTabId) {
              chrome.tabs.update(result._authOriginTabId, { active: true })
              chrome.storage.local.remove("_authOriginTabId")
            }
            chrome.tabs.remove(tab.id!)
          })
        }
      })
    } catch {
      // Running in actual side panel or permissions not available
      try { window.close() } catch { /* ignore */ }
    }
  }

  const handleLimitReached = () => {
    setShowPaywall(true)
  }

  const handleSubscribed = async () => {
    setShowPaywall(false)
    // Sync from server to pick up the new subscription
    let info = await syncSubscriptionFromServer()
    if (!info.hasLicense) {
      try {
        const nativeInfo = await syncSubscriptionFromNative()
        if (nativeInfo.nativeConfirmed && nativeInfo.hasLicense) info = nativeInfo
      } catch { /* ignore */ }
    }
    setTrialInfo(info)

    // If opened as a standalone paywall tab (from floating panel), close it
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab?.id) {
          chrome.tabs.remove(tab.id)
        }
      })
    } catch {
      // Ignore — running in actual side panel
    }
  }

  const handleSignOut = async () => {
    try {
      const supabase = getSupabaseClient()
      await supabase.auth.signOut()
      // Session will be cleared by onAuthStateChange
      setApiKey("")
      setShowSettings(false)
      // Clear user info from native app shared storage
      syncUserInfo(null)
    } catch {
      // Sign out error — ignore
    }
  }

  // Show loading state
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900">
        <div className="w-8 h-8 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
      </div>
    )
  }

  // Show onboarding if not authenticated
  if (!session) {
    return <OnboardingModal onComplete={handleOnboardingComplete} />
  }

  return (
    <div className={cn("flex flex-col h-screen bg-white dark:bg-gray-900")}>
      {/* Paywall Modal */}
      {showPaywall && (
        <PaywallModal
          onClose={() => setShowPaywall(false)}
          onSubscribed={handleSubscribed}
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <h1 className="text-base font-semibold text-gray-900 dark:text-white">
            ContextFlow
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setChatKey(k => k + 1)}
            title="New Chat"
            className={cn(
              "p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100",
              "dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
            )}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <button
            onClick={fetchPageContext}
            disabled={contextStatus === "loading"}
            title="Refresh page context"
            className={cn(
              "p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100",
              "dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800",
              "disabled:opacity-50"
            )}
          >
            <RefreshCw className={cn("h-4 w-4", contextStatus === "loading" && "animate-spin")} />
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
            className={cn(
              "p-2 rounded-lg",
              showSettings
                ? "text-purple-600 bg-purple-50 dark:bg-purple-900/30"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
            )}
          >
            {showSettings ? <X className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {/* Context status indicator */}
      <div className={cn(
        "px-3 py-2 border-b text-xs",
        contextStatus === "error"
          ? "bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-800"
          : contextStatus === "success"
            ? "bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800"
            : "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-800"
      )}>
        {contextStatus === "loading" && (
          <p className="text-gray-500 dark:text-gray-400">Loading page context...</p>
        )}
        {contextStatus === "error" && (
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" />
            <span>{contextError || "Failed to load context"}</span>
          </div>
        )}
        {contextStatus === "success" && pageContext && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-purple-700 dark:text-purple-300 truncate flex-1">
              {contextType === "selection" ? "Selected text" : (pageTitle || "Current page")}
            </p>
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
              contextType === "selection"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                : isReadabilityParsed
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
            )}>
              {contextType === "selection" ? "Selection" : (isReadabilityParsed ? "Article" : "Raw")}
            </span>
          </div>
        )}
        {contextStatus === "idle" && (
          <p className="text-gray-400">No context loaded</p>
        )}
      </div>

      {/* Settings panel — replaces chat when open */}
      {showSettings ? (
        <div className="flex-1 overflow-y-auto px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
          <SettingsPanel
            apiKey={apiKey}
            onApiKeyChange={handleApiKeyChange}
            trialInfo={trialInfo}
            onShowPaywall={() => setShowPaywall(true)}
            userEmail={session?.user?.email}
            onSignOut={handleSignOut}
          />
        </div>
      ) : (
        <main className="flex-1 overflow-hidden">
          <ChatInterface
            key={chatKey}
            apiKey={apiKey}
            pageContext={pageContext}
            pageTitle={pageTitle}
            contextType={contextType}
            isReadabilityParsed={isReadabilityParsed}
            trialInfo={trialInfo}
            onTrialUpdate={refreshTrialInfo}
            onLimitReached={handleLimitReached}
          />
        </main>
      )}
    </div>
  )
}

export default SidePanel
