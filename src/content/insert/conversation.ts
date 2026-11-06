// The conversation a reply box belongs to (2.5 (81), the owner on LinkedIn's messages: "Fill" put in "Hi Nikola" in a
// conversation with Olga; the whole page went to the AI, with the list of conversations on the left). What the AI gets
// for a reply is the conversation around the field: its title (the person's name above it) and its latest messages,
// not the page around them. Found by structure, not by one site's classes: going up from the field, the first
// ancestor that holds, before the field, a container of messages (role="log", or named so in its label, id or class:
// messages, conversation, chat, thread, comments); its title is the heading-like element before that container. A
// list of other conversations sits higher up, beside the one that's open, so it's never reached. No such container:
// null, and the page goes as before. No imports but shadow.ts, so the tests load it as it is.

import { shadowRootOf } from "./shadow.ts"

export interface Conversation {
  // The person or the group, as the conversation's heading names it ("" when there's none).
  title: string
  // Its latest messages, as they read on the page.
  text: string
}

const MESSAGES = /messag|\bmsg-s-|conversation|convo|chat|thread|comment|replies|dialog|сообщен|переписк|диалог|коммент/i
const HEADING = /title|header|heading|name|entity|lockup|profile|participant|contact|recipient/i
// Lists of conversations, rather than one conversation: their items name people, not what they wrote.
const LIST_OF = /conversations-list|conversation-list|threads-list|thread-list|inbox|contacts|people/i

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

/** A container of messages: a log, or named so (and not a list of conversations, nor a row of suggested replies). */
function isMessages(el: Element): boolean {
  const name = label(el)
  if (el.getAttribute("role") !== "log" && (!MESSAGES.test(name) || LIST_OF.test(name))) return false
  return outsideButtons(el).length >= 2
}

/** Its text without what its buttons say (suggested replies are all buttons). */
function outsideButtons(el: Element): string {
  let text = words(el)
  for (const b of Array.from(el.querySelectorAll("button, [role=button]"))) text = text.replace(words(b), "")
  return text.trim()
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
 * the field: the outermost named one in the last of the preceding children that has any.
 */
function messagesIn(scope: Element, branch: Element): Element | null {
  const prior = kids(scope).filter((c) => c !== branch && before(c, branch))
  for (let i = prior.length - 1; i >= 0; i--) {
    const c = prior[i]
    const found = isMessages(c) ? c : Array.from(c.querySelectorAll("*")).find(isMessages)
    if (found) return found
  }
  return null
}

/** A heading-like element: an h1–h4, role="heading", or named as a title; short, not inside a list item. */
function isHeading(el: Element): boolean {
  const tag = el.tagName.toUpperCase()
  const named = /^H[1-4]$/.test(tag) || el.getAttribute("role") === "heading" || HEADING.test(label(el))
  if (!named || el.closest("li, [role=listitem], [role=option]")) return false
  const text = words(el)
  return text.length > 0 && text.length <= 120
}

/** The conversation's heading: in `scope` before the messages, else just above `scope` (two levels at most). */
function titleFor(scope: Element, messages: Element): string {
  const inScope = Array.from(scope.querySelectorAll("*")).find((el) => !el.contains(messages) && before(el, messages) && !messages.contains(el) && isHeading(el))
  if (inScope) return firstLine(inScope)
  let child: Element = scope
  for (let level = 0; level < 2; level++) {
    const parent = up(child)
    if (!parent) break
    for (const sibling of kids(parent).filter((c) => c !== child && before(c, child)).reverse()) {
      const list = sibling.querySelector("[role=list], ul, ol")
      if (LIST_OF.test(label(sibling)) || (list && list.querySelectorAll("li, [role=listitem]").length >= 3)) continue
      const heading = isHeading(sibling) ? sibling : Array.from(sibling.querySelectorAll("*")).find(isHeading)
      if (heading) return firstLine(heading)
    }
    child = parent
  }
  return ""
}

function firstLine(el: Element): string {
  return words(el).split("\n")[0].trim().slice(0, 120)
}

/** The conversation `field` replies in, or null when it isn't in one (a form, a search, a post of one's own). */
export function conversationAround(field: Element, maxChars = 6000): Conversation | null {
  let branch: Element = field
  for (let depth = 0; depth < 16; depth++) {
    const scope = up(branch)
    if (!scope || scope.tagName.toUpperCase() === "BODY" || scope.tagName.toUpperCase() === "HTML") return null
    const messages = messagesIn(scope, branch)
    if (messages) {
      const text = words(messages)
      return { title: titleFor(scope, messages), text: text.length > maxChars ? text.slice(-maxChars) : text }
    }
    branch = scope
  }
  return null
}

/** What the AI reads for a reply: the conversation's title first, then its messages. */
export function conversationText(c: Conversation): string {
  return c.title ? `Conversation with: ${c.title}\n\n${c.text}` : c.text
}
