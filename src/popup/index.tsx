import { render } from "preact"

import { App } from "../content/App"
import { backgroundPdf, cachedPdf, type PageRead, type PageSource } from "../content/context"
import { detectPlatform, HOST_TAG } from "../content/page"
import { pdfName } from "../content/pdf"
import styles from "../content/styles.css"
import { TARGET } from "../shared/config"
import { urlKey } from "../shared/conversation"
import type { PdfResult } from "../shared/types"

// The toolbar popup on a tab where Safari shows a PDF itself (its viewer takes no extension scripts,
// so the panel can't be put on the page): the same panel, as the popup's whole window, about that PDF.

// Safari gives a tab showing a PDF no useful title ("Start Page"): the PDF's own title once it's read, its file name until then.
function pdfSource(url: string): PageSource {
  let pdf: PdfResult | null = null
  const name = () => (pdf?.ok && pdf.title) || pdfName(url)
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "")
    } catch {
      return ""
    }
  })()
  return {
    key: () => urlKey(url),
    href: () => url,
    title: name,
    site: () => host,
    readable: () => Boolean(url),
    kind: () => "pdf",
    pending: () => (pdf?.ok ? null : "pdf"),
    quick: () => ({ title: name(), text: pdf?.ok ? pdf.text : "" }),
    read: async (): Promise<PageRead> => {
      const result = await cachedPdf(url, backgroundPdf)
      pdf = result
      return result.ok
        ? { title: name(), text: result.text, media: "pdf", sources: [{ kind: "pdf", ok: true, name: name(), detail: String(result.pages) }] }
        : { title: name(), text: "", sources: [{ kind: "pdf", ok: false, name: name(), reason: result.reason }] }
    }
  }
}

/** The tab the popup is about: the one its address names, else the active one. */
async function pdfTab(): Promise<chrome.tabs.Tab | undefined> {
  const id = Number(new URLSearchParams(location.search).get("tab"))
  if (id) {
    const tab = await chrome.tabs.get(id).catch(() => undefined)
    if (tab) return tab
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[])
  return active
}

async function main(): Promise<void> {
  const tab = await pdfTab()
  const url = tab?.url && /^https?:/.test(tab.url) ? tab.url : ""
  // Start reading right away: by the time the question is typed, the PDF is ready.
  const source = pdfSource(url)
  // The title in the header once the PDF is read.
  if (url) void cachedPdf(url, backgroundPdf).then(() => source.read()).then(() => window.dispatchEvent(new Event("cf-source")))

  const platform = detectPlatform(TARGET)
  // Safari sizes the popup to its page: a popover beside the toolbar on a Mac and an iPad, a sheet on iPhone.
  document.body.style.height = `${platform === "ios" ? Math.min(640, Math.round(screen.height * 0.75)) : 600}px`
  if (platform !== "ios") document.body.style.width = "420px"
  const host = document.createElement(HOST_TAG)
  host.setAttribute("style", "all:initial;position:fixed;top:0;left:0;width:0;height:0;")
  const root = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styles
  root.appendChild(style)
  const container = document.createElement("div")
  root.appendChild(container)
  document.body.appendChild(host)
  render(<App platform={platform} bus={new EventTarget()} source={source} popup />, container)
}

void main()
