import { useState, useEffect } from "react"
import { Sparkles } from "lucide-react"
import { motion } from "framer-motion"

import { getSupabaseClient } from "~/lib/supabase"
import { Auth } from "~/components/auth"

type OnboardingModalProps = {
  onComplete: (apiKey?: string) => void
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [checkingSession, setCheckingSession] = useState(true)

  // Check if already authenticated on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (session) {
          // Already signed in — skip onboarding entirely
          onComplete()
          return
        }
      } catch {
        // Supabase not configured — skip auth, start trial
        onComplete()
        return
      }
      setCheckingSession(false)
    }
    checkSession()
  }, [])

  const handleAuthSuccess = () => {
    // Auth done — proceed directly without API key step
    onComplete()
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
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 text-center shrink-0">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-white/20 rounded-full mb-2">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-lg font-bold text-white mb-1">
            Welcome to ContextFlow
          </h1>
          <p className="text-purple-100 text-xs">
            Sign in to get started
          </p>
        </div>

        {/* Content — scrollable */}
        <div className="p-5 overflow-y-auto">
          <Auth onAuthSuccess={handleAuthSuccess} />
        </div>
      </motion.div>
    </div>
  )
}
