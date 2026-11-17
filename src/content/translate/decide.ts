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

import { baseLanguage, GUESSED, languageGuess, wordHits } from "../translateTarget"
import { scripts } from "./share"

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

// ------------------------------------------------------------------ build 107: by shares of the page (share.ts)

/** The main content's share in another language from which the pill offers itself (A5, measured on real pages:
 *  see tests/translate-share.test.mts and the PR for the numbers). */
export const OFFER_SHARE = 0.5
/** A smaller part of the page in another language, said at the ✦ entry: at least this share of the page's words... */
export const PART_SHARE = 0.05
/** ...and this many letters (a few foreign names aren't a part to translate). */
export const PART_LETTERS = 150

interface ShareMap {
  langs: Map<string, number>
  letters: number
}

const known = (s: ShareMap) => s.letters - (s.langs.get("?") ?? 0)
const lettersOf = (s: ShareMap, lang: string) => [...s.langs].reduce((n, [l, k]) => n + (l !== "?" && canonical(baseLanguage(l)) === canonical(baseLanguage(lang)) ? k : 0), 0)
function topBesides(s: ShareMap, reader: string): { lang: string; letters: number } | null {
  let best: { lang: string; letters: number } | null = null
  for (const [l, n] of s.langs) {
    if (l === "?" || canonical(baseLanguage(l)) === canonical(baseLanguage(reader))) continue
    if (!best || n > best.letters) best = { lang: l, letters: n }
  }
  return best
}

/** A guessed language, or the page's markup when it names a neighbour the guess can't tell apart (Persian for Arabic
 *  letters, Norwegian for Danish words). */
function refined(lang: string, htmlLang: string): string {
  const marked = canonical(baseLanguage(htmlLang.trim()))
  return /^[a-z]{2,3}$/.test(marked) && marked !== lang && neighbours(lang, marked) ? marked : lang
}

export interface Judged {
  // The main content is in another language: the pill offers itself, from this language.
  from: string | null
  // A smaller part of the page is: its language and share of the page's words, for the ✦ entry.
  part: { lang: string; share: number } | null
}

/**
 * The page's language against the reader's, by letters (build 107): the pill only when its main content is mostly in
 * another language; a smaller part said at the entry. A page whose words the guess can't place (a language with no
 * function words of its own, like Lithuanian) goes by its markup.
 */
export function judgeShares(mainContent: ShareMap, page: ShareMap, reader: string, htmlLang: string): Judged {
  const me = canonical(baseLanguage(reader))
  // A page with no main content to speak of (a <main> around a search box, none at all) is judged as a whole.
  const main = mainContent.letters >= MIN_LETTERS ? mainContent : page
  const mainKnown = known(main)
  if (mainKnown >= MIN_LETTERS) {
    const foreign = 1 - lettersOf(main, me) / mainKnown
    const top = topBesides(main, me)
    if (foreign >= OFFER_SHARE && top) return { from: refined(top.lang, htmlLang), part: null }
  } else {
    // Words the guess can't place go by the markup only when it names a language the guess has no words for
    // (Lithuanian): an English web app of short labels marked lang="ru" or lang="de" isn't Russian or German, or the
    // guess would have known it (the owner's «99% страницы и так на нужном языке»).
    const marked = canonical(baseLanguage(htmlLang.trim()))
    if ((main.langs.get("?") ?? 0) >= MIN_LETTERS && /^[a-z]{2,3}$/.test(marked) && marked !== me && !GUESSED.has(marked)) return { from: marked, part: null }
  }
  const pageKnown = known(page)
  const top = topBesides(page, me)
  if (top && pageKnown && top.letters / pageKnown >= PART_SHARE && top.letters >= PART_LETTERS) {
    return { from: null, part: { lang: refined(top.lang, htmlLang), share: top.letters / pageKnown } }
  }
  return { from: null, part: null }
}

// ------------------------------------------------------------------ the page's controls, judged on their own

/** The script a language is written in, where it isn't Latin (as share.ts scripts() names them). */
const SCRIPT_OF: Record<string, string> = {
  ru: "cyr", uk: "cyr", bg: "cyr", sr: "cyr", mk: "cyr", be: "cyr", kk: "cyr", ky: "cyr", mn: "cyr", tg: "cyr",
  el: "el", ar: "ar", fa: "ar", ur: "ar", ps: "ar", he: "he", yi: "he", th: "th", ja: "cjk", zh: "cjk", ko: "ko"
}

/** Labels in another script than the reader's (Greek buttons on an English page) from which the pill offers to
 *  translate the controls... */
export const CONTROLS_SCRIPT = 3
/** ...or labels of several words with another language's function words (Latin letters), or with Ukrainian's own
 *  letters for a reader of Russian: at least this many, and this share of the labels of that kind. A single word
 *  («OK», «Login», «Sale», a brand) is never counted: every site has those. */
export const CONTROLS_WORDS = 4
export const CONTROLS_WORDS_SHARE = 0.15
/** The entry by the circle needs less: one label in another script, two the word lists place without doubt. */
export const ENTRY_SCRIPT = 1
export const ENTRY_WORDS = 2

export interface ControlsJudged {
  // The language most of the foreign controls are in, how many labels, and whether that's enough for the pill to
  // offer by itself (else only the entry by the circle).
  lang: string
  labels: number
  offer: boolean
}

/**
 * The page's controls against the reader's language, whatever their share of the page (build 107, the owner:
 * «критично важно понимать на что ты нажимаешь»): the labels of its shown buttons, menus, tabs, short links, form
 * labels, placeholders and dialog titles (share.ts controlLabels). Another script than the reader's is a strong sign;
 * the same script needs labels of several words that the word lists agree on.
 */
export function judgeControls(labels: readonly string[], reader: string, htmlLang = ""): ControlsJudged | null {
  const me = canonical(baseLanguage(reader))
  const mine = SCRIPT_OF[me] ?? "latin"
  const byScript = new Map<string, string[]>()
  // Labels of several words in Latin letters, and labels in the reader's own (other) script.
  const latin: string[] = []
  const own: string[] = []
  for (const label of labels) {
    const { latin: n, other } = scripts(label)
    let total = n
    let top = "latin"
    let most = n
    for (const [k, count] of other) {
      total += count
      if (count > most) {
        most = count
        top = k
      }
    }
    if (total < 2 || top === "?" || most / total < 0.6) continue
    const script = top === "ja" || top === "zh" ? "cjk" : top
    if (script === "latin") {
      // One Latin word says nothing, whoever reads.
      if ((label.match(/\p{L}+/gu)?.length ?? 0) >= 2) latin.push(label)
    } else if (script === mine) own.push(label)
    else byScript.set(top, [...(byScript.get(top) ?? []), label])
  }
  let best: ControlsJudged | null = null
  const take = (found: ControlsJudged) => {
    if (!best || (found.offer && !best.offer) || (found.offer === best.offer && found.labels > best.labels)) best = found
  }
  for (const [key, list] of byScript) {
    if (list.length < ENTRY_SCRIPT) continue
    // Cyrillic is Russian or Ukrainian by all of it; Chinese or Japanese came told apart already.
    const lang = key === "cyr" ? (languageGuess(list.join(". "))?.lang ?? "ru") : key
    if (canonical(lang) === me) continue
    take({ lang: refined(lang, htmlLang), labels: list.length, offer: list.length >= CONTROLS_SCRIPT })
  }
  // Latin labels: the ones the lists place without doubt name a language; then every label with that language's
  // words counts, unless it's as much the reader's own («In den Warenkorb» has English «in» and German «den»).
  const votes = new Map<string, number>()
  let mineSure = 0
  for (const label of latin) {
    const lang = canonical(languageGuess(label)?.lang ?? "")
    if (lang === me || (lang && neighbours(lang, me))) mineSure++
    else if (lang && !SCRIPT_OF[lang]) votes.set(lang, (votes.get(lang) ?? 0) + 1)
  }
  for (const [lang, sure] of votes) {
    // More labels surely in that language than surely in the reader's own: on an Italian page a few labels read as
    // Spanish (measured: IKEA Italy), and most read as Italian.
    if (sure < ENTRY_WORDS || sure <= mineSure) continue
    const n = latin.filter((label) => wordHits(label, lang) >= 1 && wordHits(label, lang) > wordHits(label, me)).length
    take({ lang: refined(lang, htmlLang), labels: n, offer: n >= CONTROLS_WORDS && n / latin.length >= CONTROLS_WORDS_SHARE })
  }
  // The reader's own script: Ukrainian shows by its own letters among Russian's (not the other way: a Ukrainian word
  // without them reads as Russian). Russian has none of those letters, so the labels that do are sign enough.
  if (mine === "cyr" && me !== "uk") {
    const n = own.filter((label) => languageGuess(label)?.lang === "uk").length
    if (n >= ENTRY_WORDS) take({ lang: refined("uk", htmlLang), labels: n, offer: n >= CONTROLS_WORDS })
  }
  return best
}
