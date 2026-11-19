// Where "Translate" by a selection translates to (2.6, the director's note on the owner's quick chips): into the
// interface's language, as before, unless the text already is in it; then into English, or, with an English
// interface, into the person's next language in the browser's list. With nowhere sensible to go, there's no Translate.
//
// The text's language is a guess from its letters and its commonest words, good enough for "is this already in my
// language": a script tells Cyrillic, Greek, Arabic, Hebrew, Chinese, Japanese, Korean and Thai apart; Ukrainian and
// Russian by their own letters; Vietnamese by its marks; Latin-script languages by short function words. Unsure: null,
// and Translate goes to the interface's language as before.
//
// 2.7 (the director's audit, «чтобы все новые функции работали одинаково хорошо для всех»): the page's own language
// is judged by this too, for a reader of any language, so the function words cover the common Latin-script languages
// beyond the panel's six (Turkish, Dutch or Czech used to come out as Portuguese or Spanish). Each list is a language's
// commonest short words, shared ones included, so a neighbour doesn't win on the words both use.

const WORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "is", "in", "that", "it", "for", "with", "you", "this", "are", "was", "on", "be", "have", "not"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine", "zu", "den", "auf", "sich", "auch", "dem", "von", "für", "des", "im", "sie"],
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "por", "con", "para", "no", "del", "se", "lo", "su", "como"],
  fr: ["le", "la", "les", "de", "des", "et", "est", "un", "une", "du", "que", "pas", "pour", "dans", "en", "au", "il", "qui", "sur", "par", "ne", "plus"],
  it: ["il", "la", "lo", "che", "di", "e", "è", "un", "una", "per", "non", "con", "sono", "del", "della", "gli", "si", "le", "ma", "da", "nel", "al", "su", "in"],
  pt: ["o", "a", "os", "as", "de", "que", "e", "é", "um", "uma", "não", "com", "para", "do", "da", "em", "se", "no", "na", "dos"],
  ca: ["de", "la", "i", "el", "que", "les", "en", "els", "del", "per", "un", "amb", "una", "és", "no", "al", "es", "més"],
  nl: ["de", "het", "een", "en", "van", "is", "dat", "op", "te", "zijn", "voor", "met", "niet", "aan", "er", "ook", "maar", "wordt"],
  sv: ["och", "att", "det", "som", "en", "på", "är", "av", "för", "med", "till", "den", "har", "inte", "om", "ett", "var", "de"],
  da: ["og", "at", "det", "som", "en", "på", "er", "af", "for", "med", "til", "den", "har", "ikke", "de", "et", "fra", "blev"],
  nb: ["og", "at", "det", "som", "en", "på", "er", "av", "for", "med", "til", "den", "har", "ikke", "de", "et", "fra", "ble"],
  fi: ["ja", "on", "ei", "se", "että", "oli", "hän", "mutta", "kun", "ovat", "myös", "tai", "joka", "ole", "sen", "niin", "kuin", "vain"],
  tr: ["ve", "bir", "bu", "da", "de", "için", "ile", "olarak", "çok", "daha", "gibi", "ama", "o", "ne", "olan", "sonra", "kadar", "ise"],
  cs: ["a", "je", "se", "v", "na", "že", "to", "s", "z", "do", "o", "jsou", "ale", "by", "jako", "jeho", "také", "však"],
  sk: ["a", "je", "sa", "v", "na", "že", "to", "s", "z", "do", "o", "sú", "ale", "by", "ako", "pre", "aj", "však"],
  pl: ["i", "w", "się", "na", "nie", "z", "że", "do", "to", "jest", "o", "jak", "ale", "po", "co", "tak", "są", "przez"],
  ro: ["și", "şi", "în", "de", "la", "cu", "că", "pe", "nu", "este", "o", "un", "din", "pentru", "care", "mai", "se", "a"],
  hu: ["a", "az", "és", "hogy", "nem", "is", "egy", "meg", "de", "van", "csak", "már", "mint", "ez", "el", "még", "volt", "szerint"],
  id: ["yang", "dan", "di", "ini", "itu", "dengan", "untuk", "dari", "dalam", "tidak", "akan", "pada", "ke", "juga", "ada", "oleh", "atau", "mereka"]
}

/** Letters only one of these languages uses: they decide a short text the function words can't (a headline, a menu).
 *  Taken as a weak guess, so a page's markup still wins over it. */
const OWN_LETTERS: Array<[string, RegExp]> = [
  ["tr", /[ğı]/g],
  ["pl", /[ąęłśźż]/gi],
  ["cs", /[ěřů]/gi],
  ["ro", /[ășț]/gi],
  ["hu", /[őű]/gi]
]

function byLetters(s: string, words: number): Guess | null {
  let best: string | null = null
  let top = 0
  let second = 0
  for (const [lang, re] of OWN_LETTERS) {
    const n = s.match(re)?.length ?? 0
    if (n > top) {
      second = top
      top = n
      best = lang
    } else if (n > second) second = n
  }
  return best && top >= 3 && top >= second * 2 ? { lang: best, share: Math.min(0.05, top / Math.max(1, words)) } : null
}

/** How many of a text's words are among a language's commonest (0 for a language without a list). */
export function wordHits(text: string, lang: string): number {
  const list = WORDS[lang]
  if (!list) return 0
  const set = new Set(list)
  return (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => set.has(w)).length
}

/** Languages the guess can name: by script, by marks, by function words. */
export const GUESSED = new Set(["ja", "ko", "zh", "ru", "uk", "ar", "he", "el", "th", "vi", ...Object.keys(WORDS)])

/** The base language of a code: "pt-BR" → "pt", "zh_Hant" → "zh". */
export function baseLanguage(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? ""
}

/** A guess at a text's language: a base code and how sure, the share of its words that are the language's function
 *  words (1 when its script or marks tell). */
export interface Guess {
  lang: string
  share: number
}

/** Below this share of function words, a long text's guess is a coincidence of a few short words (a language with no
 *  list of its own, a page of names and numbers). */
const LONG_TEXT_WORDS = 40
const LONG_TEXT_SHARE = 0.04

/** The text's language with how sure the guess is, or null when unsure. */
export function languageGuess(text: string): Guess | null {
  const s = text.slice(0, 2000)
  const count = (re: RegExp) => s.match(re)?.length ?? 0
  const letters = count(/\p{L}/gu)
  if (letters < 3) return null
  const share = (n: number) => n / letters
  const sure = (lang: string): Guess => ({ lang, share: 1 })
  if (share(count(/[\u3040-\u30ff]/g)) > 0.05) return sure("ja")
  if (share(count(/[\uac00-\ud7af\u1100-\u11ff]/g)) > 0.3) return sure("ko")
  if (share(count(/\p{Script=Han}/gu)) > 0.3) return sure("zh")
  const cyrillic = count(/\p{Script=Cyrillic}/gu)
  // Ukrainian by its own letters, as a share (і alone is about 5 % of a Ukrainian text's letters): a Ukrainian place
  // name or two in a Russian article doesn't make it Ukrainian.
  if (share(cyrillic) > 0.5) return sure(count(/[іїєґ]/giu) >= Math.max(1, cyrillic * 0.03) ? "uk" : "ru")
  if (share(count(/\p{Script=Arabic}/gu)) > 0.5) return sure("ar")
  if (share(count(/\p{Script=Hebrew}/gu)) > 0.5) return sure("he")
  if (share(count(/\p{Script=Greek}/gu)) > 0.5) return sure("el")
  if (share(count(/\p{Script=Thai}/gu)) > 0.5) return sure("th")
  if (share(count(/\p{Script=Latin}/gu)) < 0.5) return null
  // Vietnamese by marks no other Latin-script language uses (ă is Romanian's too, so it isn't one of them).
  if (count(/[đơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) >= 2) return sure("vi")
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
  // A tie with a neighbour ("la", "de") decides nothing; in a longer text, one common word isn't enough either. Then
  // letters only one language uses may tell (Turkish ğ and ı in a headline).
  if (!best || top === 0 || top === second) return byLetters(s, words.length)
  if (!(top >= 2 || words.length <= 4)) return byLetters(s, words.length)
  const sureness = top / Math.max(1, words.length)
  if (words.length >= LONG_TEXT_WORDS && sureness < LONG_TEXT_SHARE) return byLetters(s, words.length)
  return { lang: best, share: sureness }
}

/** The text's language (a base code), or null when unsure. */
export function guessLanguage(text: string): string | null {
  return languageGuess(text)?.lang ?? null
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
