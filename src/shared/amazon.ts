// Amazon (2.7.1, the owner: «расширение должно писать пользователю объяснение, почему оно не может полноценно там
// функционировать, но простым, понятным, лаконичным языком»): the one place every Amazon limit takes its words from.
// - The agent doesn't act on Amazon (src/shared/agent/sites.ts; Amazon's terms and its suit against agent shopping):
//   «amazonAgent».
// - Find similar can't check Amazon's listings: marketplaces don't let our server open their pages
//   (netlify/shared/similar.mts), so an Amazon item stays unchecked: «amazonSimilar» instead of the plain
//   «Couldn't open the page to check».
// No legal wording, no blame; the same words in all 15 languages.

import { AMAZON } from "./agent/sites.ts"

/** An Amazon address or host (amazon.*, amzn.*, audible.*). */
export function isAmazon(urlOrHost: string): boolean {
  let host = urlOrHost
  try {
    if (/^https?:\/\//i.test(urlOrHost)) host = new URL(urlOrHost).hostname
  } catch {
    return false
  }
  return AMAZON.test(host.toLowerCase().replace(/^www\./, ""))
}

/** The locale keys of the Amazon explanations, one per limited feature. */
export const AMAZON_TEXT = { agent: "amazonAgent", similar: "amazonSimilar" } as const
