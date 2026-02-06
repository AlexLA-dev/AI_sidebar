import { useState, useEffect } from "react"
import { Sparkles, ExternalLink } from "lucide-react"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseClient } from "~/lib/supabase"
import { Auth } from "~/components/auth"

import "./style.css"

// Popup for Safari (and Chrome fallback)
// Shows auth or "Open in Tab" button

function Popup() {
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data: { session: currentSession } } = await supabase.auth.getSession()
        setSession(currentSession)

        supabase.auth.onAuthStateChange((_event, newSession) => {
          setSession(newSession)
        })
      } catch {
        setSession(null)
      }
      setIsLoading(false)
    }

    checkAuth()
  }, [])

  const openInTab = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html")
    })
    window.close()
  }

  if (isLoading) {
    return (
      <div className="w-[360px] h-[480px] flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
      </div>
    )
  }

  // Not authenticated - show login
  if (!session) {
    return (
      <div className="w-[360px] h-[480px] bg-white overflow-auto">
        <Auth onComplete={() => openInTab()} />
      </div>
    )
  }

  // Authenticated - show open button
  return (
    <div className="w-[360px] p-6 bg-white">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
          <Sparkles className="w-8 h-8 text-white" />
        </div>

        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          ContextFlow
        </h1>

        <p className="text-sm text-gray-500 mb-6">
          AI assistant ready to help with this page
        </p>

        <button
          onClick={openInTab}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-medium transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Open ContextFlow
        </button>

        <p className="mt-4 text-xs text-gray-400">
          Signed in as {session.user.email}
        </p>
      </div>
    </div>
  )
}

export default Popup
