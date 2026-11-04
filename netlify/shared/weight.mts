// A long page costs more of the answer limit (2.5, the owner's rule, for Free and Pro): an answer counts as
// answerWeight(characters the model gets) — the page after unfolding, with its PDFs and video transcript (those
// the plan reads), within the model's limit. Other pages of the chat don't count. The server decides from what it
// sends the model; 2.3 and 2.4 send at most 24 000 characters, so theirs is always 1. Answers with the user's own
// key don't come here (the panel asks the provider itself), so no weight touches them.

import { answerWeight, GAP } from "../../src/shared/pagefit.ts"
import { pageText, type PageContext } from "../../src/shared/prompt.ts"
import type { ChatMessage } from "./llm.mts"

// A follow-up about the same page reads it from Claude's cache, at a tenth of the price. "page": it counts like
// the first question (the owner's rule now); 1: one answer, whatever the page.
export const FOLLOW_UP_WEIGHT: "page" | 1 = "page"

/** The characters of the page the model gets (its text, and the transcript and PDFs the plan reads). */
export function pageChars(page: PageContext | null): number {
  if (!page || page.kind !== "page") return 0
  const given = pageText(page)
  // Without the "[…]" a cut page ends with.
  return given.cut ? given.text.length - GAP.length - 1 : given.text.length
}

/** Whether the question follows one about the same page in this conversation (not one asked on another page). */
export function isFollowUp(messages: ChatMessage[], page: PageContext | null): boolean {
  if (!page || page.changed) return false
  return messages.slice(0, -1).some((m) => m.role === "user" && !m.content.startsWith("[Asked on another page") && !m.content.startsWith("[Note the user wrote"))
}

/** How many answers this question counts as. Google mode and "Ask your chats" take no page: one. */
export function requestWeight(page: PageContext | null, messages: ChatMessage[], followUp: "page" | 1 = FOLLOW_UP_WEIGHT): number {
  const weight = answerWeight(pageChars(page))
  return weight > 1 && followUp === 1 && isFollowUp(messages, page) ? 1 : weight
}

/** A page's length for the analytics, to set the weight against cost_usd. */
export function pageBucket(chars: number): string {
  if (chars <= 24_000) return "24k"
  if (chars <= 100_000) return "100k"
  if (chars <= 200_000) return "200k"
  if (chars <= 400_000) return "400k"
  if (chars <= 1_000_000) return "1m"
  return "more"
}
