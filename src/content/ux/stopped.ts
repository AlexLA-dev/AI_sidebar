// A question stopped before any of its answer came (2.5 (75), the owner's notes): it leaves no question without an
// answer in the chat, and no chat that only had it; its text goes back to the question field, so nothing is lost.
// Pure, so it's tested without a page.

import { isQuestion, type Entry } from "../../shared/conversation.ts"

/** The chat without its last question when nothing answered it (`question`: that question, else null). */
export function withoutStopped<T extends Entry>(messages: T[]): { kept: T[]; question: T | null } {
  const last = messages[messages.length - 1]
  if (!isQuestion(last)) return { kept: messages, question: null }
  return { kept: messages.slice(0, -1), question: last }
}

/**
 * What the question field holds after `question` was stopped (`draft`: what's in it now), or null to leave it: a
 * question typed comes back, before anything typed since; a quick action's ("Summarize") doesn't, its chip is there.
 */
export function restoredDraft(question: Entry, draft: string): string | null {
  if (question.label || !question.content.trim()) return null
  return draft.trim() ? `${question.content}\n${draft}` : question.content
}
