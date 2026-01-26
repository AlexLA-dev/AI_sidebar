import { useState } from "react"
import { FileText, Loader2, Sparkles, AlertCircle } from "lucide-react"
import { sendToContentScript } from "@plasmohq/messaging"

import { cn } from "~/lib/utils"
import type { RequestBody, ResponseBody } from "~/contents/text-reader"

import "./style.css"

type Status = "idle" | "loading" | "success" | "error"

function SidePanel() {
  const [status, setStatus] = useState<Status>("idle")
  const [pageData, setPageData] = useState<{
    text: string
    title: string
    url: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAnalyzePage = async () => {
    setStatus("loading")
    setError(null)

    try {
      const response = await sendToContentScript<RequestBody, ResponseBody>({
        name: "text-reader",
        body: { action: "getPageText" }
      })

      if (response?.success && response.text) {
        setPageData({
          text: response.text,
          title: response.title || "Untitled",
          url: response.url || ""
        })
        setStatus("success")
      } else {
        throw new Error(response?.error || "Failed to read page content")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not connect to page"
      setError(message)
      setStatus("error")
    }
  }

  return (
    <div className={cn("flex min-h-screen flex-col bg-white p-4 dark:bg-gray-900")}>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-gray-900 dark:text-white">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <h1 className="text-lg font-semibold">ContextFlow</h1>
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          AI-powered page analysis
        </p>
      </header>

      <div className="flex-1">
        <button
          onClick={handleAnalyzePage}
          disabled={status === "loading"}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3",
            "bg-purple-600 text-white font-medium",
            "hover:bg-purple-700 transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {status === "loading" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading page...
            </>
          ) : (
            <>
              <FileText className="h-4 w-4" />
              Analyze Page
            </>
          )}
        </button>

        {status === "error" && error && (
          <div className="mt-4 rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-800 dark:text-red-200">
                  Error
                </p>
                <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                  {error}
                </p>
              </div>
            </div>
          </div>
        )}

        {status === "success" && pageData && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Page Title
              </p>
              <p className="mt-1 text-sm text-gray-900 dark:text-white font-medium truncate">
                {pageData.title}
              </p>
            </div>

            <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Content Preview
              </p>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 line-clamp-6">
                {pageData.text.slice(0, 500)}
                {pageData.text.length > 500 && "..."}
              </p>
              <p className="mt-2 text-xs text-gray-400">
                {pageData.text.length.toLocaleString()} characters total
              </p>
            </div>
          </div>
        )}
      </div>

      <footer className="mt-6 pt-4 border-t border-gray-100 dark:border-gray-800">
        <p className="text-xs text-gray-400 text-center">
          Ready for LLM integration
        </p>
      </footer>
    </div>
  )
}

export default SidePanel
