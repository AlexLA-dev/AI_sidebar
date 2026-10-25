// One running conversation that follows the user across pages (until "New chat").
// Pure helpers shared by the content script and tests.

import type { ChatTurn, Grounding } from "./types.ts"

/** The page a question was asked on: normalized URL, title and a fingerprint of its text. */
export interface PageRef {
  url: string
  title: string
  hash?: string
}

export interface Entry extends ChatTurn {
  label?: string
  mode?: "google"
  // Google answers: sources and Search Suggestions shown with the answer.
  grounding?: Grounding
  // User turns: where they were asked, and whether the page had changed since the last question there.
  page?: PageRef
  pageChanged?: boolean
}

const MAX_HISTORY = 12

/** Short, stable fingerprint of page text (FNV-1a, 32 bit) to notice when a page has new content. */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Removes numbered source citations ("[2](url)") from an answer. */
export function stripCitations(text: string): string {
  return text.replace(/\[\d{1,2}\]\(https?:[^)\s]+\)/g, "")
}

/** The last page the conversation was on (from the latest user turn), if any. */
export function lastPage(entries: Entry[]): PageRef | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === "user" && entries[i].page) return entries[i].page
  return undefined
}

/** True when the page was asked about before in this conversation and its text has changed since. */
export function pageHasChanged(entries: Entry[], url: string, hash: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const page = entries[i].role === "user" ? entries[i].page : undefined
    if (page?.url === url && page.hash) return page.hash !== hash
  }
  return false
}

/**
 * Messages for the model: the last turns, citations stripped, and questions asked on other
 * pages marked with that page so the model knows the current page content isn't what they were about.
 */
export function historyForModel(entries: Entry[], currentUrl: string): ChatTurn[] {
  return entries.slice(-MAX_HISTORY).map(({ role, content, page }) => {
    const text = stripCitations(content)
    if (role === "user" && page && page.url !== currentUrl) {
      return { role, content: `[Asked on another page: "${page.title || page.url}" — ${page.url}]\n${text}` }
    }
    return { role, content: text }
  })
}
