import type { PlasmoCSConfig } from "plasmo"
import { Readability } from "@mozilla/readability"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"]
}

export type RequestBody = {
  action: "getPageText"
}

export type ContextType = "page" | "selection"

export type ResponseBody = {
  success: boolean
  text?: string
  title?: string
  url?: string
  excerpt?: string
  byline?: string
  contextType?: ContextType
  isReadabilityParsed?: boolean
  error?: string
}

function extractSelection(): { text: string; title: string } | null {
  const selection = window.getSelection()
  const selectedText = selection?.toString().trim()

  if (selectedText) {
    return {
      text: selectedText,
      title: document.title
    }
  }

  return null
}

function extractWithReadability(): {
  text: string
  title: string
  excerpt: string | null
  byline: string | null
  success: boolean
} {
  try {
    // Clone the document to avoid modifying the original
    const documentClone = document.cloneNode(true) as Document

    const reader = new Readability(documentClone, {
      charThreshold: 100 // Minimum characters for content
    })

    const article = reader.parse()

    if (article && article.textContent && article.textContent.length > 200) {
      return {
        text: article.textContent.trim(),
        title: article.title || document.title,
        excerpt: article.excerpt,
        byline: article.byline,
        success: true
      }
    }
  } catch (e) {
    console.warn("[ContextFlow] Readability parse failed:", e)
  }

  return {
    text: "",
    title: "",
    excerpt: null,
    byline: null,
    success: false
  }
}

function extractFallback(): { text: string; title: string } {
  // Fallback: use innerText but try to clean it up a bit
  const body = document.body

  // Remove common noise elements before extraction
  const clone = body.cloneNode(true) as HTMLElement
  const noiseSelectors = [
    "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    ".nav", ".navigation", ".menu", ".sidebar", ".footer", ".header",
    ".cookie", ".popup", ".modal", ".ad", ".advertisement",
    "script", "style", "noscript", "iframe"
  ]

  noiseSelectors.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove())
  })

  return {
    text: clone.innerText.trim(),
    title: document.title
  }
}

// Auto-detect text selection via mouseup and notify the sidepanel
let selectionDebounce: ReturnType<typeof setTimeout> | null = null
let lastSentText = ""

function sendContextUpdate() {
  const selection = window.getSelection()
  const selectedText = selection?.toString().trim() || ""

  // Avoid sending duplicate updates
  if (selectedText === lastSentText) return
  lastSentText = selectedText

  try {
    if (selectedText.length > 0) {
      // User selected text — send selection context
      chrome.runtime.sendMessage({
        action: "contextUpdate",
        type: "selection",
        text: selectedText,
        title: document.title,
        url: window.location.href
      })
    } else {
      // Selection cleared — revert to page context
      const readability = extractWithReadability()
      const fallback = extractFallback()
      const pageText = readability.success ? readability.text : fallback.text
      const pageTitle = readability.success ? readability.title : fallback.title

      chrome.runtime.sendMessage({
        action: "contextUpdate",
        type: "page",
        text: pageText,
        title: pageTitle,
        url: window.location.href,
        isReadabilityParsed: readability.success
      })
    }
  } catch {
    // Extension context may be invalidated — ignore
  }
}

document.addEventListener("mouseup", () => {
  if (selectionDebounce) clearTimeout(selectionDebounce)
  selectionDebounce = setTimeout(sendContextUpdate, 300)
})

// iOS Safari: text selection via long-press doesn't fire mouseup.
// selectionchange fires on all platforms when the selection changes.
document.addEventListener("selectionchange", () => {
  if (selectionDebounce) clearTimeout(selectionDebounce)
  selectionDebounce = setTimeout(sendContextUpdate, 500)
})

chrome.runtime.onMessage.addListener((request: RequestBody, _sender, sendResponse) => {
  if (request?.action !== "getPageText") {
    return false
  }

  // All extraction functions are synchronous, so we respond immediately
  // This prevents "message channel closed" errors
  try {
    const url = window.location.href

    // Priority 1: Check for text selection
    const selectionResult = extractSelection()
    if (selectionResult && selectionResult.text.length > 10) {
      sendResponse({
        success: true,
        text: selectionResult.text,
        title: selectionResult.title,
        url,
        contextType: "selection",
        isReadabilityParsed: false
      })
      return // Synchronous response - no need to return true
    }

    // Priority 2: Try Readability for articles
    const readabilityResult = extractWithReadability()

    if (readabilityResult.success) {
      sendResponse({
        success: true,
        text: readabilityResult.text,
        title: readabilityResult.title,
        url,
        excerpt: readabilityResult.excerpt || undefined,
        byline: readabilityResult.byline || undefined,
        contextType: "page",
        isReadabilityParsed: true
      })
      return // Synchronous response - no need to return true
    }

    // Priority 3: Fallback to cleaned innerText
    const fallbackResult = extractFallback()

    sendResponse({
      success: true,
      text: fallbackResult.text,
      title: fallbackResult.title,
      url,
      contextType: "page",
      isReadabilityParsed: false
    })
    // Synchronous response - no need to return true
  } catch (error) {
    console.error("[ContextFlow] Content script error:", error)
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "Failed to read page"
    })
  }
})
