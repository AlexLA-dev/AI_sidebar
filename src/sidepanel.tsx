import { useState, useEffect, useCallback } from "react"
import { Sparkles, RefreshCw, Settings, X } from "lucide-react"
import { sendToContentScript } from "@plasmohq/messaging"

import { cn } from "~/lib/utils"
import { getStoredApiKey, setStoredApiKey } from "~/lib/ai"
import { ChatInterface, ApiKeyInput } from "~/components/chat"
import type { RequestBody, ResponseBody } from "~/contents/text-reader"

import "./style.css"

function SidePanel() {
  const [apiKey, setApiKey] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [pageContext, setPageContext] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [isReadabilityParsed, setIsReadabilityParsed] = useState(false)
  const [isLoadingContext, setIsLoadingContext] = useState(false)

  // Load API key from storage on mount
  useEffect(() => {
    const storedKey = getStoredApiKey()
    setApiKey(storedKey)
    if (!storedKey) {
      setShowSettings(true)
    }
  }, [])

  // Fetch page context
  const fetchPageContext = useCallback(async () => {
    setIsLoadingContext(true)
    try {
      const response = await sendToContentScript<RequestBody, ResponseBody>({
        name: "text-reader",
        body: { action: "getPageText" }
      })

      if (response?.success && response.text) {
        setPageContext(response.text)
        setPageTitle(response.title || null)
        setIsReadabilityParsed(response.isReadabilityParsed || false)
      }
    } catch {
      // Silently fail - user might be on a restricted page
      setPageContext(null)
      setPageTitle(null)
      setIsReadabilityParsed(false)
    } finally {
      setIsLoadingContext(false)
    }
  }, [])

  // Auto-fetch context on mount
  useEffect(() => {
    fetchPageContext()
  }, [fetchPageContext])

  const handleApiKeyChange = (key: string) => {
    setApiKey(key)
    setStoredApiKey(key)
    if (key) {
      setShowSettings(false)
    }
  }

  return (
    <div className={cn("flex flex-col h-screen bg-white dark:bg-gray-900")}>
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
            disabled={isLoadingContext}
            title="Refresh page context"
            className={cn(
              "p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100",
              "dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800",
              "disabled:opacity-50"
            )}
          >
            <RefreshCw className={cn("h-4 w-4", isLoadingContext && "animate-spin")} />
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

      {/* Settings panel */}
      {showSettings && (
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <ApiKeyInput apiKey={apiKey} onApiKeyChange={handleApiKeyChange} />
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {!apiKey ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <Settings className="h-10 w-10 text-gray-300 dark:text-gray-600 mb-3" />
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              Enter your OpenAI API key to get started
            </p>
            <button
              onClick={() => setShowSettings(true)}
              className="text-sm text-purple-600 hover:text-purple-700 font-medium"
            >
              Open Settings
            </button>
          </div>
        ) : (
          <ChatInterface
            apiKey={apiKey}
            pageContext={pageContext}
            pageTitle={pageTitle}
            isReadabilityParsed={isReadabilityParsed}
          />
        )}
      </main>
    </div>
  )
}

export default SidePanel
