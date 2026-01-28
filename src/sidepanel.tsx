import { useState, useEffect, useCallback } from "react"
import { Sparkles, RefreshCw, Settings, X, AlertTriangle } from "lucide-react"
import { cn, sendMessageToActiveTab } from "~/lib/utils"
import { getStoredApiKey, setStoredApiKey, getTrialInfo, type ContextType, type TrialInfo } from "~/lib/ai"
import { ChatInterface, SettingsPanel } from "~/components/chat"
import { OnboardingModal, PaywallModal } from "~/components/onboarding"
import type { RequestBody, ResponseBody } from "~/contents/context-parser"

import "./style.css"

type ContextStatus = "idle" | "loading" | "success" | "error"

function SidePanel() {
  const [apiKey, setApiKey] = useState("")
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

  // Load API key and trial info from storage on mount
  useEffect(() => {
    const loadSettings = async () => {
      const storedKey = await getStoredApiKey()
      setApiKey(storedKey)

      const info = await getTrialInfo()
      setTrialInfo(info)

      setIsInitialized(true)
    }
    loadSettings()
  }, [])

  // Refresh trial info
  const refreshTrialInfo = useCallback(async () => {
    const info = await getTrialInfo()
    setTrialInfo(info)
  }, [])

  // Fetch page context
  const fetchPageContext = useCallback(async () => {
    setContextStatus("loading")
    setContextError(null)

    console.log("[ContextFlow] Fetching page context...")

    const result = await sendMessageToActiveTab<RequestBody, ResponseBody>({
      action: "getPageText"
    })

    console.log("[ContextFlow] Message result:", result)

    // Handle restricted pages (chrome://, etc.) - show idle state, not error
    if (result.isRestrictedPage) {
      console.log("[ContextFlow] Restricted page, showing idle state")
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
      console.error("[ContextFlow] Error:", result.error)
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
      console.log("[ContextFlow] Context loaded:", {
        title: response.title,
        type: response.contextType,
        textLength: response.text.length
      })
    } else {
      console.error("[ContextFlow] Invalid response:", response)
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

  const handleApiKeyChange = async (key: string) => {
    setApiKey(key)
    await setStoredApiKey(key)
    if (key) {
      setShowSettings(false)
    }
  }

  const handleOnboardingComplete = (key: string) => {
    setApiKey(key)
  }

  const handleLimitReached = () => {
    setShowPaywall(true)
  }

  const handleSubscribed = () => {
    setShowPaywall(false)
    refreshTrialInfo()
  }

  // Show loading state
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900">
        <div className="w-8 h-8 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
      </div>
    )
  }

  // Show onboarding if no API key
  if (!apiKey) {
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

      {/* Settings panel */}
      {showSettings && (
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <SettingsPanel
            apiKey={apiKey}
            onApiKeyChange={handleApiKeyChange}
            trialInfo={trialInfo}
            onShowPaywall={() => setShowPaywall(true)}
          />
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <ChatInterface
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
    </div>
  )
}

export default SidePanel
