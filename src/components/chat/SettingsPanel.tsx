import { useState, useEffect } from "react"
import { Key, Crown, Eye, EyeOff, Check, X, RefreshCw } from "lucide-react"

import { cn } from "~/lib/utils"
import { type UsageInfo, getUsageInfo, getUserMode, setStoredApiKey } from "~/lib/ai"
import { type UserMode, SUBSCRIPTION_CONFIG } from "~/lib/storage"

type SettingsPanelProps = {
  apiKey: string
  onApiKeyChange: (key: string) => void
  onModeReset?: () => void
}

export function SettingsPanel({ apiKey, onApiKeyChange, onModeReset }: SettingsPanelProps) {
  const [userMode, setUserMode] = useState<UserMode>(null)
  const [usageInfo, setUsageInfo] = useState<UsageInfo | null>(null)
  const [isEditingKey, setIsEditingKey] = useState(false)
  const [inputValue, setInputValue] = useState(apiKey)
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    const mode = await getUserMode()
    setUserMode(mode)

    if (mode === "subscription") {
      const usage = await getUsageInfo()
      setUsageInfo(usage)
    }
  }

  const handleSaveKey = async () => {
    await setStoredApiKey(inputValue.trim())
    onApiKeyChange(inputValue.trim())
    setIsEditingKey(false)
  }

  const handleCancelEdit = () => {
    setInputValue(apiKey)
    setIsEditingKey(false)
  }

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
    : ""

  const usagePercentage = usageInfo
    ? (usageInfo.used / usageInfo.limit) * 100
    : 0

  const getUsageColor = () => {
    if (usagePercentage >= 90) return "bg-red-500"
    if (usagePercentage >= 75) return "bg-yellow-500"
    return "bg-green-500"
  }

  const formatResetDate = (isoDate: string | null) => {
    if (!isoDate) return "Unknown"
    return new Date(isoDate).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric"
    })
  }

  return (
    <div className="space-y-4">
      {/* Current Plan */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {userMode === "subscription" ? (
            <Crown className="h-4 w-4 text-purple-500" />
          ) : (
            <Key className="h-4 w-4 text-blue-500" />
          )}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {userMode === "subscription" ? "Pro Subscription" : "BYOK (Power User)"}
          </span>
        </div>
        {onModeReset && (
          <button
            onClick={onModeReset}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            Change plan
          </button>
        )}
      </div>

      {/* Usage Bar (Subscription only) */}
      {userMode === "subscription" && usageInfo && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500 dark:text-gray-400">Weekly Usage</span>
            <span className={cn(
              "font-medium",
              usagePercentage >= 90 ? "text-red-500" :
              usagePercentage >= 75 ? "text-yellow-500" : "text-gray-600 dark:text-gray-300"
            )}>
              {usageInfo.used} / {usageInfo.limit}
            </span>
          </div>

          <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={cn("h-full transition-all duration-300", getUsageColor())}
              style={{ width: `${Math.min(usagePercentage, 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Resets {formatResetDate(usageInfo.periodEnd)}</span>
            <button
              onClick={loadSettings}
              className="flex items-center gap-1 hover:text-gray-600"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>

          {usagePercentage >= 90 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-2 rounded">
              Running low on requests. Consider switching to BYOK for unlimited usage.
            </p>
          )}
        </div>
      )}

      {/* API Key Section */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2 mb-2">
          <Key className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-xs text-gray-500 dark:text-gray-400">
            OpenAI API Key
          </span>
        </div>

        {!isEditingKey && apiKey ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <span className="flex-1 text-xs text-green-700 dark:text-green-300 font-mono">
              {maskedKey}
            </span>
            <button
              onClick={() => setIsEditingKey(true)}
              className="text-xs text-green-600 dark:text-green-400 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="sk-..."
                  className={cn(
                    "w-full px-3 py-2 pr-8 text-xs font-mono rounded-lg",
                    "border border-gray-200 dark:border-gray-700",
                    "bg-white dark:bg-gray-800",
                    "focus:outline-none focus:ring-2 focus:ring-purple-500"
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <button
                onClick={handleSaveKey}
                disabled={!inputValue.trim()}
                className={cn(
                  "p-2 rounded-lg",
                  "bg-green-600 text-white hover:bg-green-700",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                <Check className="h-4 w-4" />
              </button>
              {apiKey && (
                <button
                  onClick={handleCancelEdit}
                  className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400">
              Stored locally. Never sent anywhere except OpenAI.
            </p>
          </div>
        )}
      </div>

      {/* Plan Info */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <p className="text-xs text-gray-400">
          {userMode === "subscription" ? (
            <>
              <strong>Pro Plan:</strong> ${SUBSCRIPTION_CONFIG.PRICE_MONTHLY}/month for {SUBSCRIPTION_CONFIG.WEEKLY_LIMIT} requests/week
            </>
          ) : (
            <>
              <strong>BYOK:</strong> Pay OpenAI directly for unlimited usage
            </>
          )}
        </p>
      </div>
    </div>
  )
}
