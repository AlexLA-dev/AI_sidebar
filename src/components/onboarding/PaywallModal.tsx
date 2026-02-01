import { useState, useEffect, useRef } from "react"
import { Lock, Check, Zap, Key, Crown, Loader2 } from "lucide-react"
import { motion } from "framer-motion"

import { cn, getPaymentLink, type PlanId } from "~/lib/utils"
import { LICENSE_CONFIG, syncSubscriptionFromServer } from "~/lib/storage"

type PaywallModalProps = {
  onClose: () => void
  onSubscribed: () => void
}

export function PaywallModal({ onClose, onSubscribed }: PaywallModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("basic")
  const [isLoading, setIsLoading] = useState(false)
  const [isWaitingForPayment, setIsWaitingForPayment] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const handleSubscribe = async () => {
    setIsLoading(true)
    setError(null)

    const result = await getPaymentLink(selectedPlan)

    if (!result.success || !result.url) {
      setError(result.error || "Failed to get payment link")
      setIsLoading(false)
      return
    }

    // Open Stripe checkout in a new tab
    window.open(result.url, "_blank")
    setIsLoading(false)
    setIsWaitingForPayment(true)

    // Start polling Supabase for subscription activation
    pollRef.current = setInterval(async () => {
      try {
        const info = await syncSubscriptionFromServer()
        if (info.hasLicense) {
          // Payment confirmed! Stop polling and close modal
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          onSubscribed()
        }
      } catch {
        // Ignore polling errors — keep trying
      }
    }, 3000) // Poll every 3 seconds
  }

  const plans = [
    {
      id: "basic" as PlanId,
      icon: Key,
      label: LICENSE_CONFIG.BASIC.label,
      price: LICENSE_CONFIG.BASIC.price,
      description: LICENSE_CONFIG.BASIC.description,
      features: [
        "Unlimited interface access",
        "Bring your own OpenAI key",
        "Full control over costs"
      ]
    },
    {
      id: "pro" as PlanId,
      icon: Crown,
      label: LICENSE_CONFIG.PRO.label,
      price: LICENSE_CONFIG.PRO.price,
      description: LICENSE_CONFIG.PRO.description,
      badge: "Best value",
      features: [
        "Everything in Basic",
        "No API key needed",
        "We handle everything"
      ]
    }
  ]

  const activePlan = plans.find((p) => p.id === selectedPlan)!

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 text-center relative">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-white/70 hover:text-white p-1"
          >
            <span className="sr-only">Close</span>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="inline-flex items-center justify-center w-12 h-12 bg-white/20 rounded-full mb-2">
            <Lock className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-lg font-bold text-white mb-1">
            Unlock ContextFlow Pro
          </h1>
          <p className="text-purple-100 text-xs">
            You have used all {LICENSE_CONFIG.TRIAL_LIMIT} free test requests.
          </p>
        </div>

        {/* Waiting for payment state */}
        {isWaitingForPayment ? (
          <div className="p-6 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin text-purple-500 mx-auto" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Waiting for payment confirmation...
            </p>
            <p className="text-xs text-gray-400">
              Complete the payment in the opened tab. This window will close automatically.
            </p>
            <button
              onClick={onClose}
              className="text-xs text-gray-400 hover:text-gray-600 underline mt-2"
            >
              Close and check later
            </button>
          </div>
        ) : (
          /* Plans */
          <div className="p-4 space-y-3">
            {plans.map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlan(plan.id)}
                className={cn(
                  "w-full p-3 rounded-xl border-2 transition-all text-left relative",
                  selectedPlan === plan.id
                    ? "border-purple-500 bg-purple-50 dark:bg-purple-900/20"
                    : "border-gray-200 dark:border-gray-700 hover:border-purple-300"
                )}
              >
                {plan.badge && (
                  <span className="absolute -top-2 right-3 bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded-full font-medium">
                    {plan.badge}
                  </span>
                )}
                <div className="flex items-start gap-3">
                  <div className={cn(
                    "p-1.5 rounded-lg mt-0.5",
                    selectedPlan === plan.id
                      ? "bg-purple-500 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500"
                  )}>
                    <plan.icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                        {plan.label}
                      </h3>
                      <span className="text-purple-600 dark:text-purple-400 font-bold text-sm">
                        ${plan.price}/mo
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {plan.description}
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {plan.features.map((feat) => (
                        <li key={feat} className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                          <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
                          {feat}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </button>
            ))}

            {/* Error */}
            {error && (
              <p className="text-xs text-red-500 text-center">{error}</p>
            )}

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
                  Subscribe (${activePlan.price}/mo)
                </>
              )}
            </button>

            <p className="text-[10px] text-gray-400 text-center">
              Cancel anytime. Secure payment via Stripe.
            </p>
          </div>
        )}
      </motion.div>
    </div>
  )
}
