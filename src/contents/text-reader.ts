import type { PlasmoCSConfig } from "plasmo"
import type { PlasmoMessaging } from "@plasmohq/messaging"
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

function getSelectedText(): string | null {
  const selection = window.getSelection()
  if (selection && selection.toString().trim().length > 0) {
    return selection.toString().trim()
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

const handler: PlasmoMessaging.MessageHandler<RequestBody, ResponseBody> = async (req, res) => {
  try {
    if (req.body?.action === "getPageText") {
      const url = window.location.href

      // Priority 1: Check for text selection
      const selectedText = getSelectedText()
      if (selectedText && selectedText.length > 10) {
        res.send({
          success: true,
          text: selectedText,
          title: document.title,
          url,
          contextType: "selection",
          isReadabilityParsed: false
        })
        return
      }

      // Priority 2: Try Readability for articles
      const readabilityResult = extractWithReadability()

      if (readabilityResult.success) {
        res.send({
          success: true,
          text: readabilityResult.text,
          title: readabilityResult.title,
          url,
          excerpt: readabilityResult.excerpt || undefined,
          byline: readabilityResult.byline || undefined,
          contextType: "page",
          isReadabilityParsed: true
        })
        return
      }

      // Priority 3: Fallback to cleaned innerText
      const fallbackResult = extractFallback()

      res.send({
        success: true,
        text: fallbackResult.text,
        title: fallbackResult.title,
        url,
        contextType: "page",
        isReadabilityParsed: false
      })
    } else {
      res.send({
        success: false,
        error: "Unknown action"
      })
    }
  } catch (error) {
    res.send({
      success: false,
      error: error instanceof Error ? error.message : "Failed to read page"
    })
  }
}

export default handler
