// How a page's text and what was read along with it (a transcript, captions, PDFs) share the limit
// of a page with media (MAX_MEDIA_PAGE_CHARS).

import { MAX_MEDIA_PAGE_CHARS, MAX_PAGE_CHARS } from "../shared/prompt.ts"
import { clock } from "./youtube.ts"

// Room for the page's own text next to a transcript or PDFs.
const PAGE_PART_CHARS = 8_000

/** "Video: …" + transcript, then what the page shows (description, comments), within the media limit. */
export function composeVideo(name: string, duration: number, transcript: string, pageText: string): string {
  const head = `Video: ${name}\nLength: ${clock(duration)}\n\nTranscript (timestamps in [m:ss]):\n`
  const page = pageText.slice(0, PAGE_PART_CHARS)
  const room = MAX_MEDIA_PAGE_CHARS - head.length - page.length - 40
  return `${head}${transcript.slice(0, room)}\n\nPage text (description, comments):\n${page}`
}

/** The page's text followed by its PDFs (and a video's captions), sharing the media limit. */
export function composeWithAttachments(pageText: string, parts: Array<{ heading: string; text: string }>): string {
  if (!parts.length) return pageText
  const page = pageText.slice(0, MAX_PAGE_CHARS)
  let room = MAX_MEDIA_PAGE_CHARS - page.length
  const out = [page]
  parts.forEach((part, i) => {
    const share = Math.floor(room / (parts.length - i))
    const body = `\n\n${part.heading}\n${part.text}`.slice(0, Math.max(0, share))
    room -= body.length
    out.push(body)
  })
  return out.join("")
}
