import { useState, useEffect } from "react"
import { Sparkles, Key, Zap, ExternalLink, ArrowRight } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

import { cn } from "~/lib/utils"
import { setStoredApiKey, LICENSE_CONFIG } from "~/lib/storage"
import { getSupabaseClient } from "~/lib/supabase"
import { Auth } from "~/components/auth"

type OnboardingModalProps = {
  onComplete: (apiKey?: string) => void
}

type Step = "auth" | "apikey"

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>("auth")
  const [apiKey, setApiKey] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)

  // Check if already authenticated on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (session) {
          setStep("apikey")
        }
      } catch {
        // Supabase not configured, skip auth
        setStep("apikey")
      }
      setCheckingSession(false)
    }
    checkSession()
  }, [])

  const handleAuthSuccess = () => {
    setStep("apikey")
  }

  const handleApiKeySubmit = async () => {
    // API key is optional — users can skip and use trial
    if (apiKey.trim() && !apiKey.startsWith("sk-")) {
      setError("API key should start with 'sk-'")
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      if (apiKey.trim()) {
        await setStoredApiKey(apiKey.trim())
      }
      onComplete(apiKey.trim() || undefined)
    } catch (e) {
      setError("Failed to save settings")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSkipApiKey = () => {
    // Skip API key — user starts trial without their own key
    onComplete()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleApiKeySubmit()
    }
  }

  if (checkingSession) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div className="w-8 h-8 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-white/20 rounded-full mb-2">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-lg font-bold text-white mb-1">
            {step === "auth" ? "Welcome to ContextFlow" : "Set Up Your API Key"}
          </h1>
          <p className="text-purple-100 text-xs">
            {step === "auth"
              ? "Sign in to get started"
              : "Optional: bring your own OpenAI key for best results"}
          </p>
        </div>

        {/* Content */}
        <div className="p-5">
          <AnimatePresence mode="wait">
            {step === "auth" && (
              <motion.div
                key="auth"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <Auth onAuthSuccess={handleAuthSuccess} />
              </motion.div>
            )}

            {step === "apikey" && (
              <motion.div
                key="apikey"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                {/* Trial Banner */}
                <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
                  <p className="text-sm text-green-700 dark:text-green-300 font-medium">
                    You get {LICENSE_CONFIG.TRIAL_LIMIT} free requests!
                  </p>
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                    Then ${LICENSE_CONFIG.BASIC.price}/mo or ${LICENSE_CONFIG.PRO.price}/mo
                  </p>
                </div>

                {/* API Key Input */}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                    <Key className="h-4 w-4" />
                    OpenAI API Key
                    <span className="text-xs font-normal text-gray-400">(optional)</span>
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

                {/* Buttons */}
                <div className="space-y-2">
                  <button
                    onClick={handleApiKeySubmit}
                    disabled={isLoading}
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
                        {apiKey.trim() ? "Save Key & Start" : "Start Free Trial"}
                      </>
                    )}
                  </button>

                  {apiKey.trim() && (
                    <button
                      onClick={handleSkipApiKey}
                      className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center justify-center gap-1"
                    >
                      Skip for now
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <p className="text-xs text-gray-400 text-center">
                  Your API key is stored locally and never sent to our servers.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
