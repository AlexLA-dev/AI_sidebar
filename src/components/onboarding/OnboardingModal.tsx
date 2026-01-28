import { useState } from "react"
import { Sparkles, Key, Zap, ExternalLink } from "lucide-react"
import { motion } from "framer-motion"

import { cn } from "~/lib/utils"
import { setStoredApiKey, LICENSE_CONFIG } from "~/lib/storage"

type OnboardingModalProps = {
  onComplete: (apiKey: string) => void
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [apiKey, setApiKey] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!apiKey.trim()) {
      setError("Please enter your API key")
      return
    }

    if (!apiKey.startsWith("sk-")) {
      setError("API key should start with 'sk-'")
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      await setStoredApiKey(apiKey.trim())
      onComplete(apiKey.trim())
    } catch (e) {
      setError("Failed to save API key")
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-6 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-white/20 rounded-full mb-3">
            <Sparkles className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white mb-1">
            Welcome to ContextFlow
          </h1>
          <p className="text-purple-100 text-sm">
            Your AI-powered page assistant
          </p>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Trial Banner */}
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
            <p className="text-sm text-green-700 dark:text-green-300 font-medium">
              Start with {LICENSE_CONFIG.TRIAL_LIMIT} free requests!
            </p>
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">
              Then from ${LICENSE_CONFIG.BASIC.price}/mo ({LICENSE_CONFIG.BASIC.label})
              or ${LICENSE_CONFIG.PRO.price}/mo ({LICENSE_CONFIG.PRO.label})
            </p>
          </div>

          {/* API Key Input */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              <Key className="h-4 w-4" />
              OpenAI API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="sk-..."
              className={cn(
                "w-full px-3 py-2.5 text-sm font-mono rounded-lg",
                "border border-gray-200 dark:border-gray-700",
                "bg-white dark:bg-gray-800",
                "focus:outline-none focus:ring-2 focus:ring-purple-500",
                error && "border-red-300 focus:ring-red-500"
              )}
            />
            <p className="text-xs text-gray-400">
              Get your key from{" "}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-500 hover:underline inline-flex items-center gap-0.5"
              >
                platform.openai.com
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-500 text-center">{error}</p>
          )}

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || !apiKey.trim()}
            className={cn(
              "w-full py-3 rounded-xl font-semibold transition-all",
              "bg-gradient-to-r from-purple-600 to-indigo-600 text-white",
              "hover:from-purple-700 hover:to-indigo-700",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center justify-center gap-2"
            )}
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <Zap className="h-4 w-4" />
                Get Started
              </>
            )}
          </button>

          {/* Privacy Note */}
          <p className="text-xs text-gray-400 text-center">
            Your API key is stored locally and never sent to our servers.
          </p>
        </div>
      </motion.div>
    </div>
  )
}
