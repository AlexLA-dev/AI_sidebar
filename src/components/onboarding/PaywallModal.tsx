import { useState, useEffect, useRef } from "react"
import { Lock, Check, Zap, Key, Crown, Loader2, RotateCcw } from "lucide-react"
import { motion } from "framer-motion"

import { cn, getPaymentLink, type PlanId } from "~/lib/utils"
import { LICENSE_CONFIG, syncSubscriptionFromServer } from "~/lib/storage"
import { getPaymentProvider, type PaymentProvider } from "~/lib/platform"
import {
  purchase as appStorePurchase,
  fetchProducts as fetchAppStoreProducts,
  restorePurchases,
  APPSTORE_PRODUCT_IDS,
  type AppStoreProduct
} from "~/lib/appstore"

type PaywallModalProps = {
  onClose: () => void
  onSubscribed: () => void
}

export function PaywallModal({ onClose, onSubscribed }: PaywallModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("basic")
  const [isLoading, setIsLoading] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isWaitingForPayment, setIsWaitingForPayment] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const paymentProvider: PaymentProvider = getPaymentProvider()

  // Localized App Store prices (fetched from StoreKit)
  const [appStorePrices, setAppStorePrices] = useState<Record<string, AppStoreProduct>>({})

  // Fetch App Store prices on mount (Safari only)
  useEffect(() => {
    if (paymentProvider === "appstore") {
      fetchAppStoreProducts()
        .then((products) => {
          const priceMap: Record<string, AppStoreProduct> = {}
          for (const product of products) {
            priceMap[product.id] = product
          }
          setAppStorePrices(priceMap)
        })
        .catch((err) => {
          console.warn("[PaywallModal] Failed to fetch App Store products:", err)
        })
    }
  }, [paymentProvider])

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // ── Stripe purchase flow (Chrome) ───────────────────────────────────────

  const handleStripeSubscribe = async () => {
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
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          onSubscribed()
        }
      } catch {
        // Ignore polling errors — keep trying
      }
    }, 3000)
  }

  // ── App Store purchase flow (Safari) ────────────────────────────────────

  const handleAppStoreSubscribe = async () => {
    setIsLoading(true)
    setError(null)

    const productId = selectedPlan === "pro"
      ? APPSTORE_PRODUCT_IDS.pro
      : APPSTORE_PRODUCT_IDS.basic

    try {
      const result = await appStorePurchase(productId)

      if (result.success) {
        // Transaction verified on server, sync subscription locally
        const info = await syncSubscriptionFromServer()
        if (info.hasLicense) {
          onSubscribed()
        } else {
          // Server may need a moment; poll briefly
          setIsWaitingForPayment(true)
          pollRef.current = setInterval(async () => {
            try {
              const syncedInfo = await syncSubscriptionFromServer()
              if (syncedInfo.hasLicense) {
                if (pollRef.current) clearInterval(pollRef.current)
                pollRef.current = null
                onSubscribed()
              }
            } catch { /* keep trying */ }
          }, 2000)
        }
      } else {
        setError(result.error || "Purchase failed")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Purchase failed"
      // User cancellation is not an error
      if (message.toLowerCase().includes("cancel")) {
        // Silently handle cancellation
      } else {
        setError(message)
      }
    } finally {
      setIsLoading(false)
    }
  }

  // ── Restore purchases (App Store only) ──────────────────────────────────

  const handleRestore = async () => {
    setIsRestoring(true)
    setError(null)

    try {
      const status = await restorePurchases()
      if (status.isSubscribed) {
        const info = await syncSubscriptionFromServer()
        if (info.hasLicense) {
          onSubscribed()
          return
        }
      }
      setError("No active subscription found to restore.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed")
    } finally {
      setIsRestoring(false)
    }
  }

  // ── Unified subscribe handler ───────────────────────────────────────────

  const handleSubscribe = () => {
    if (paymentProvider === "appstore") {
      return handleAppStoreSubscribe()
    }
    return handleStripeSubscribe()
  }

  // ── Plan data ───────────────────────────────────────────────────────────

  /** Get the display price — use localized App Store price if available. */
  const getDisplayPrice = (planId: PlanId): string => {
    if (paymentProvider === "appstore") {
      const appStoreId = planId === "pro"
        ? APPSTORE_PRODUCT_IDS.pro
        : APPSTORE_PRODUCT_IDS.basic
      const product = appStorePrices[appStoreId]
      if (product) {
        return product.displayPrice
      }
    }
    // Fallback to hardcoded USD price
    const config = planId === "pro" ? LICENSE_CONFIG.PRO : LICENSE_CONFIG.BASIC
    return `$${config.price}`
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
              {paymentProvider === "appstore"
                ? "Confirming your purchase..."
                : "Waiting for payment confirmation..."}
            </p>
            <p className="text-xs text-gray-400">
              {paymentProvider === "appstore"
                ? "Your subscription is being activated."
                : "Complete the payment in the opened tab. This window will close automatically."}
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
                        {getDisplayPrice(plan.id)}/mo
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
                  Subscribe ({getDisplayPrice(selectedPlan)}/mo)
                </>
              )}
            </button>

            {/* Restore Purchases (App Store only, required by Review Guideline 3.1.1) */}
            {paymentProvider === "appstore" && (
              <button
                onClick={handleRestore}
                disabled={isRestoring}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 hover:underline disabled:opacity-50"
              >
                {isRestoring ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Restore Purchases
              </button>
            )}

            <p className="text-[10px] text-gray-400 text-center">
              {paymentProvider === "appstore"
                ? "Cancel anytime in Settings > Subscriptions. Payment charged to your Apple ID."
                : "Cancel anytime. Secure payment via Stripe."}
            </p>
          </div>
        )}
      </motion.div>
    </div>
  )
}
