// What a question can carry besides the page's own text: a video's transcript or captions and the
// page's PDFs. They travel as separate parts, not inside the page's text, so whoever answers can
// leave them out for a plan without them (reading videos and PDFs is Pro; the server decides, the
// panel only saves the work). Kept, they share the media limit with the page's text.

import { MAX_MEDIA_PAGE_CHARS, MAX_PAGE_CHARS, type PageContext } from "./prompt.ts"
import type { Plan } from "./types.ts"

export type MediaKind = "video" | "pdf"

export interface Attachment {
  kind: MediaKind
  // What it is: "PDF "Report" (12 pages, https://…):", "Captions of the video "…" (timestamps in [m:ss]):",
  // or for a video page "Video: …\nLength: 18:40\n\nTranscript (timestamps in [m:ss]):".
  heading: string
  text: string
  // A video page (YouTube): the transcript comes first, then what the page shows (description, comments).
  lead?: boolean
}

export const MAX_ATTACHMENTS = 4
// Room for the page's own text next to a transcript or PDFs.
const PAGE_PART_CHARS = 8_000

/** The page's text with what was read along with it, within the media limit. */
export function composePage(pageText: string, attachments: Attachment[]): string {
  const lead = attachments.find((a) => a.lead)
  if (lead) {
    const page = pageText.slice(0, PAGE_PART_CHARS)
    const room = MAX_MEDIA_PAGE_CHARS - lead.heading.length - page.length - 40
    return `${lead.heading}\n${lead.text.slice(0, room)}\n\nPage text (description, comments):\n${page}`
  }
  if (!attachments.length) return pageText
  // The page whole (2.5), its PDFs within the media limit.
  let room = MAX_MEDIA_PAGE_CHARS
  const out = [pageText]
  attachments.forEach((part, i) => {
    const share = Math.floor(room / (attachments.length - i))
    const body = `\n\n${part.heading}\n${part.text}`.slice(0, Math.max(0, share))
    room -= body.length
    out.push(body)
  })
  return out.join("")
}

/**
 * Whether the panel reads a page's video and PDFs: Pro, or the user's own key where it can be used
 * (a paid plan; on Chrome there are no plans). Free answers use the page's text.
 */
export function readsMedia(status: { plan: Plan; hasOwnKey: boolean } | null, target: string): boolean {
  if (!status) return false
  return status.plan === "pro" || (status.hasOwnKey && (target === "chrome" || status.plan !== "free"))
}

/** The kinds of media among `attachments`, video first. */
export function mediaKinds(attachments: Array<{ kind: MediaKind }>): MediaKind[] {
  return (["video", "pdf"] as const).filter((kind) => attachments.some((a) => a.kind === kind))
}

/**
 * The page as the model gets it. `withMedia` (Pro, or the user's own key): the transcript and PDFs
 * go into its text. Without: they are left out and named in `skipped`, so the answer says it didn't
 * see them; a text that already carries them (a build that composed it itself) is cut to a page's limit.
 */
export function pageForModel(page: PageContext, withMedia: boolean): PageContext {
  const { attachments = [], ...rest } = page
  if (withMedia) {
    if (!attachments.length) return rest
    return { ...rest, text: composePage(rest.text, attachments), media: mediaKinds(attachments)[0] }
  }
  const skipped = [...new Set([...(rest.skipped ?? []), ...mediaKinds(attachments), ...(rest.media ? [rest.media] : [])])]
  const { media, ...plain } = rest
  return { ...plain, text: media ? plain.text.slice(0, MAX_PAGE_CHARS) : plain.text, ...(skipped.length ? { skipped: mediaKinds(skipped.map((kind) => ({ kind }))) } : {}) }
}
