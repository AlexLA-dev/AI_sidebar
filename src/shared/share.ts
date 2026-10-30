// What sharing an answer or a whole chat sends: one plain text that keeps the links in the answers,
// the Google sources and the pages asked about, and ends with the link to ContextFlow. It goes to the
// share sheet as text only: given a separate link, iOS shares that page and most apps drop the text.
// Its labels ("You", "Source"…) are in the language the questions were typed in, else the device's.
// It never starts with "word:": apps that take text that parses as a URL as a link (Heptabase) would
// save the whole text as one link, scheme "You".

import { stripCitations, type Entry } from "./conversation.ts"

export interface ShareLabels {
  you: string // "You"
  sources: string // a Google answer's sources
  source: string // the pages the chat was about
  madeWith: string // "Made with ContextFlow"
}

export interface ShareLinks {
  page: string // the page open now, for an answer that wasn't about a page
  app: string // ContextFlow in the App Store
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
export function answerShareText(entries: Entry[], index: number, labels: ShareLabels, links: ShareLinks): string {
  const page = pageOf(entries, index)
  return notALink([answerText(entries[index], labels), "", `${labels.source}: ${page?.url ?? links.page}`, "", `${labels.madeWith}: ${links.app}`].join("\n"))
}

/** The whole chat under its name: questions and answers, every page it was about, and where it was made. */
export function chatShareText(entries: Entry[], name: string, labels: ShareLabels, links: ShareLinks): string {
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
  return notALink([
    ...(name ? [name, ""] : []),
    lines.join("\n").trim(),
    "",
    sources.length ? `${labels.source}:\n${sources.join("\n")}` : `${labels.source}: ${links.page}`,
    "",
    `${labels.madeWith}: ${links.app}`
  ].join("\n"))
}

/** Text that doesn't parse as a URL: a leading "word:" (a URL scheme to parsers) becomes "word —". */
export function notALink(text: string): string {
  return text.replace(/^([a-z][a-z0-9+.-]*):(?!\/\/)/i, "$1 —")
}

// Words that mark a language written in Latin letters, and letters only it uses.
const LATIN: Array<[string, Set<string>, RegExp]> = [
  ["en", new Set("the is are what how why who which this that these with about does do can you your of and to in it for".split(" ")), /$^/],
  ["de", new Set("der die das ist sind und was wie warum wer nicht ein eine einen ich du mit für auf über worum geht es den dem des".split(" ")), /[ßäöü]/],
  ["es", new Set("el los las es son qué que cómo por y en un una del se está para con sobre trata eso esto".split(" ")), /[ñ¿¡]/],
  ["fr", new Set("le les est sont et que quoi comment pourquoi un une des du ce cet cette il elle pour dans avec sur qui parle".split(" ")), /[œêâîôûëïç]/],
  ["it", new Set("il lo gli è sono che cosa come perché di e un una del della per con su questo questa parla".split(" ")), /$^/],
  ["pt_BR", new Set("o os é são que como por e um uma do da não para com sobre isso este esta fala".split(" ")), /[ãõ]/]
]

/** The language of a text, when it's clear: a locale code ("ru", "pt_BR"…). */
export function textLanguage(text: string): string | undefined {
  text = text.replace(/(https?:\/\/|www\.)\S+/gi, " ") // links are Latin whatever the language
  const count = (re: RegExp) => text.match(re)?.length ?? 0
  const scripts: Array<[string | undefined, number]> = [
    ["ko", count(/[\uac00-\ud7af]/g)],
    [count(/[\u3040-\u30ff]/g) ? "ja" : "zh_CN", count(/[\u3040-\u30ff\u4e00-\u9fff]/g)],
    [/[іїєґ]|(^|[^а-яё])(що|це|ця|цей|чому|який|яка|яке)(?![а-яё])/i.test(text) ? "uk" : "ru", count(/[а-яёіїєґ]/gi)],
    [undefined, count(/[a-zà-ÿœ]/gi)]
  ]
  const [script, letters] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a))
  if (letters < 3) return undefined
  if (script) return script

  const words = text.toLowerCase().match(/[a-zà-ÿœ]+/g) ?? []
  const scores = LATIN.map(([lang, common, letter]) => [lang, words.filter((w) => common.has(w)).length + (letter.test(text.toLowerCase()) ? 2 : 0)] as const)
  scores.sort((a, b) => b[1] - a[1])
  return scores[0][1] >= 2 && scores[0][1] > scores[1][1] ? scores[0][0] : undefined
}

/** The language the chat's questions were typed in (quick actions don't count: they're in the device's). */
export function chatLanguage(entries: Entry[]): string | undefined {
  return textLanguage(entries.filter((m) => m.role === "user" && !m.label).map((m) => m.content).join("\n"))
}
