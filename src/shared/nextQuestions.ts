// 2.8 (В6.1): two follow-up questions under an answer, one tap each, written by the model with the answer itself (no
// second call, nothing counted for them). The answer ends with NEXT_MARKER and the two questions, one per line; the panel
// and the background's job take them off the text and keep them on the answer (`next`). Only for requests that ask for
// them (`next: true`), so older clients never see the marker.

export const NEXT_MARKER = "[[cf:next]]"
/** At most this many, each at most this long. */
export const NEXT_MAX = 2
export const NEXT_CHARS = 90

/** The answer as shown and kept, and its follow-up questions. While it streams, the marker's start at the end is
 *  hidden too, and nothing after a marker shows. */
export function splitNext(text: string): { text: string; next: string[] } {
  const at = text.indexOf(NEXT_MARKER)
  if (at < 0) {
    for (let k = Math.min(NEXT_MARKER.length - 1, text.length); k >= 2; k--) {
      if (text.endsWith(NEXT_MARKER.slice(0, k))) return { text: text.slice(0, -k).replace(/\s+$/, ""), next: [] }
    }
    return { text, next: [] }
  }
  const next = text
    .slice(at + NEXT_MARKER.length)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["«“„]+|["»”“]+$/g, "").replace(/\[\[cf:[a-z]+\]\]/g, "").trim())
    .filter((line) => line.length >= 3 && line.length <= NEXT_CHARS)
    .slice(0, NEXT_MAX)
  return { text: text.slice(0, at).replace(/\s+$/, ""), next }
}
