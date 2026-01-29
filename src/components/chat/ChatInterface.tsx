import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Loader2, Bot, User } from "lucide-react"
import Markdown from "react-markdown"
import { motion, AnimatePresence } from "framer-motion"

import { cn } from "~/lib/utils"
import type { Message, ContextType, TrialInfo } from "~/lib/ai"
import { streamChatResponse, LimitReachedError } from "~/lib/ai"

type ChatInterfaceProps = {
  apiKey: string
  pageContext: string | null
  pageTitle: string | null
  contextType?: ContextType
  isReadabilityParsed?: boolean
  trialInfo: TrialInfo | null
  onTrialUpdate: () => void
  onLimitReached: () => void
}

export function ChatInterface({
  apiKey,
  pageContext,
  pageTitle,
  contextType = "page",
  isReadabilityParsed,
  trialInfo,
  onTrialUpdate,
  onLimitReached
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streamingContentRef = useRef("")

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingContent, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [input])

  const handleSubmit = async () => {
    if (!input.trim() || isStreaming) return

    const userMessage: Message = { role: "user", content: input.trim() }
    const newMessages = [...messages, userMessage]

    setMessages(newMessages)
    setInput("")
    setIsStreaming(true)
    setStreamingContent("")
    streamingContentRef.current = ""

    await streamChatResponse(
      newMessages,
      pageContext,
      apiKey,
      {
        onChunk: (chunk) => {
          streamingContentRef.current += chunk
          setStreamingContent(streamingContentRef.current)
        },
        onComplete: () => {
          const finalContent = streamingContentRef.current
          if (finalContent) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: finalContent }
            ])
          }
          setStreamingContent("")
          streamingContentRef.current = ""
          setIsStreaming(false)
          // Update trial info after successful request
          onTrialUpdate()
        },
        onError: (error) => {
          // Handle limit reached error specifically
          if (error instanceof LimitReachedError) {
            onLimitReached()
            // Remove the user message since request wasn't processed
            setMessages((prev) => prev.slice(0, -1))
          } else {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: `Error: ${error.message}` }
            ])
          }
          setStreamingContent("")
          streamingContentRef.current = ""
          setIsStreaming(false)
        }
      },
      contextType
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const displayMessages = isStreaming && streamingContent
    ? [...messages, { role: "assistant" as const, content: streamingContent }]
    : messages

  // Show trial counter only for non-licensed users
  const showTrialCounter = trialInfo && !trialInfo.hasLicense

  return (
    <div className="flex flex-col h-full">
      {/* Trial Counter */}
      {showTrialCounter && (
        <div className="px-3 py-2 bg-purple-50 dark:bg-purple-900/20 border-b border-purple-100 dark:border-purple-800">
          <div className="flex items-center justify-between">
            <span className="text-xs text-purple-600 dark:text-purple-400">
              Trial: {trialInfo.remaining}/5 requests left
            </span>
            <div className="flex gap-1">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "w-2 h-2 rounded-full",
                    i < trialInfo.remaining
                      ? "bg-purple-500"
                      : "bg-purple-200 dark:bg-purple-700"
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {displayMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Bot className="h-10 w-10 text-gray-300 dark:text-gray-600 mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {pageContext
                ? "Ask me anything about this page"
                : "Open a page and ask me about it"}
            </p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {displayMessages.map((message, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "flex gap-2",
                message.role === "user" ? "justify-end" : "justify-start"
              )}
            >
              {message.role === "assistant" && (
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
                  <Bot className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                </div>
              )}

              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                  message.role === "user"
                    ? "bg-purple-600 text-white rounded-br-md"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-bl-md"
                )}
              >
                {message.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2">
                    <Markdown>{message.content}</Markdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{message.content}</p>
                )}
              </div>

              {message.role === "user" && (
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                  <User className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {isStreaming && !streamingContent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-2"
          >
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
              <Bot className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-md px-3 py-2">
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            </div>
          </motion.div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-gray-100 dark:border-gray-800 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this page..."
            disabled={isStreaming}
            rows={1}
            className={cn(
              "flex-1 resize-none rounded-xl border border-gray-200 dark:border-gray-700",
              "bg-white dark:bg-gray-800 px-3 py-2 text-sm",
              "placeholder:text-gray-400 dark:placeholder:text-gray-500",
              "focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isStreaming}
            className={cn(
              "flex-shrink-0 p-2 rounded-xl",
              "bg-purple-600 text-white",
              "hover:bg-purple-700 transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {isStreaming ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
