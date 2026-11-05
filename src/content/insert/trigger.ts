// "/phrase" typed in a field opens the quick insert list. Rules (quick-insert plan, §4.2, and the director's audit):
// - only at the start of the field, after a space or on a new line: "and/or", "03/11" and links never open it;
// - a phrase of two characters at least, starting with a letter: "/s" (sarcasm on Reddit) and "/*" (a comment)
//   are ordinary typing; nor in a code editor or after a shell command ("cd /usr");
// - the list shows only when a template's title or keywords match (the caller checks);
// - sites with their own "/" menu (Notion, Slack, GitHub, WordPress…) use "//", and when a site's own menu opens
//   at the caret anyway, ours steps back (the caller checks); the sign can be changed in Settings.

import { closestComposed, shadowRootsOf } from "./shadow.ts"

/** Sites whose editor has its own "/" menu: the sign is doubled there. */
export const SLASH_MENU_SITES = [
  "notion.so", "notion.site", "slack.com", "docs.google.com", "discord.com", "linear.app",
  "atlassian.net", "confluence.com", "clickup.com", "coda.io", "craft.do", "miro.com", "app.asana.com",
  // Comment commands, quick actions, block inserter, chat commands.
  "github.com", "gitlab.com", "wordpress.com", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"
]

export const DEFAULT_SIGN = "/"
/** Longest phrase looked up after the sign. */
const MAX_PHRASE = 40

export function siteHasSlashMenu(host: string, path = ""): boolean {
  const h = host.toLowerCase().replace(/^www\./, "")
  // A WordPress site's own editor, wherever it's hosted; and a GitLab of one's own.
  if (/\/wp-admin\//.test(path) || /^gitlab\./.test(h)) return true
  return SLASH_MENU_SITES.some((site) => h === site || h.endsWith(`.${site}`))
}

/** The sign on this site: "//" where the site has its own "/" menu and the sign is the default one. */
export function signFor(host: string, sign: string, path = ""): string {
  const s = sign.trim() || DEFAULT_SIGN
  return s === DEFAULT_SIGN && siteHasSlashMenu(host, path) ? "//" : s
}

// A line that starts with a shell command (after a prompt sign or sudo, or after ; && |): its "/" is a path.
const SHELL = /(?:^|[;&|]\s*)\s*(?:[$#>]\s*)?(?:sudo\s+)?(?:cd|ls|ll|cat|cp|mv|rm|mkdir|rmdir|touch|vi|vim|nano|less|more|tail|head|chmod|chown|ssh|scp|rsync|curl|wget|git|npm|npx|pnpm|yarn|python3?|node|source|open|find|grep|tar|docker|kubectl)\s/

/**
 * A phrase worth a lookup: two characters at least, starting with a letter (one Chinese, Japanese or
 * Korean character is a word on its own, but two are still asked for); not after a shell command.
 */
export function phraseWorthLooking(phrase: string, before: string): boolean {
  if (phrase.length < 2 || !/^\p{L}/u.test(phrase)) return false
  const line = before.slice(0, before.length - phrase.length - 1).split(/[\n\r]/).pop() ?? ""
  return !SHELL.test(line)
}

/** A code editor or a code block: "/" there is code, not a phrase. */
export function codeField(el: Element): boolean {
  return Boolean(closestComposed(el, "pre,code,.cm-editor,.CodeMirror,.monaco-editor,.ace_editor,[data-language],[class*='code-editor'],[class*='CodeEditor']"))
}

export interface Typed {
  /** What's typed after the sign (may be empty right after it). */
  phrase: string
  /** Characters to replace: the sign and the phrase. */
  length: number
}

/**
 * The phrase typed after the sign right before the caret, or null. `before`: the field's text up to the
 * caret. The phrase is a few words of letters and digits; a second sign, a link or a path ends it.
 */
export function typedPhrase(before: string, sign: string): Typed | null {
  if (!sign) return null
  const at = before.lastIndexOf(sign)
  if (at === -1) return null
  const prev = at === 0 ? "" : before[at - 1]
  // Start of the field, after a space or a line break (a non-breaking one too). "//" with the sign "/"
  // (a link, a comment) and "03/11" stop here: the last sign follows a character.
  if (prev !== "" && !/[\s ]/.test(prev)) return null
  const phrase = before.slice(at + sign.length)
  if (phrase.length > MAX_PHRASE) return null
  // A phrase starts right after the sign and has no line breaks or slashes.
  if (/^[\s ]/.test(phrase) || /[\n\r/\\]/.test(phrase)) return null
  return { phrase, length: sign.length + phrase.length }
}

/**
 * The site's own menu is open at the field: the field an expanded combobox, or a visible listbox or menu right
 * by it (its "/" commands, an autocomplete). Ours then steps back instead of lying over it.
 */
export function siteMenuOpen(field: { el: Element }): boolean {
  const el = field.el
  if (el.getAttribute("aria-expanded") === "true" || closestComposed(el, "[role=combobox][aria-expanded='true']")) return true
  const doc = el.ownerDocument
  const r = el.getBoundingClientRect()
  // The page, and the shadow roots the field is in (a site's menu there is drawn next to its field).
  const menus = [doc, ...shadowRootsOf(el)].flatMap((scope) => Array.from(scope.querySelectorAll("[role=listbox],[role=menu]")))
  for (const menu of menus) {
    const b = menu.getBoundingClientRect()
    if (!b.width || !b.height) continue
    const style = doc.defaultView?.getComputedStyle(menu)
    if (style && (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)) continue
    if (b.right > r.left && b.left < r.right && b.top < r.bottom + 320 && b.bottom > r.top - 320) return true
  }
  return false
}
