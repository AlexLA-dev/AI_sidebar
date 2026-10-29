// What sharing an answer or a whole chat sends: plain text that keeps the links in the answers,
// the Google sources and the pages asked about. The link to ContextFlow goes separately (the share
// sheet's `url`), so apps show it as a link of its own and the text as text.

import { stripCitations, type Entry } from "./conversation.ts"

export interface ShareLabels {
  you: string // "You"
  sources: string // a Google answer's sources
  source: string // the pages the chat was about
  madeWith: string // "Made with ContextFlow"
}

/** Plain text for copy/share: Markdown syntax gone, structure and links kept. */
export function toPlainText(text: string): string {
  return stripCitations(text)
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim()
}

function link(title: string, url: string): string {
  return title && title !== url ? `${title} — ${url}` : url
}

/** An answer as text, with the Google sources it came with. */
function answerText(entry: Entry, labels: ShareLabels): string {
  const sources = entry.grounding?.sources ?? []
  const text = toPlainText(entry.content)
  return sources.length ? `${text}\n\n${labels.sources}:\n${sources.map((s) => `• ${link(s.title, s.url)}`).join("\n")}` : text
}

/** The page the answer at `index` was about (its question's page). */
function pageOf(entries: Entry[], index: number): { url: string; title: string } | undefined {
  for (let i = index; i >= 0; i--) if (entries[i].role === "user" && entries[i].page) return entries[i].page
  return undefined
}

/** One answer: its text and sources, the page it was about, and where it was made. */
export function answerShareText(entries: Entry[], index: number, labels: ShareLabels, currentUrl: string): string {
  const page = pageOf(entries, index)
  return [answerText(entries[index], labels), "", `${labels.source}: ${page?.url ?? currentUrl}`, labels.madeWith].join("\n")
}

/** The whole chat: questions and answers, every page it was about, and where it was made. */
export function chatShareText(entries: Entry[], labels: ShareLabels, currentUrl: string): string {
  const lines: string[] = []
  const pages = new Map<string, string>()
  for (const m of entries) {
    if (m.role === "user") {
      if (m.page) pages.set(m.page.url, m.page.title)
      lines.push(`${labels.you}: ${m.label ?? m.content}`)
    } else {
      lines.push(`ContextFlow: ${answerText(m, labels)}`, "")
    }
  }
  const sources = [...pages].map(([url, title]) => link(title, url))
  return [
    lines.join("\n").trim(),
    "",
    sources.length ? `${labels.source}:\n${sources.join("\n")}` : `${labels.source}: ${currentUrl}`,
    labels.madeWith
  ].join("\n")
}
