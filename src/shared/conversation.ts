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

// A CloudKit record holds at most 1 MB; 300k characters stay under it even in 3-byte UTF-8 scripts.
const CLOUD_MAX_CHARS = 300_000

/** The conversation as stored in iCloud: JSON, dropping the oldest turns if it would not fit in one record. */
export function conversationForCloud(entries: Entry[], maxChars = CLOUD_MAX_CHARS): string {
  let start = 0
  let data = JSON.stringify(entries)
  while (data.length > maxChars && start < entries.length) {
    start += 1
    data = JSON.stringify(entries.slice(start))
  }
  return data
}

/** The conversation read back from iCloud, or null if it isn't one. */
export function conversationFromCloud(data: string): Entry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const valid = parsed.every((e) =>
    e !== null && typeof e === "object" &&
    ((e as Entry).role === "user" || (e as Entry).role === "assistant") &&
    typeof (e as Entry).content === "string"
  )
  return valid ? (parsed as Entry[]) : null
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
