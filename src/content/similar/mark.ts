// The chat the app asked to open on this page (build 95: Find similar's notification; 2.6 (98): any link in the app), named
// in the page's address (src/shared/linkOpen.ts chatMark; SimilarAway.swift pageOpening).
import { chatMark } from "../../shared/linkOpen.ts"

/**
 * The chat (and its message) the app named in this page's address, taken out of the address at once (the page's own
 * fragment, if any, stays); null when there is none.
 */
export function takeChatMark(): { chat: string; at?: string; similar: boolean } | null {
  const mark = chatMark(location.hash)
  if (!mark) return null
  const clean = `${location.pathname}${location.search}${mark.rest}`
  try {
    history.replaceState(history.state, "", clean)
  } catch {
    // The page's own state can't come across (an extension's script runs apart from the page): the address alone.
    try { history.replaceState(null, "", clean) } catch { /* a page that won't let its address change: harmless */ }
  }
  return { chat: mark.chat, ...(mark.at ? { at: mark.at } : {}), similar: mark.similar }
}
