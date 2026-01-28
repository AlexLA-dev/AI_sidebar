import { useState } from "react"
import { Key, Crown, Eye, EyeOff, Check, X, Sparkles } from "lucide-react"

import { cn } from "~/lib/utils"
import { setStoredApiKey, LICENSE_CONFIG, type TrialInfo } from "~/lib/storage"

type SettingsPanelProps = {
  apiKey: string
  onApiKeyChange: (key: string) => void
  trialInfo: TrialInfo | null
  onShowPaywall: () => void
}

export function SettingsPanel({
  apiKey,
  onApiKeyChange,
  trialInfo,
  onShowPaywall
}: SettingsPanelProps) {
  const [isEditingKey, setIsEditingKey] = useState(false)
  const [inputValue, setInputValue] = useState(apiKey)
  const [showKey, setShowKey] = useState(false)

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

  const hasLicense = trialInfo?.hasLicense || false

  return (
    <div className="space-y-4">
      {/* License Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {hasLicense ? (
            <Crown className="h-4 w-4 text-purple-500" />
          ) : (
            <Sparkles className="h-4 w-4 text-blue-500" />
          )}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {hasLicense ? "Pro License" : "Free Trial"}
          </span>
        </div>
        {!hasLicense && (
          <button
            onClick={onShowPaywall}
            className="text-xs text-purple-600 dark:text-purple-400 hover:underline font-medium"
          >
            Upgrade
          </button>
        )}
      </div>

      {/* Trial/License Info */}
      {trialInfo && (
        <div className={cn(
          "p-3 rounded-lg text-sm",
          hasLicense
            ? "bg-purple-50 dark:bg-purple-900/20"
            : "bg-blue-50 dark:bg-blue-900/20"
        )}>
          {hasLicense ? (
            <div className="flex items-center gap-2 text-purple-700 dark:text-purple-300">
              <Check className="h-4 w-4" />
              <span>Unlimited requests with your API key</span>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-blue-700 dark:text-blue-300">
                <span>Trial requests used</span>
                <span className="font-medium">
                  {trialInfo.usageCount} / {LICENSE_CONFIG.TRIAL_LIMIT}
                </span>
              </div>
              <div className="h-1.5 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{
                    width: `${(trialInfo.usageCount / LICENSE_CONFIG.TRIAL_LIMIT) * 100}%`
                  }}
                />
              </div>
            </div>
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
              Stored locally. Never sent to our servers.
            </p>
          </div>
        )}
      </div>

      {/* Pricing Info */}
      {!hasLicense && (
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs text-gray-400">
            <strong>Pro License:</strong> ${LICENSE_CONFIG.PRICE_MONTHLY}/month for unlimited BYOK usage
          </p>
        </div>
      )}
    </div>
  )
}
