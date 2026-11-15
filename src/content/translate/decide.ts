// Is the page in another language than the person's? (2.7, in-page translation's pill.) Decided on the device from the
// page's own markup and text, nothing is sent (plan section 6: the page's type is told by its markup, its language, its
// length; its text goes nowhere until the person taps).
//
// The text decides when it's clear: `<html lang>` is often left at a template's default ("en" on every page of a
// localized site). The markup decides when the text can't tell: a weak guess (a few short words that happen to be
// another language's, in a language the guess has no words for, like Lithuanian or Azerbaijani), and a language its
// letters or words share with a neighbour (Bulgarian or Kazakh in Cyrillic, Persian in Arabic script, Danish and
// Norwegian, Czech and Slovak, Catalan and Spanish). 2.7, the director's audit: a Turkish reader on a lang="tr" page
// was offered «Translate to Turkish?» because a few of its words are Portuguese ones.

import { baseLanguage, languageGuess } from "../translateTarget"

/** Languages the guess can't tell from a neighbour: a guess of any of them gives way to the page's markup naming
 *  another of the same group. */
const NEIGHBOURS: string[][] = [
  ["ru", "uk", "bg", "sr", "mk", "be", "kk", "ky", "mn", "tg", "uz", "ba", "tt"],
  ["ar", "fa", "ur", "ps", "ug", "sd", "ku"],
  ["zh", "ja", "yue"],
  ["da", "nb", "no", "nn", "sv"],
  ["cs", "sk"],
  ["es", "ca", "gl", "ast"],
  ["pt", "gl"],
  ["id", "ms"],
  ["tr", "az"],
  ["nl", "af"]
]
const neighbours = (a: string, b: string) => NEIGHBOURS.some((group) => group.includes(a) && group.includes(b))

/** Codes that name the same language: Norwegian as "no" or "nb", and the old codes some sites still mark. */
const ALIASES: Record<string, string> = { no: "nb", iw: "he", in: "id", ji: "yi", jw: "jv" }
const canonical = (code: string) => ALIASES[code] ?? code

/** How sure the text's guess must be to overrule the page's markup: a tenth of its words are the language's own. */
export const STRONG_GUESS = 0.1

/** The page's language (a base code), or null when neither its text nor its markup tells. */
export function pageLanguage(htmlLang: string, text: string): string | null {
  const marked = canonical(baseLanguage(htmlLang.trim()))
  const markup = /^[a-z]{2,3}$/.test(marked) ? marked : null
  const guess = languageGuess(text)
  if (!guess) return markup
  if (!markup || guess.lang === markup) return guess.lang
  if (neighbours(guess.lang, markup)) return markup
  return guess.share >= STRONG_GUESS ? guess.lang : markup
}

/** Enough of the page's own words to translate and to judge its language by (not a sign-in form or a gallery). */
export const MIN_LETTERS = 160

/** Offer to translate: the page's language is known and isn't the person's. */
export function offerFor(pageLang: string | null, ui: string, letters: number): boolean {
  if (!pageLang || letters < MIN_LETTERS) return false
  return canonical(pageLang) !== canonical(baseLanguage(ui))
}
