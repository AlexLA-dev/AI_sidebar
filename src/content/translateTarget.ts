// Where "Translate" by a selection translates to (2.6, the director's note on the owner's quick chips): into the
// interface's language, as before, unless the text already is in it; then into English, or, with an English
// interface, into the person's next language in the browser's list. With nowhere sensible to go, there's no Translate.
//
// The text's language is a guess from its letters and its commonest words, good enough for "is this already in my
// language": a script tells Cyrillic, Greek, Arabic, Hebrew, Chinese, Japanese, Korean and Thai apart; Ukrainian and
// Russian by their own letters; Vietnamese by its marks; the Latin-script languages we speak by short function
// words. Unsure: null, and Translate goes to the interface's language as before.

const WORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "is", "in", "that", "it", "for", "with", "you", "this", "are", "was", "on", "be", "have", "not"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine", "zu", "den", "auf", "ich", "sie", "es", "sich", "auch", "dem"],
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "por", "con", "para", "no", "del", "se", "lo"],
  fr: ["le", "la", "les", "des", "et", "est", "un", "une", "du", "que", "pas", "pour", "dans", "en", "au", "il", "qui", "sur"],
  it: ["il", "la", "che", "di", "e", "è", "un", "una", "per", "non", "con", "sono", "del", "della", "gli", "si", "le", "ma"],
  pt: ["o", "a", "os", "as", "de", "que", "e", "é", "um", "uma", "não", "com", "para", "do", "da", "em", "se", "no"]
}

/** The base language of a code: "pt-BR" → "pt", "zh_Hant" → "zh". */
export function baseLanguage(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? ""
}

/** The text's language (a base code), or null when unsure. */
export function guessLanguage(text: string): string | null {
  const s = text.slice(0, 2000)
  const count = (re: RegExp) => s.match(re)?.length ?? 0
  const letters = count(/\p{L}/gu)
  if (letters < 3) return null
  const share = (n: number) => n / letters
  if (share(count(/[぀-ヿ]/g)) > 0.05) return "ja"
  if (share(count(/[가-힯ᄀ-ᇿ]/g)) > 0.3) return "ko"
  if (share(count(/\p{Script=Han}/gu)) > 0.3) return "zh"
  if (share(count(/\p{Script=Cyrillic}/gu)) > 0.5) return /[іїєґ]/i.test(s) ? "uk" : "ru"
  if (share(count(/\p{Script=Arabic}/gu)) > 0.5) return "ar"
  if (share(count(/\p{Script=Hebrew}/gu)) > 0.5) return "he"
  if (share(count(/\p{Script=Greek}/gu)) > 0.5) return "el"
  if (share(count(/\p{Script=Thai}/gu)) > 0.5) return "th"
  if (share(count(/\p{Script=Latin}/gu)) < 0.5) return null
  if (count(/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) >= 2) return "vi"
  const words = s.toLowerCase().match(/\p{L}+/gu) ?? []
  let best: string | null = null
  let top = 0
  let second = 0
  for (const [lang, list] of Object.entries(WORDS)) {
    const set = new Set(list)
    const hits = words.filter((w) => set.has(w)).length
    if (hits > top) {
      second = top
      top = hits
      best = lang
    } else if (hits > second) second = hits
  }
  // A tie with a neighbour ("la", "de") decides nothing; in a longer text, one common word isn't enough either.
  if (top === 0 || top === second) return null
  return top >= 2 || words.length <= 4 ? best : null
}

export interface TranslateTo {
  // A base code ("en"), or null for the interface's own language.
  code: string | null
}

/**
 * Where to translate `text` for someone whose interface is in `ui`, with the browser's `preferred` languages; null
 * when there's nowhere sensible (the text is in English, the interface too, and no other language is listed).
 */
export function translateTarget(text: string, ui: string, preferred: readonly string[]): TranslateTo | null {
  const mine = baseLanguage(ui)
  const its = guessLanguage(text)
  if (its !== mine) return { code: null }
  if (mine !== "en") return { code: "en" }
  const next = preferred.map(baseLanguage).find((l) => l && l !== "en")
  return next ? { code: next } : null
}

/** A language's name in the interface's language ("английский" for "en" in a Russian interface). */
export function languageName(code: string, ui: string): string {
  try {
    return new Intl.DisplayNames([ui], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}
