// A collection's PDF (2.7 «Подборки», plan section 2): one printable page. The panel's «PDF» opens it in a tab
// (src/pages/collection.ts) to save or print; the app builds the same page (BoardPDF.swift). Under the title a line
// links to the site; each card links its source and «Открыть чат в ContextFlow» (the site's /open-chat opens the chat in
// the app, or the App Store without it, the owner's decision); the footer «Сделано в ContextFlow · context-flow.app»
// is on every printed page.

import { cardsIn, hostOf, liveSections, type Card, type Collection } from "./collections.ts"

export { hostOf }

export const SITE = "https://context-flow.app"

/** «Открыть чат в ContextFlow»: the site's page that opens chat `chat` (at message `msg`) in the app. */
export function openChatLink(chat: string, msg?: string): string {
  return `${SITE}/open-chat?id=${encodeURIComponent(chat)}${msg ? `&m=${encodeURIComponent(msg)}` : ""}`
}

/** The page's words in the reader's language (the panel's strings: colPdf*). */
export interface PageWords {
  // "12 cards"
  cards: string
  // "12 November 2026"
  date: string
  // "made with" … the link "ContextFlow — AI for Safari"
  madeWith: string
  brand: string
  // "Summary"
  summary: string
  // "Comparison"
  comparison: string
  // "Open chat in ContextFlow"
  openChat: string
  // "Made with ContextFlow"
  footer: string
  lang: string
  rtl?: boolean
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c])

const web = (url: string | undefined): string | null => (url && /^https?:\/\/[^\s"<>]+$/i.test(url) ? url : null)


/** The chat a card goes back to: its own; a comparison's, the first compared card's. */
function chatOf(card: Card, rec: Collection): { chat: string; msg?: string } | null {
  if (card.chat) return { chat: card.chat, msg: card.msg }
  for (const id of card.of ?? []) {
    const c = rec.c.find((x) => x.id === id && !x.d && x.chat)
    if (c?.chat) return { chat: c.chat, msg: c.msg }
  }
  return null
}

function cardHtml(card: Card, rec: Collection, w: PageWords): string {
  const links: string[] = []
  const src = web(card.src?.url)
  if (src) links.push(`<a href="${esc(src)}">${esc(hostOf(src) || src)}&nbsp;↗</a>`)
  const back = chatOf(card, rec)
  if (back) links.push(`<a href="${esc(openChatLink(back.chat, back.msg))}">${esc(w.openChat)}&nbsp;↗</a>`)
  let body = `<p class="gist" dir="auto">${esc(card.t)}</p>`
  if (card.k === "compare" && card.tbl) {
    const head = card.tbl.h.map((h) => `<th dir="auto">${esc(h)}</th>`).join("")
    const rows = card.tbl.r.map((r) => `<tr>${r.map((v) => `<td dir="auto">${esc(v)}</td>`).join("")}</tr>`).join("")
    body = `<p class="gist"><b>${esc(w.comparison)}.</b> <span dir="auto">${esc(card.t)}</span></p>`
      + `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
      // The note is the card's gist when the AI gave one: not twice.
      + (card.tbl.note && card.tbl.note !== card.t ? `<p class="note" dir="auto">${esc(card.tbl.note)}</p>` : "")
  }
  const tags = card.tags?.length ? `<p class="tags">${card.tags.map((x) => `<span dir="auto">${esc(x)}</span>`).join("")}</p>` : ""
  return `<div class="card">${body}${tags}${links.length ? `<p class="links">${links.join("")}</p>` : ""}</div>`
}

/** The page's body: title, the line with the site's link, the summary, each section with its cards, the footer. */
export function collectionHtml(rec: Collection, w: PageWords): string {
  const sections = liveSections(rec)
    .map((s) => ({ s, cards: cardsIn(rec, s.id) }))
    .filter((x) => x.cards.length > 0)
    .map(({ s, cards }) => `<section><h2 dir="auto">${esc(s.n)}</h2>${cards.map((c) => cardHtml(c, rec, w)).join("")}</section>`)
    .join("")
  const sum = rec.sum?.t ? `<div class="sum"><b>${esc(w.summary)}.</b> <span dir="auto">${esc(rec.sum.t)}</span></div>` : ""
  return `<main><h1 dir="auto">${esc(rec.n)}</h1>`
    + `<p class="meta">${esc(w.cards)} · ${esc(w.date)} · ${esc(w.madeWith)} <a href="${SITE}">${esc(w.brand)}</a></p>`
    + sum + sections + `</main>`
    + `<footer>${esc(w.footer)} · <a href="${SITE}">context-flow.app</a></footer>`
}

/** The page's styles: light, for paper; the footer fixed in print, so each page has it. */
export const PAGE_CSS = `
@page { margin: 16mm 16mm 20mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: #fff; color: #17151c; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 28px 20px 24px; }
h1 { font-size: 30px; line-height: 1.15; margin: 0 0 8px; letter-spacing: -0.01em; }
.meta { color: #5d5a66; font-size: 14px; margin: 0 0 18px; }
a { color: #2563eb; }
.sum { background: #eef2fb; border-radius: 12px; padding: 12px 16px; margin: 0 0 8px; }
section { border-top: 2px solid #17151c; padding-top: 12px; margin-top: 22px; }
h2 { font-size: 17px; margin: 0 0 4px; break-after: avoid; }
.card { padding: 10px 0; border-bottom: 1px solid #e6e4ec; break-inside: avoid; }
.card p { margin: 0 0 4px; }
.links a { font-size: 13.5px; margin-inline-end: 18px; }
.tags span { display: inline-block; font-size: 12px; color: #5d5a66; background: #f1f0f5; border-radius: 6px; padding: 1px 7px; margin-inline-end: 6px; }
table { border-collapse: collapse; margin: 6px 0; font-size: 13.5px; width: 100%; }
th, td { border: 1px solid #e0dee8; padding: 5px 8px; text-align: start; vertical-align: top; }
th { background: #f6f5f9; }
.note { color: #5d5a66; font-size: 13.5px; }
footer { max-width: 760px; margin: 0 auto; padding: 14px 20px 28px; color: #5d5a66; font-size: 13px; border-top: 1px solid #e6e4ec; }
.bar { position: sticky; top: 0; display: flex; justify-content: center; gap: 10px; padding: 10px; background: rgba(246, 245, 249, 0.94); border-bottom: 1px solid #e6e4ec; }
.bar button { font: inherit; font-weight: 600; border: 0; border-radius: 10px; padding: 9px 18px; background: #2563eb; color: #fff; cursor: pointer; }
/* The app draws its own footer on each page (BoardPDF.swift on iOS). */
body.native footer { display: none; }
body.native main { padding: 0; max-width: none; }
@media print {
  .bar { display: none; }
  main { padding: 0; max-width: none; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; max-width: none; padding: 6px 0 0; background: #fff; }
}
`
