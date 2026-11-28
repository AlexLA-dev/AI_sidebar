// The chat a task was started from (2.7.1, the owner: «А будет ли агент учитывать контекст чата, если его там
// вызовут?»): a few of its last turns go with the plan call, only so that «забронируй во втором», «в тот ресторан», «на
// то же время» can be resolved. It is never instructions: the server wraps it as quoted earlier conversation, under the
// same rules as page text (an answer that quoted a page can't authorise anything). The same text already went to the
// model when the person chatted; it isn't stored on the server or logged.

export interface ChatLine {
  role: "user" | "assistant"
  content: string
}

export const CHAT_TURNS = 6
export const CHAT_CHARS = 2000
const ANSWER_CHARS = 700

/**
 * The thread's last turns, oldest first, at most `CHAT_TURNS` and about `CHAT_CHARS` in all: the newest kept whole
 * (trimmed only past the whole budget), older answers trimmed, and what no longer fits left out. "" for no thread.
 */
export function chatContext(turns: ChatLine[]): string {
  const recent = turns.filter((t) => (t.role === "user" || t.role === "assistant") && t.content.trim()).slice(-CHAT_TURNS)
  const out: string[] = []
  let left = CHAT_CHARS
  for (let i = recent.length - 1; i >= 0 && left > 40; i--) {
    const t = recent[i]
    const flat = t.content.replace(/\s+/g, " ").trim()
    const cap = i === recent.length - 1 ? left : Math.min(left, t.role === "assistant" ? ANSWER_CHARS : 400)
    const text = flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
    const line = `${t.role === "user" ? "person" : "assistant"}: ${text}`
    out.unshift(line)
    left -= line.length + 1
  }
  return out.join("\n")
}
