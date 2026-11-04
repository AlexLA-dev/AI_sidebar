// What a question is asked with: the page's text plus, when the page has them, a video's transcript or
// captions and its PDFs (Pro: for other plans they aren't read, and the question says the page has
// them). Reading those can take a few seconds (the panel says so meanwhile); whatever can't be read is
// noted under the question and the answer uses the rest.

import type { Attachment, MediaKind } from "../shared/attachments"
import { TARGET } from "../shared/config"
import type { SourceNote } from "../shared/conversation"
import { fitBodyBytes } from "../shared/pagefit"
import { looksLikePdf, MAX_FORWARD_BYTES, toBase64 } from "../shared/pdf"
import type { BackgroundRequest, PdfResult } from "../shared/types"
import { hasCaptionTracks, readCaptions, type CaptionsRead } from "./captions"
import { extractPage, pageKey, siteName } from "./page"
import { findPdfs, type PdfOnPage } from "./pdf"
import { browserEnv, cachedTranscript, clock, hasTranscript, readTranscript, youtubeVideoId } from "./youtube"

export interface PageRead {
  title: string
  // The page's own text; a video's transcript and the PDFs come apart, in `attachments`.
  text: string
  attachments?: Attachment[]
  // The page has a video or PDFs that weren't read: the plan doesn't include them.
  skipped?: MediaKind[]
  sources: SourceNote[]
}

/** Where the panel's questions get their context: the tab's page, or the PDF a popup is about. */
export interface PageSource {
  /** Normalized address: the chat's key for "this page". */
  key(): string
  href(): string
  title(): string
  site(): string
  /** There is something to read. */
  readable(): boolean
  /** What the header shows the context as. */
  kind(): "page" | "video" | "pdf"
  /** What reading will wait for (the panel shows "Reading the video…"), or null when it's quick. */
  pending(): "video" | "pdf" | null
  /** The page as it is now, quickly (for notes: title and a fingerprint of the text). */
  quick(): { title: string; text: string }
  /** Everything a question goes with (`withMedia`: the video and PDFs too, else only noted as skipped). */
  read(withMedia: boolean): Promise<PageRead>
}

const CAPTIONS_TIMEOUT_MS = 6_000

// ------------------------------------------------------------------ PDFs

const PDF_TIMEOUT_MS = 45_000
const pdfCache = new Map<string, { at: number; result: Promise<PdfResult> }>()

/** A PDF's text, read once per page visit (failures again after a minute). */
export function cachedPdf(url: string, read: (url: string) => Promise<PdfResult | null>): Promise<PdfResult> {
  const hit = pdfCache.get(url)
  if (hit && Date.now() - hit.at < 60_000) return hit.result
  const result = Promise.race([
    read(url).then((r): PdfResult => r ?? { ok: false, reason: "failed", error: "noReply" }),
    new Promise<PdfResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "failed", error: "timeout" }), PDF_TIMEOUT_MS))
  ])
  pdfCache.set(url, { at: Date.now(), result })
  void result.then((r) => {
    // Keep good reads for the page visit.
    if (r.ok) pdfCache.set(url, { at: Infinity, result })
  })
  return result
}

function pdfCached(url: string): boolean {
  const hit = pdfCache.get(url)
  return Boolean(hit && Date.now() - hit.at < 60_000)
}

function pdfNote(pdf: PdfOnPage, result: PdfResult): SourceNote | null {
  if (result.ok) return { kind: "pdf", ok: true, name: result.title || pdf.name, detail: String(result.pages) }
  // A link that only said "PDF" and turned out not to be one: nothing to tell.
  if (!pdf.sure && result.error === "notPdf") return null
  return { kind: "pdf", ok: false, name: pdf.name, reason: result.reason }
}

// ------------------------------------------------------------------ the tab's page

function videoTitle(): string {
  return document.title.replace(/\s*[-–]\s*YouTube\s*$/i, "").replace(/^\(\d+\)\s*/, "").trim() || document.title
}

function videoDuration(): number | null {
  const video = document.querySelector<HTMLVideoElement>("#movie_player video, video")
  return video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : null
}

async function readTab(readPdf: (url: string) => Promise<PdfResult | null>, withMedia: boolean): Promise<PageRead> {
  // All of the page (2.5), within the request's size limit (pagefit.ts).
  const read = extractPage(Infinity)
  const page = { ...read, text: fitBodyBytes(read.text) }
  const videoId = youtubeVideoId(location.href)
  if (!withMedia) {
    // Not read at all: only what the page shows (a video page's title, description and comments).
    const skipped: MediaKind[] = videoId || hasCaptionTracks(document) ? ["video"] : []
    if (!videoId && pagePdfs().length) skipped.push("pdf")
    return { title: page.title, text: page.text, ...(skipped.length ? { skipped } : {}), sources: [] }
  }
  if (videoId) {
    const name = videoTitle()
    const transcript = await cachedTranscript(videoId, () => readTranscript(browserEnv(), videoId))
    if (transcript.status === "ok") {
      const duration = videoDuration() ?? transcript.duration
      return {
        title: page.title,
        text: page.text,
        attachments: [{ kind: "video", lead: true, heading: `Video: ${name}\nLength: ${clock(duration)}\n\nTranscript (timestamps in [m:ss]):`, text: transcript.text }],
        sources: [{ kind: "video", ok: true, name, detail: clock(duration) }]
      }
    }
    // For Web Inspector: which step failed when YouTube changes its pages.
    console.info("[ContextFlow] video transcript:", transcript.status, transcript.why)
    return {
      title: page.title,
      // So the model doesn't take the description for what the video says.
      text: `[The video's transcript could not be read: below is only what the page shows (title, description, comments).]\n\n${page.text}`,
      sources: [{ kind: "video", ok: false, name, reason: transcript.status }]
    }
  }

  const attachments: Attachment[] = []
  const sources: SourceNote[] = []
  const pdfs = pagePdfs()
  // undefined: no video with captions on the page; null: there is one, but its captions couldn't be read.
  const captionsRead: Promise<CaptionsRead | null | undefined> = hasCaptionTracks(document)
    ? Promise.race([
        readCaptions(document, document.documentElement.lang || navigator.language).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTIONS_TIMEOUT_MS))
      ])
    : Promise.resolve(undefined)
  const [captions, pdfResults] = await Promise.all([captionsRead, Promise.all(pdfs.map((pdf) => cachedPdf(pdf.url, readPdf)))])
  if (captions) {
    const name = captions.name || page.title
    attachments.push({ kind: "video", heading: `Captions of the video "${name}" (timestamps in [m:ss]):`, text: captions.text })
    sources.push({ kind: "video", ok: true, name, detail: clock(captions.duration) })
  } else if (captions === null) {
    sources.push({ kind: "video", ok: false, name: page.title, reason: "failed" })
  }
  pdfs.forEach((pdf, i) => {
    const result = pdfResults[i]
    const note = pdfNote(pdf, result)
    if (note) sources.push(note)
    if (result.ok) attachments.push({ kind: "pdf", heading: `PDF "${note?.name ?? pdf.name}" (${result.pages} pages, ${pdf.url}):`, text: result.text })
  })
  return { title: page.title, text: page.text, ...(attachments.length ? { attachments } : {}), sources }
}

/** The page's PDFs (read by the app extension: Safari only). */
function pagePdfs(): PdfOnPage[] {
  return TARGET === "safari" ? findPdfs(document, location.href) : []
}

/** The page of the tab the panel is in. */
export function tabSource(readPdf: (url: string) => Promise<PdfResult | null>): PageSource {
  return {
    key: pageKey,
    href: () => location.href,
    title: () => document.title,
    site: siteName,
    readable: () => Boolean(document.body && (document.body.innerText || "").trim().length > 40),
    kind: () => (youtubeVideoId(location.href) || hasCaptionTracks(document) ? "video" : pagePdfs().length ? "pdf" : "page"),
    pending: () => {
      const videoId = youtubeVideoId(location.href)
      if (videoId) return hasTranscript(videoId) ? null : "video"
      if (pagePdfs().some((p) => !pdfCached(p.url))) return "pdf"
      return hasCaptionTracks(document) ? "video" : null
    },
    quick: extractPage,
    read: (withMedia) => readTab(readPdf, withMedia)
  }
}

function ask(message: BackgroundRequest): Promise<PdfResult | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: PdfResult | undefined) => {
        void chrome.runtime.lastError
        resolve(response ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

/** A PDF's text from the background (which has the app extension read it). */
export function backgroundPdf(url: string): Promise<PdfResult | null> {
  return ask({ type: "pdfText", url })
}

/** The PDF as the page gets it: a same-site request carries the site's sign-in cookies. */
async function pageBytes(url: string): Promise<Uint8Array | null> {
  try {
    if (new URL(url).origin !== location.origin) return null
    const res = await fetch(url, { credentials: "include" })
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_FORWARD_BYTES) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.length <= MAX_FORWARD_BYTES && looksLikePdf(bytes) ? bytes : null
  } catch {
    return null
  }
}

/**
 * A PDF of the tab's page: read by the device, or, when that is refused (a PDF behind a sign-in),
 * fetched by the page with its cookies and handed over.
 */
export async function tabPdf(url: string): Promise<PdfResult | null> {
  const first = await backgroundPdf(url)
  if (first && !first.ok && /^(http|network|notPdf)$/.test(first.error)) {
    const bytes = await pageBytes(url)
    if (bytes) return (await ask({ type: "pdfBytes", url, data: toBase64(bytes) })) ?? first
  }
  return first
}
