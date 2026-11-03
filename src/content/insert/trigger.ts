// "/phrase" typed in a field opens the quick insert list. Rules (quick-insert plan, §4.2):
// - only at the start of the field, after a space or on a new line: "and/or", "03/11" and links never open it;
// - the list shows only when something matches (the caller checks);
// - sites with their own "/" menu (Notion, Slack, Google Docs…) use "//"; the sign can be changed in Settings.

/** Sites whose editor has its own "/" menu: the sign is doubled there. */
export const SLASH_MENU_SITES = [
  "notion.so", "notion.site", "slack.com", "docs.google.com", "discord.com", "linear.app",
  "atlassian.net", "confluence.com", "clickup.com", "coda.io", "craft.do", "miro.com", "app.asana.com"
]

export const DEFAULT_SIGN = "/"
/** Longest phrase looked up after the sign. */
const MAX_PHRASE = 40

export function siteHasSlashMenu(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "")
  return SLASH_MENU_SITES.some((site) => h === site || h.endsWith(`.${site}`))
}

/** The sign on this site: "//" where the site has its own "/" menu and the sign is the default one. */
export function signFor(host: string, sign: string): string {
  const s = sign.trim() || DEFAULT_SIGN
  return s === DEFAULT_SIGN && siteHasSlashMenu(host) ? "//" : s
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
