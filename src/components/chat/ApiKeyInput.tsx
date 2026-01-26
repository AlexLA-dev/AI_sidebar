import { useState } from "react"
import { Key, Eye, EyeOff, Check, X } from "lucide-react"

import { cn } from "~/lib/utils"

type ApiKeyInputProps = {
  apiKey: string
  onApiKeyChange: (key: string) => void
}

export function ApiKeyInput({ apiKey, onApiKeyChange }: ApiKeyInputProps) {
  const [isEditing, setIsEditing] = useState(!apiKey)
  const [inputValue, setInputValue] = useState(apiKey)
  const [showKey, setShowKey] = useState(false)

  const handleSave = () => {
    onApiKeyChange(inputValue.trim())
    setIsEditing(false)
  }

  const handleCancel = () => {
    setInputValue(apiKey)
    setIsEditing(false)
  }

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
    : ""

  if (!isEditing && apiKey) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
        <Key className="h-4 w-4 text-green-600 dark:text-green-400" />
        <span className="flex-1 text-xs text-green-700 dark:text-green-300 font-mono">
          {maskedKey}
        </span>
        <button
          onClick={() => setIsEditing(true)}
          className="text-xs text-green-600 dark:text-green-400 hover:underline"
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Key className="h-4 w-4 text-gray-400" />
        <span className="text-xs text-gray-600 dark:text-gray-400">
          OpenAI API Key
        </span>
      </div>
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
          onClick={handleSave}
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
            onClick={handleCancel}
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
  )
}
