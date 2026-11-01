// PDFs: their text (read on the device by the app extension, see PdfText.swift), and tabs where Safari
// shows a PDF itself. Its PDF viewer takes no extension scripts, so there the toolbar button opens
// ContextFlow as a popup about that PDF instead of the panel.

import { TARGET } from "../shared/config"
import { isPdfUrl, looksLikePdf, MAX_FORWARD_BYTES, toBase64 } from "../shared/pdf"
import type { PdfResult } from "../shared/types"
import { callNative } from "./native"

interface NativePdf {
  ok: boolean
  text?: string
  pages?: number
  title?: string
  error?: string
  status?: number
}

const NATIVE_TIMEOUT_MS = 40_000

/** The PDF as the browser gets it (with the user's cookies), or null when it isn't a PDF or too big. */
async function browserBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { credentials: "include" })
    const type = res.headers.get("content-type") ?? ""
    const size = Number(res.headers.get("content-length") ?? 0)
    if (!res.ok || /text\/html/i.test(type) || size > MAX_FORWARD_BYTES) {
      void res.body?.cancel().catch(() => undefined)
      return null
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_FORWARD_BYTES || !looksLikePdf(bytes)) return null
    return bytes
  } catch {
    return null
  }
}

async function readPdf(url: string): Promise<PdfResult> {
  if (TARGET !== "safari") return { ok: false, reason: "failed", error: "unsupported" }
  let result = await callNative<NativePdf>("pdfText", { url }, NATIVE_TIMEOUT_MS)
  // Refused to the device (a sign-in, a blocked download): try with the browser's own request.
  if (result && !result.ok && (result.error === "http" || result.error === "network" || result.error === "notPdf")) {
    const bytes = await browserBytes(url)
    if (bytes) result = (await callNative<NativePdf>("pdfText", { data: toBase64(bytes) }, NATIVE_TIMEOUT_MS)) ?? result
  }
  return pdfResult(result)
}

function pdfResult(result: NativePdf | null): PdfResult {
  if (result?.ok && result.text) return { ok: true, text: result.text, pages: result.pages ?? 0, title: result.title ?? "" }
  const error = result?.error ?? "native"
  return { ok: false, reason: error === "noText" ? "none" : "failed", error }
}

/**
 * A PDF the page fetched itself (base64): one behind a sign-in, whose cookies only the page's own
 * requests carry (Safari keeps them from the extension's).
 */
export function pdfFromBytes(url: string, data: string): Promise<PdfResult> {
  const result = TARGET === "safari"
    ? callNative<NativePdf>("pdfText", { data }, NATIVE_TIMEOUT_MS).then(pdfResult)
    : Promise.resolve<PdfResult>({ ok: false, reason: "failed", error: "unsupported" })
  cache.set(url, { at: Date.now(), result })
  void result.then((r) => {
    if (!r.ok) cache.delete(url)
  })
  return result
}

const cache = new Map<string, { at: number; result: Promise<PdfResult> }>()

/** A PDF's text; good reads are kept for a while (several questions about the same PDF). */
export function pdfText(url: string): Promise<PdfResult> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result
  const result = readPdf(url)
  cache.set(url, { at: Date.now(), result })
  void result.then((r) => {
    if (!r.ok) cache.delete(url)
  })
  for (const key of [...cache.keys()].slice(0, Math.max(0, cache.size - 6))) cache.delete(key)
  return result
}

// ------------------------------------------------------------------ PDF tabs

/** The popup for a tab (it names the tab: the popup's own idea of the current tab can be another one). */
function pdfPopup(tabId: number): string {
  return `popup.html?tab=${tabId}`
}

/** Points the toolbar button of a tab at the PDF popup while the tab shows a PDF. */
export async function markPdfTab(tabId: number, url: string | undefined): Promise<void> {
  if (TARGET !== "safari" || !url) return
  await chrome.action.setPopup({ tabId, popup: isPdfUrl(url) ? pdfPopup(tabId) : "" }).catch(() => undefined)
}

/** The tab shows a PDF (its address says so, or the server does). */
export async function isPdfTab(url: string | undefined): Promise<boolean> {
  if (!url || !/^https?:/.test(url)) return false
  if (isPdfUrl(url)) return true
  try {
    const res = await fetch(url, { method: "HEAD", credentials: "include" })
    return /application\/pdf/i.test(res.headers.get("content-type") ?? "")
  } catch {
    return false
  }
}

/**
 * The toolbar button was pressed on a PDF the panel can't be put on: open the popup, or, where the
 * browser can't open it from here, make the next press open it (and say so on the button).
 */
export async function openPdfPopup(tabId: number): Promise<void> {
  await chrome.action.setPopup({ tabId, popup: pdfPopup(tabId) })
  const action = chrome.action as typeof chrome.action & { openPopup?: (options?: { windowId?: number }) => Promise<void> }
  try {
    if (typeof action.openPopup !== "function") throw new Error("no openPopup")
    await action.openPopup()
  } catch {
    await chrome.action.setBadgeText({ tabId, text: "PDF" }).catch(() => undefined)
  }
}
