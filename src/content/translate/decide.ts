// Is the page in another language than the person's? (2.7, in-page translation's pill.) Decided on the device from the
// page's own markup and text, nothing is sent (plan section 6: the page's type is told by its markup, its language, its
// length; its text goes nowhere until the person taps).
//
// The text decides when it's clear: `<html lang>` is often left at a template's default ("en" on every page of a
// localized site). The markup decides when the text can't tell (a Latin-script language the guess doesn't know, like
// Turkish, Dutch or Polish) and for a language its letters share with another (Bulgarian, Serbian or Kazakh in
// Cyrillic, Persian or Urdu in Arabic script).

import { baseLanguage, guessLanguage } from "../translateTarget"

/** Languages whose letters the guess reads as another's (it says "ru" for all Cyrillic it doesn't know as Ukrainian). */
const SAME_LETTERS: Record<string, string[]> = {
  ru: ["bg", "sr", "mk", "be", "kk", "ky", "mn", "tg", "uz", "ba", "tt"],
  uk: ["bg", "sr", "mk", "be", "kk", "ky", "mn", "tg", "uz", "ba", "tt"],
  ar: ["fa", "ur", "ps", "ug", "sd", "ku"],
  zh: ["ja", "yue"]
}

/** The page's language (a base code), or null when neither its text nor its markup tells. */
export function pageLanguage(htmlLang: string, text: string): string | null {
  const marked = baseLanguage(htmlLang.trim())
  const markup = /^[a-z]{2,3}$/.test(marked) ? marked : null
  const guessed = guessLanguage(text)
  if (guessed && markup && SAME_LETTERS[guessed]?.includes(markup)) return markup
  return guessed ?? markup
}

/** Enough of the page's own words to translate and to judge its language by (not a sign-in form or a gallery). */
export const MIN_LETTERS = 160

/** Offer to translate: the page's language is known and isn't the person's. */
export function offerFor(pageLang: string | null, ui: string, letters: number): boolean {
  if (!pageLang || letters < MIN_LETTERS) return false
  return pageLang !== baseLanguage(ui)
}
