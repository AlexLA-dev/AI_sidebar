// PDFs that belong to the page: shown in it (<embed>, <object>, <iframe>) or linked from its content.
// Their text is read on the device (see PdfText.swift) and goes into the question with the page's.

import { isPdfUrl } from "../shared/pdf.ts"

export { isPdfUrl }

export interface PdfOnPage {
  url: string
  name: string
  embedded: boolean
  // False for a link that only says "PDF": if it isn't one, it is skipped without a word.
  sure: boolean
}

// More links than this in the content: a list of documents, not a page about one of them.
const MAX_CONTENT_LINKS = 3
export const MAX_PDFS = 2


/** The PDF inside a viewer's address (pdf.js `?file=`, Google Docs viewer `?url=`), or the address itself. */
function unwrapViewer(href: string): string {
  try {
    const url = new URL(href)
    const inner = url.searchParams.get("file") ?? url.searchParams.get("url") ?? url.searchParams.get("src")
    if (inner && isPdfUrl(new URL(inner, url).href)) return new URL(inner, url).href
  } catch {
    // not an address
  }
  return href
}

// A link's text that says what to do, not what the file is ("Download", "PDF herunterladen", "Télécharger le PDF",
// "下载 (2 MB)"): the file's name is used instead. Every language the extension speaks (build 95: it knew English
// and «скачать» only). A text counts when every word of it is an action word or a small word around one.
const ACTION_WORDS = new Set([
  "download", "open", "view", "see", "get", "save", "click", "here", "file", "full", "text", // en
  "скачать", "загрузить", "открыть", "смотреть", "просмотр", "посмотреть", "файл", "здесь", "тут", // ru
  "завантажити", "відкрити", "переглянути", "перегляд", // uk
  "herunterladen", "öffnen", "ansehen", "anzeigen", "datei", "hier", // de
  "descargar", "abrir", "ver", "archivo", "aquí", // es
  "télécharger", "ouvrir", "voir", "afficher", "fichier", "ici", // fr
  "scarica", "scaricare", "apri", "aprire", "visualizza", "vedi", "qui", // it
  "baixar", "descarregar", "transferir", "arquivo", "ficheiro", "aqui", // pt
  "ダウンロード", "開く", "表示", "見る", "ファイル", "こちら", // ja
  "다운로드", "열기", "보기", "파일", "여기", // ko
  "下载", "下載", "打开", "打開", "查看", "预览", "預覽", "文件", "檔案", "这里", "這裡", // zh
  "تحميل", "تنزيل", "فتح", "عرض", "ملف", "هنا", // ar
  "tải", "xuống", "về", "mở", "xem", "tệp", "tại", "đây" // vi
])
// The small words around them: articles, "this", "the full", particles.
const FILLER = new Set([
  "a", "an", "the", "this", "as", "to", "in", "le", "la", "les", "l", "un", "une", "ce", "cette", "el", "los", "las",
  "este", "esta", "il", "lo", "gli", "questo", "o", "os", "um", "uma", "das", "die", "der", "den", "dem", "diese",
  "dieses", "ein", "eine", "als", "en", "de", "di", "do", "da", "в", "у", "на", "этот", "цей", "の", "を", "을", "를",
  "此", "该", "該", "这个", "這個", "هذا", "هذه", "الملف"
])

/** Whether a link's text names no file: action words, alone or with "PDF", a size and small words. */
export function actionLabel(text: string): boolean {
  const words = text.toLowerCase()
    .replace(/\(?\s*\d+(?:[.,]\d+)?\s*(?:[kmg]i?b|[кмг]б|bytes?|байт)\s*\)?/gu, " ")
    .replace(/pdf/g, " ")
    // A particle written on the word (Japanese, Korean): a word of its own here (only this check reads them).
    .replace(/([をの]|을|를)/gu, " $1 ")
    .replace(/[\s:·.,()[\]{}|/\\«»"“”'’–—-]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
  return words.every((w) => ACTION_WORDS.has(w) || FILLER.has(w))
}

/** A readable name: the link's text or the file's name. */
export function pdfName(href: string, label = ""): string {
  const text = label.replace(/\s+/g, " ").trim()
  if (text.length >= 3 && text.length <= 120 && !actionLabel(text)) return text
  try {
    const file = decodeURIComponent(new URL(href).pathname.split("/").filter(Boolean).pop() ?? "")
    return file || new URL(href).hostname
  } catch {
    return href.slice(0, 80)
  }
}

const OUTSIDE_CONTENT = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]"

function visible(el: Element): boolean {
  // No layout (tests): count it as visible.
  return typeof (el as HTMLElement).getClientRects !== "function" || (el as HTMLElement).getClientRects().length > 0 || !("offsetParent" in el)
}

/**
 * The page's PDFs, those shown in it first, then those its content links to (only when it links to
 * a few: a page of many documents isn't about any one of them). At most MAX_PDFS.
 */
export function findPdfs(doc: Document, base: string): PdfOnPage[] {
  const found: PdfOnPage[] = []
  const seen = new Set<string>()
  const add = (href: string | null | undefined, name: string, embedded: boolean, sure = true) => {
    if (!href) return
    let url: string
    try {
      url = unwrapViewer(new URL(href, base).href)
    } catch {
      return
    }
    if (!/^https?:/.test(url) || seen.has(url)) return
    seen.add(url)
    found.push({ url, name: pdfName(url, name), embedded, sure })
  }

  for (const el of doc.querySelectorAll<HTMLElement>("embed, object, iframe")) {
    const src = el.getAttribute("src") ?? el.getAttribute("data")
    if (!src) continue
    const typed = /application\/pdf/i.test(el.getAttribute("type") ?? "")
    let resolved = ""
    try {
      resolved = unwrapViewer(new URL(src, base).href)
    } catch {
      continue
    }
    if (typed || isPdfUrl(resolved)) add(resolved, el.getAttribute("title") ?? "", true)
  }

  const links: Array<{ href: string; name: string; sure: boolean }> = []
  const linkSeen = new Set<string>()
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.closest(OUTSIDE_CONTENT) || !visible(a)) continue
    const href = a.getAttribute("href") ?? ""
    let url = ""
    try {
      url = new URL(href, base).href
    } catch {
      continue
    }
    const label = (a.textContent ?? "").trim() || a.getAttribute("aria-label") || a.getAttribute("title") || ""
    const typed = /application\/pdf/i.test(a.getAttribute("type") ?? "")
    // "View PDF" links to addresses without .pdf (arXiv's /pdf/2401.12345): the reader checks it is one.
    const labelled = /\bpdf\b/i.test(`${label} ${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("title") ?? ""}`) && /^https?:/.test(url)
    if (!(isPdfUrl(url) || typed || labelled) || linkSeen.has(url) || seen.has(url)) continue
    linkSeen.add(url)
    links.push({ href: url, name: label, sure: isPdfUrl(url) || typed })
  }
  if (links.length <= MAX_CONTENT_LINKS) for (const l of links) add(l.href, l.name, false, l.sure)
  return found.slice(0, MAX_PDFS)
}

/** True when the page shows or links a PDF worth a "reading the PDF" moment. */
export function hasPdfs(doc: Document, base: string): boolean {
  return findPdfs(doc, base).length > 0
}
