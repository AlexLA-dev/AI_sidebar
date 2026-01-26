import { Sparkles } from "lucide-react"

import { cn } from "~/lib/utils"

import "./style.css"

function SidePanel() {
  return (
    <div className={cn("flex min-h-screen flex-col items-center justify-center bg-white p-4")}>
      <div className="flex items-center gap-2 text-gray-900">
        <Sparkles className="h-6 w-6 text-purple-600" />
        <h1 className="text-2xl font-semibold">Hello ContextFlow</h1>
      </div>
      <p className="mt-2 text-sm text-gray-500">
        Your AI-powered browser sidebar
      </p>
    </div>
  )
}

export default SidePanel
