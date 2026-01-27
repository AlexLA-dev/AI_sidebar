import { useState } from "react"
import { Sparkles, Key, Zap, Check, Crown } from "lucide-react"
import { motion } from "framer-motion"

import { cn } from "~/lib/utils"
import { storage, STORAGE_KEYS, getNextPeriodEnd, type UserMode } from "~/lib/storage"

type OnboardingModalProps = {
  onComplete: (mode: UserMode, apiKey?: string) => void
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [selectedMode, setSelectedMode] = useState<"subscription" | "byok" | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubscriptionSelect = async () => {
    setIsLoading(true)
    setError(null)

    try {
      // Initialize subscription state
      await storage.set(STORAGE_KEYS.USER_MODE, "subscription")
      await storage.set(STORAGE_KEYS.SUBSCRIPTION_ACTIVE, true)
      await storage.set(STORAGE_KEYS.USAGE_COUNTER, 0)
      await storage.set(STORAGE_KEYS.USAGE_PERIOD_END, getNextPeriodEnd())

      onComplete("subscription")
    } catch (e) {
      setError("Failed to initialize subscription")
    } finally {
      setIsLoading(false)
    }
  }

  const handleByokSelect = async () => {
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
      await storage.set(STORAGE_KEYS.USER_MODE, "byok")
      await storage.set(STORAGE_KEYS.OPENAI_API_KEY, apiKey.trim())

      onComplete("byok", apiKey.trim())
    } catch (e) {
      setError("Failed to save API key")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-full mb-4">
            <Sparkles className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">
            Welcome to ContextFlow
          </h1>
          <p className="text-purple-100 text-sm">
            Choose how you want to power your AI assistant
          </p>
        </div>

        {/* Options */}
        <div className="p-6 space-y-4">
          {/* Subscription Option */}
          <button
            onClick={() => setSelectedMode("subscription")}
            className={cn(
              "w-full p-4 rounded-xl border-2 transition-all text-left",
              selectedMode === "subscription"
                ? "border-purple-500 bg-purple-50 dark:bg-purple-900/20"
                : "border-gray-200 dark:border-gray-700 hover:border-purple-300"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "p-2 rounded-lg",
                selectedMode === "subscription"
                  ? "bg-purple-500 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500"
              )}>
                <Crown className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    Pro Subscription
                  </h3>
                  <span className="text-purple-600 font-bold">$6.99/mo</span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-gray-500 dark:text-gray-400">
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    No API key needed
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    150 Smart Requests / week
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    Simple & hassle-free
                  </li>
                </ul>
              </div>
            </div>
          </button>

          {/* BYOK Option */}
          <button
            onClick={() => setSelectedMode("byok")}
            className={cn(
              "w-full p-4 rounded-xl border-2 transition-all text-left",
              selectedMode === "byok"
                ? "border-purple-500 bg-purple-50 dark:bg-purple-900/20"
                : "border-gray-200 dark:border-gray-700 hover:border-purple-300"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "p-2 rounded-lg",
                selectedMode === "byok"
                  ? "bg-purple-500 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500"
              )}>
                <Key className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    Power User (BYOK)
                  </h3>
                  <span className="text-gray-500 text-sm">Pay OpenAI</span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-gray-500 dark:text-gray-400">
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    Bring Your Own Key
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    Unlimited usage
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    Full control over costs
                  </li>
                </ul>
              </div>
            </div>
          </button>

          {/* API Key Input (for BYOK) */}
          {selectedMode === "byok" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="space-y-2"
            >
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                OpenAI API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className={cn(
                  "w-full px-3 py-2 text-sm font-mono rounded-lg",
                  "border border-gray-200 dark:border-gray-700",
                  "bg-white dark:bg-gray-800",
                  "focus:outline-none focus:ring-2 focus:ring-purple-500"
                )}
              />
              <p className="text-xs text-gray-400">
                Get your key from{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-500 hover:underline"
                >
                  platform.openai.com
                </a>
              </p>
            </motion.div>
          )}

          {/* Subscription Note */}
          {selectedMode === "subscription" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg"
            >
              <p className="text-xs text-amber-700 dark:text-amber-300">
                <strong>Note:</strong> For this MVP, subscription mode still requires an API key
                for the actual API calls (backend proxy coming soon). The usage limits will be enforced.
              </p>
            </motion.div>
          )}

          {/* Error Message */}
          {error && (
            <p className="text-sm text-red-500 text-center">{error}</p>
          )}

          {/* Action Button */}
          <button
            onClick={selectedMode === "subscription" ? handleSubscriptionSelect : handleByokSelect}
            disabled={!selectedMode || isLoading || (selectedMode === "byok" && !apiKey.trim())}
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
                {selectedMode === "subscription" ? "Start Subscription" : "Save & Continue"}
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
