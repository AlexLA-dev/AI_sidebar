// The conversation a reply box belongs to. "Fill from the page" and the rewrite read it instead of the whole page, so a
// name from a list of other conversations beside it never ends up in the reply: its title (the person, the group or
// the subject) and its latest messages.
//
// Found for any site by what the page says about itself, not by one site's class names:
// - going up from the field, the first ancestor that holds, before the field, a container of messages; or that is one
//   itself, when the box sits at the end of the conversation (as a mail's reply does);
// - a container of messages: role="log" or "feed", a live region (aria-live), or a list (role="list"/"grid"/
//   "application", <ul>, <ol>) or any block whose items carry the times they were sent (<time>, datetime, "15:38",
//   "3:38 PM"), or one whose label, id or class names it so, in any of the app's 14 languages (CONVERSATION_WORDS);
//   never a list of choices (options, tabs, a row of suggested replies: all buttons);
// - its title: what aria-labelledby points at, else the heading before the messages (h1–h6, role="heading", <header>,
//   role="banner", or a block named title / header / subject / name), else the region's own label.
// A list of other conversations sits beside the open one, higher up, so it's never reached. No conversation found:
// null, and the page goes as before.
//
// A site whose page says too little for this gets its own signs in SITE_SIGNS, each entry with the reason and a
// fixture in tests/insert-conversation.test.mts. No imports but shadow.ts, so the tests load it as it is.

import { shadowRootOf } from "./shadow.ts"

export interface Conversation {
  // The person, the group or the subject, as the conversation's heading names it ("" when there's none).
  title: string
  // Its messages up to the reply box, as they read on the page: the last of them is the one being answered.
  text: string
  // A reply box in the middle of a thread (a mail answered while later ones sit under it): the messages after the
  // box, written later than the one being answered. "" when the box is at the conversation's end.
  after: string
}

/**
 * Words that name a conversation or its messages in labels (aria-label, id, class), in every language the app speaks:
 * a site's own labels are in its reader's language. Stems, matched without case.
 */
export const CONVERSATION_WORDS: Record<string, string[]> = {
  en: ["messag", "conversation", "convo", "chat", "thread", "comment", "replies", "dialog", "inbox"],
  ru: ["сообщен", "переписк", "диалог", "беседа", "чат", "коммент"],
  uk: ["повідомлен", "листуван", "діалог", "розмов", "чат", "комент"],
  de: ["nachricht", "unterhaltung", "konversation", "verlauf", "kommentar"],
  fr: ["discussion", "commentaire", "fil de"],
  es: ["mensaje", "conversaci", "comentario"],
  it: ["messaggi", "conversazion", "discussion", "comment"],
  pt_BR: ["mensage", "conversa", "comentári", "comentari"],
  ja: ["メッセージ", "会話", "チャット", "トーク", "スレッド", "コメント"],
  ko: ["메시지", "대화", "채팅", "댓글", "스레드"],
  zh_CN: ["消息", "对话", "会话", "聊天", "评论"],
  zh_TW: ["訊息", "對話", "會話", "聊天", "留言", "評論"],
  ar: ["رسائل", "رسالة", "محادثة", "دردشة", "تعليق"],
  vi: ["tin nhắn", "trò chuyện", "hội thoại", "bình luận"],
  tr: ["mesaj", "ileti", "sohbet", "konuşma", "yorum"]
}

/**
 * Sites whose pages don't say enough for the rules above: a host, the selectors of their messages container and of
 * its title, and why. Each entry has a fixture in tests/insert-conversation.test.mts. None is needed for the messengers
 * the tests cover (Gmail, WhatsApp, Telegram, Slack, Messenger, LinkedIn): their roles, labels and times are enough.
 */
export const SITE_SIGNS: Array<{ host: RegExp; messages: string; title?: string; why: string }> = [
  {
    host: /^mail\.google\.com$/,
    messages: "[role=main] [role=list]",
    title: "[role=main] h2",
    why: "2.7 (107): a thread of one mail has one date, so nothing says it's a conversation; Gmail's reply box sits inside the item of the mail being answered, and its dates read 'Nov 14, 2026, 4:42 PM (1 day ago)'."
  }
]

const WORDS = new RegExp(Object.values(CONVERSATION_WORDS).flat().map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
// Class and id words developers use for a heading, whatever the page's language.
const HEADING_CLASS = /title|header|heading|subject|\bname\b|[-_]name|name[-_]/i
// A time a message was sent: 15:38, 3:38 PM, 15.38, with Arabic-Indic digits too; short, on its own.
const TIME = /(^|[^\d٠-٩])([01]?[\d٠-٩]|2[0-3٠-٣])[:.][0-5٠-٥][\d٠-٩](?![\d٠-٩])/
// The same inside a date ("Nov 14, 2026, 4:42 PM (1 day ago)", «14 нояб. 2026 г., 16:42 (1 день назад)»: Gmail, 2.7
// (107)): with a colon only, so a price in a longer line ("from 12.50 a month") is never taken for one.
const TIME_IN_DATE = /(^|[^\d٠-٩:])([01]?[\d٠-٩]|2[0-3٠-٣]):[0-5٠-٥][\d٠-٩](?![\d٠-٩:])/
const CHOICES = "[role=option], [role=tab], [role=treeitem], [aria-selected]"

/** The parent, across a shadow root (its host). */
function up(el: Element): Element | null {
  return el.parentElement ?? shadowRootOf(el)?.host ?? null
}

function words(el: Element): string {
  const text = (el as HTMLElement).innerText ?? el.textContent ?? ""
  return text.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim()
}

function label(el: Element): string {
  const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? ""
  return `${el.getAttribute("aria-label") ?? ""} ${el.id} ${cls}`
}

/** Its text without what its buttons say (a row of suggested replies is all buttons). */
function outsideButtons(el: Element): string {
  let text = words(el)
  for (const b of Array.from(el.querySelectorAll("button, [role=button]"))) text = text.replace(words(b), "")
  return text.trim()
}

/** How many times a message was sent are shown inside: <time>, [datetime], or a short text that is a time. */
function times(el: Element): number {
  let n = el.querySelectorAll("time, [datetime]").length
  if (n >= 2) return n
  for (const e of Array.from(el.querySelectorAll("*"))) {
    if (e.children.length) continue
    const text = (e.textContent ?? "").trim()
    if (text.length <= 24 ? TIME.test(text) : text.length <= 64 && TIME_IN_DATE.test(text)) n++
    if (n >= 2) break
  }
  return n
}

/** A list of choices (conversations to pick, tabs): most of its items can be selected. */
function isChoices(el: Element): boolean {
  const items = el.querySelectorAll("[role=listitem], [role=row], li, [role=option], [role=tab], [role=treeitem]")
  if (!items.length) return false
  const choices = el.querySelectorAll(CHOICES).length
  return choices * 2 >= items.length
}

/** A container of messages, by its role, its live region, its times or its name; never a list of choices. */
function isMessages(el: Element): boolean {
  const role = el.getAttribute("role") ?? ""
  const live = el.getAttribute("aria-live")
  const said = role === "log" || role === "feed" || (live !== null && live !== "off") || WORDS.test(label(el))
  if (!said && times(el) < 2) return false
  if (isChoices(el)) return false
  return outsideButtons(el).length >= 2
}

/** Whether `a` comes before `b` in their tree (an ancestor comes before what it holds); false across trees. */
function before(a: Node, b: Node): boolean {
  const chain = (n: Node) => {
    const nodes: Node[] = []
    for (let x: Node | null = n; x; x = x.parentNode) nodes.unshift(x)
    return nodes
  }
  const pa = chain(a)
  const pb = chain(b)
  if (pa[0] !== pb[0]) return false
  let i = 0
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++
  if (i === pa.length) return true
  if (i === pb.length) return false
  const siblings = Array.from(pa[i - 1].childNodes)
  return siblings.indexOf(pa[i] as ChildNode) < siblings.indexOf(pb[i] as ChildNode)
}

/** The children of `scope` and of its own root, if it's a host. */
function kids(scope: Element): Element[] {
  const own = Array.from(scope.children)
  const root = (scope as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
  return root ? [...own, ...Array.from(root.children)] : own
}

/**
 * The messages container inside `scope`, before `branch` (the child of scope the field is in), the nearest one above
 * the field: the outermost one in the last of the preceding children that holds one.
 */
function messagesIn(scope: Element, branch: Element): Element | null {
  const prior = kids(scope).filter((c) => c !== branch && before(c, branch))
  for (let i = prior.length - 1; i >= 0; i--) {
    const c = prior[i]
    if (isMessages(c)) return c
    const found = Array.from(c.querySelectorAll("*")).find(isMessages)
    if (found) return found
  }
  return null
}

/** A heading-like element, not inside a list item (a list's items name people, not the open conversation). */
function isHeading(el: Element): boolean {
  const tag = el.tagName.toUpperCase()
  const role = el.getAttribute("role")
  const named = /^H[1-6]$/.test(tag) || role === "heading" || tag === "HEADER" || role === "banner" || HEADING_CLASS.test(label(el))
  if (!named || el.closest("li, [role=listitem], [role=option], [role=row]")) return false
  const text = words(el)
  return text.length > 0 && text.length <= 200
}

/** The first text in `el` that reads as a name: not a one- or two-letter avatar ("OP"). */
function firstText(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, 4)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").replace(/\s+/g, " ").trim()
    if (text && !/^[A-Z]{1,2}$/.test(text)) return text.slice(0, 120)
  }
  return ""
}

/** The title inside a heading region: its own heading, a block whose title attribute is its text, a named block, its first text. */
function titleIn(region: Element): string {
  const tag = region.tagName.toUpperCase()
  if (/^H[1-6]$/.test(tag) || region.getAttribute("role") === "heading") return firstText(region)
  const inner = Array.from(region.querySelectorAll("*"))
  const heading = inner.find((el) => /^H[1-6]$/.test(el.tagName.toUpperCase()) || el.getAttribute("role") === "heading")
  if (heading) return firstText(heading)
  const titled = inner.find((el) => { const t = el.getAttribute("title"); return Boolean(t && t.trim() && words(el) === t.trim()) })
  if (titled) return firstText(titled)
  const named = inner.find((el) => HEADING_CLASS.test(label(el)) && words(el))
  return firstText(named ?? region)
}

/** The conversation's title: what labels its messages, the heading before them, or its region's own label. */
function titleFor(scope: Element, messages: Element): string {
  for (const el of [messages, scope]) {
    const ids = el.getAttribute("aria-labelledby")
    const root = el.getRootNode() as Document | ShadowRoot
    const named = ids?.split(/\s+/).map((id) => root.getElementById?.(id)).find(Boolean)
    if (named && words(named)) return firstText(named)
  }
  const inScope = Array.from(scope.querySelectorAll("*")).find((el) => !el.contains(messages) && !messages.contains(el) && before(el, messages) && isHeading(el))
  if (inScope) return titleIn(inScope)
  let child: Element = scope
  for (let level = 0; level < 2; level++) {
    const parent = up(child)
    if (!parent) break
    for (const sibling of kids(parent).filter((c) => c !== child && before(c, child)).reverse()) {
      const list = sibling.querySelector("[role=list], [role=grid], ul, ol")
      if (isChoices(sibling) || (list && list.querySelectorAll("li, [role=listitem], [role=row]").length >= 3)) continue
      const heading = isHeading(sibling) ? sibling : Array.from(sibling.querySelectorAll("*")).find(isHeading)
      if (heading) return titleIn(heading)
    }
    child = parent
  }
  // A region that labels itself ("Conversation with …"): its words, as the site wrote them.
  for (let el: Element | null = messages; el; el = up(el)) {
    const role = el.getAttribute("role")
    const own = el.getAttribute("aria-label")
    if (own && (role === "main" || role === "region" || role === "dialog" || role === "complementary" || el === messages)) return own.slice(0, 120)
    if (el === scope) break
  }
  return ""
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text
}

/** How much of what came after the message being answered goes along. */
const AFTER_CHARS = 1500

/**
 * A messages container with the reply box inside it: what reads before the box and what reads after it, in the page's
 * order. The container's own items go whole; inside the item that holds the box (a mail with its reply box under it),
 * only what reads as a message does (it shows when it was sent, or has a sentence's worth of text): never the box's
 * own recipients, buttons and toolbar.
 */
function aroundBox(messages: Element, field: Element): { before: string; after: string } {
  const path: Element[] = []
  for (let el: Element | null = field; el && el !== messages; el = up(el)) path.unshift(el)
  const before: string[] = []
  const after: string[] = []
  let parent = messages
  for (const child of path) {
    const top = parent === messages
    const keep = (el: Element): string => {
      const text = words(el)
      return text && (top || text.length >= 40 || times(el) >= 1) ? text : ""
    }
    const siblings = kids(parent)
    const at = siblings.indexOf(child)
    before.push(...siblings.slice(0, at).map(keep).filter(Boolean))
    after.unshift(...siblings.slice(at + 1).map(keep).filter(Boolean))
    parent = child
  }
  return { before: before.join("\n"), after: after.join("\n") }
}

/** The conversation of a messages container: around the box when the box is inside it, else all of it. */
function conversationOf(title: string, messages: Element, field: Element, maxChars: number): Conversation {
  if (!contains(messages, field)) return { title, text: clip(words(messages), maxChars), after: "" }
  const { before, after } = aroundBox(messages, field)
  // The box above every message (a comment box atop its thread): the thread is what's answered.
  if (!before.trim()) return { title, text: after.slice(0, maxChars), after: "" }
  return { title, text: clip(before, maxChars), after: after.slice(0, AFTER_CHARS) }
}

/** Whether `el` is inside `box`, across shadow roots. */
function contains(box: Element, el: Element): boolean {
  for (let x: Element | null = el; x; x = up(x)) if (x === box) return true
  return false
}

/** The site's own signs, when it has an entry in SITE_SIGNS. */
function bySite(field: Element, maxChars: number): Conversation | null {
  const host = field.ownerDocument.defaultView?.location?.hostname ?? ""
  const site = SITE_SIGNS.find((s) => s.host.test(host))
  if (!site) return null
  const root = field.getRootNode() as Document | ShadowRoot
  // The one that holds the reply box (a page can have other lists), else the first.
  const all = Array.from(root.querySelectorAll(site.messages))
  const messages = all.find((m) => contains(m, field)) ?? all[0]
  if (!messages) return null
  const title = site.title ? root.querySelector(site.title) : null
  const found = conversationOf(title ? firstText(title) : "", messages, field, maxChars)
  // Nothing to answer (a new mail's own window): not a conversation.
  return found.text.trim() ? found : null
}

const MAX_DEPTH = 60

/** The conversation `field` replies in, or null when it isn't in one (a form, a search, a post of one's own). */
export function conversationAround(field: Element, maxChars = 6000): Conversation | null {
  const site = bySite(field, maxChars)
  if (site) return site
  let branch: Element = field
  // Up to the page's body: Gmail's thread list is 19 levels above its editor (2.7 (107); a limit of 16 never reached it).
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const scope = up(branch)
    if (!scope || scope.tagName.toUpperCase() === "BODY" || scope.tagName.toUpperCase() === "HTML") return null
    const messages = messagesIn(scope, branch)
    if (messages) return { title: titleFor(scope, messages), text: clip(words(messages), maxChars), after: "" }
    // The box inside the conversation itself (a mail's reply under the mail it answers, at the thread's end or in its
    // middle): the messages before the box, the answered one last, and apart from them the ones after it.
    if (isMessages(scope) && kids(scope).filter((c) => c !== branch).some((c) => words(c))) {
      return conversationOf(titleFor(up(scope) ?? scope, scope), scope, field, maxChars)
    }
    branch = scope
  }
  return null
}

/** What the AI reads for a reply: the conversation's title first, then its messages up to the reply box. */
export function conversationText(c: Conversation): string {
  return c.title ? `Conversation: ${c.title}\n\n${c.text}` : c.text
}
