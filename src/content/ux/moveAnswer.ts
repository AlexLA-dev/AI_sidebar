// «…» ▸ Move to another chat (2.7 (109), the owner on 108: «явно не хватает опции в меню <…> перенести ответ на другой
// чат»). An answer goes with its question, a note by itself, through the same move as organizing (threads.ts
// moveEntries): the moved messages keep their keys and say where they came from, so iCloud and the app put them in the
// chat they went to (sweepMoved, Organize.swift) and a reminder's link still finds them (ChatUX.swift find). Their tags,
// pin, highlights and reminder are on the messages and go with them; the collections' cards of them follow
// (collections.ts cardsMoved). Undo right after, on the bar.

import type { Entry } from "../../shared/conversation.ts"
import { activity, foldText, threadName, type Thread } from "../../shared/threads.ts"

/**
 * The messages that move with message `idx`: an answer with its question when it's that question's only answer (a
 * second answer to it stays with it), a note or a lone answer by itself. Null for a question (its «…» isn't offered).
 */
export function moveRange(entries: Entry[], idx: number): { start: number; end: number } | null {
  const m = entries[idx]
  if (!m) return null
  if (m.note) return { start: idx, end: idx }
  if (m.role !== "assistant") return null
  const question = entries[idx - 1]
  const only = idx + 1 >= entries.length || entries[idx + 1].role === "user"
  return question && question.role === "user" && !question.note && only ? { start: idx - 1, end: idx } : { start: idx, end: idx }
}

/**
 * The chats it can go to, the latest first: every space's (`all`), not this one, not «Ask your chats», not one in
 * Recently Deleted; the ones whose name has every word of `query` (folded: case and accents off).
 */
export function moveTargets(all: Thread[], current: string, query = ""): Thread[] {
  const words = foldText(query.toLowerCase()).split(" ").filter(Boolean)
  return all
    .filter((th) => th.id !== current && !th.deleted && th.trashed === undefined && th.kind !== "history" && th.m.length > 0)
    .filter((th) => {
      if (!words.length) return true
      const name = foldText(threadName(th).toLowerCase())
      return words.every((w) => name.includes(w))
    })
    .sort((a, b) => activity(b) - activity(a))
}
