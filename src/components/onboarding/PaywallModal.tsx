import { useState } from "react"
import { Lock, Sparkles, Key, Check, Zap } from "lucide-react"
import { motion } from "framer-motion"

import { cn } from "~/lib/utils"
import { setLicenseStatus, LICENSE_CONFIG } from "~/lib/storage"

type PaywallModalProps = {
  onClose: () => void
  onSubscribed: () => void
}

export function PaywallModal({ onClose, onSubscribed }: PaywallModalProps) {
  const [isLoading, setIsLoading] = useState(false)

  const handleSubscribe = async () => {
    setIsLoading(true)

    // Mock subscription - in real app this would open Stripe/Apple Pay
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await setLicenseStatus(true)

    setIsLoading(false)
    onSubscribed()
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-6 text-center relative">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-white/70 hover:text-white p-1"
          >
            <span className="sr-only">Close</span>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="inline-flex items-center justify-center w-14 h-14 bg-white/20 rounded-full mb-3">
            <Lock className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white mb-1">
            Unlock ContextFlow Pro
          </h1>
          <p className="text-purple-100 text-sm">
            Your free trial has ended
          </p>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Trial Status */}
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              You have used all {LICENSE_CONFIG.TRIAL_LIMIT} free test requests.
            </p>
          </div>

          {/* Value Props */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
              <span>Unlimited requests with your API key</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
              <span>BYOK - You control your costs</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
              <span>Works with any OpenAI-compatible API</span>
            </div>
          </div>

          {/* Price */}
          <div className="text-center py-2">
            <span className="text-3xl font-bold text-gray-900 dark:text-white">
              ${LICENSE_CONFIG.PRICE_MONTHLY}
            </span>
            <span className="text-gray-500 dark:text-gray-400">/month</span>
          </div>

          {/* Subscribe Button */}
          <button
            onClick={handleSubscribe}
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
                Subscribe for ${LICENSE_CONFIG.PRICE_MONTHLY}/mo
              </>
            )}
          </button>

          <p className="text-xs text-gray-400 text-center">
            Cancel anytime. Secure payment via Stripe.
          </p>
        </div>
      </motion.div>
    </div>
  )
}
