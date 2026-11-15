// The words a text is about, one rule wherever the panel compares texts by their words: the chat that fits a page
// (match.ts) and the collection a card goes to (collections.ts suggestPlace; the app's Board.topicWords in
// Collections.swift is the same rule). In every language the app speaks: function words ("the", "для", "los") don't
// count; Chinese, Japanese and Korean, which don't put spaces between words, go by pairs of characters.

import { unaccent } from "./fold.ts"

/**
 * Words that don't tell names apart (articles, prepositions, conjunctions: "the", "für", "và", "في"), by script: the
 * Latin languages' together, Vietnamese's apart (its "da", "do" are words), Cyrillic's, Arabic's, Korean's.
 * Organizing's names (organize.ts) and topics here (with TOPIC_EXTRA) share them.
 */
export const NAME_STOP = {
  latin: new Set([
    "the", "a", "an", "and", "or", "of", "for", "with", "by", "in", "on", "to", "at", "from", "vs", "my", "your", "our", "about", "how", "what",
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "für", "mit", "von", "vom", "im", "am", "zum", "zur", "oder", "auf", "über", "bei", "zu", "wie", "was",
    "le", "la", "les", "l", "un", "une", "et", "pour", "avec", "de", "d", "du", "en", "ou", "au", "aux", "sur", "dans", "par", "à",
    "el", "los", "las", "una", "y", "para", "con", "del", "al", "por", "sobre",
    "il", "lo", "i", "gli", "e", "per", "di", "della", "dei", "delle", "degli", "alla", "su", "da", "nel", "nella", "dell",
    "o", "os", "as", "um", "uma", "com", "do", "dos", "das", "em", "no", "na", "nos", "nas", "ao"
  ]),
  vi: new Set(["và", "cho", "của", "với", "các", "những", "về", "trong", "là", "một"]),
  cyrillic: new Set(["и", "в", "во", "на", "с", "со", "по", "для", "от", "до", "из", "или", "о", "об", "обо", "про", "к", "ко", "у", "за", "это", "как", "что",
    "і", "й", "та", "з", "із", "зі", "від", "або", "як", "що"]),
  arabic: new Set(["و", "في", "من", "على", "مع", "أو", "عن", "إلى"]),
  hangul: new Set(["및", "위한", "대한"])
}

/** Korean particles at a word's end ("교토의" is "교토"), the longer first. */
export const KO_PARTICLES = ["에서", "으로", "에게", "까지", "부터", "의", "을", "를", "은", "는", "이", "가", "에", "로", "와", "과", "도", "만"]

/**
 * What else a page's title or a question is made of beside its topic, by language: question words, pronouns, "is",
 * "not", "this". Names keep these (a chat called «Что посмотреть в Киото» is that), topics don't. Mirrored in
 * Collections.swift `topicExtra` (tests/words.test.mts checks).
 */
export const TOPIC_EXTRA: Record<string, string[]> = {
  en: ["you", "are", "is", "this", "that", "these", "those", "why", "when", "where", "which", "who", "can", "into", "its", "was", "were", "will", "not", "than", "does", "has", "have", "but"],
  de: ["ist", "sind", "nicht", "wird", "warum", "wann", "wer", "welche", "welcher", "dieser", "diese", "dieses", "ihre", "ihr", "sie", "ich", "wir", "aus", "nach", "man", "sich", "auch", "noch"],
  fr: ["est", "sont", "pas", "qui", "que", "quoi", "comment", "pourquoi", "quand", "votre", "vos", "nos", "ces", "cette", "son", "ses", "leur", "plus", "tout", "tous"],
  es: ["que", "qué", "como", "cómo", "cuando", "cuándo", "donde", "dónde", "son", "más", "sus", "este", "esta", "estos", "estas", "pero", "sin", "entre", "todo", "todos", "cual", "cuál"],
  it: ["che", "come", "perché", "quando", "dove", "sono", "non", "questo", "questa", "questi", "suo", "sua", "più", "tutto", "tra", "fra"],
  pt: ["que", "como", "quando", "onde", "são", "não", "este", "esta", "seu", "sua", "seus", "suas", "mais", "pelo", "pela", "entre", "todo"],
  ru: ["чем", "где", "когда", "почему", "зачем", "при", "без", "над", "под", "мой", "ваш", "все", "всё", "его", "она", "они", "так", "тот", "эта", "этот", "эти", "уже", "ещё", "чтобы", "если", "также", "только"],
  uk: ["чому", "коли", "при", "без", "над", "під", "цей", "ця", "це", "все", "його", "вона", "вони", "щоб", "якщо", "також", "тільки", "який", "яка", "які"],
  vi: ["được", "này", "không", "như", "nào", "khi", "thì", "cũng", "đến", "từ"],
  ar: ["هذا", "هذه", "كيف", "ماذا", "لماذا", "التي", "الذي", "ذلك", "تلك", "كان", "هل"],
  ko: ["어떻게", "무엇", "언제", "어디", "하는", "있는", "위해", "대해", "그리고", "또는", "이런", "이것", "그것", "모든"],
  // Chinese words that are grammar, not a topic (of, why, what, how, which, can, we, this, one, and, or, isn't…): they
  // part the words around them, as a space would.
  zh: ["的", "为什么", "為什麼", "什么", "什麼", "怎么", "怎麼", "如何", "哪些", "哪个", "哪個", "可以", "我们", "我們", "你们", "你們", "这个", "這個", "那个", "那個", "一个", "一個", "以及", "还是", "還是", "或者", "就是", "不是", "没有", "沒有"],
  // A Han character alone that says nothing on its own: I, you, he, she, is, at, and, of, a year, a month, a day.
  single: ["我", "你", "他", "她", "它", "是", "在", "和", "与", "與", "及", "了", "吗", "嗎", "呢", "吧", "也", "都", "就", "年", "月", "日"]
}

// Every function word, folded as the texts are (case and accents off): one set, since a word is checked whatever its
// language ("que" is Spanish, French and Portuguese alike).
const STOP = new Set(
  [...Object.values(NAME_STOP).flatMap((s) => [...s]), ...Object.entries(TOPIC_EXTRA).filter(([k]) => k !== "zh" && k !== "single").flatMap(([, w]) => w)].map(unaccent)
)
const SINGLE_STOP = new Set(TOPIC_EXTRA.single)
// The longer first: «为什么» before «什么».
const ZH_SPLIT = new RegExp([...TOPIC_EXTRA.zh].sort((a, b) => b.length - a.length).join("|"), "u")

// A run's parts by script: Chinese characters and katakana (with the long-vowel mark), hiragana, Hangul, the rest.
const PARTS = /[\p{Script=Han}\p{Script=Katakana}ー]+|\p{Script=Hiragana}+|\p{Script=Hangul}+|[^\p{Script=Han}\p{Script=Katakana}ー\p{Script=Hiragana}\p{Script=Hangul}]+/gu
const HAN_KANA = /^[\p{Script=Han}\p{Script=Katakana}ー]/u
const HANGUL = /^\p{Script=Hangul}/u
const HIRAGANA = /^\p{Script=Hiragana}/u

function pairs(chars: string[], out: Set<string>) {
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
}

/**
 * The words a text is about, folded (case and accents off), without function words:
 *  - letters and digits in runs of 3 or more, no bare numbers;
 *  - Chinese and Japanese by pairs of characters, a character alone kept ("東京の雨" → 東京, 雨); hiragana is Japanese
 *    grammar (の, です, について) and doesn't count; Chinese grammar words («的», «如何») part the words around them;
 *  - Korean words by pairs too (compounds go without spaces), their particle off ("서울의" → 서울).
 */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const run of unaccent(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const part of run.match(PARTS) ?? []) {
      if (HIRAGANA.test(part)) continue
      if (HAN_KANA.test(part)) {
        for (const piece of part.split(ZH_SPLIT)) {
          const chars = [...piece]
          if (chars.length === 0) continue
          if (chars.length === 1) {
            if (!SINGLE_STOP.has(piece)) out.add(piece)
          } else pairs(chars, out)
        }
        continue
      }
      if (HANGUL.test(part)) {
        const particle = KO_PARTICLES.find((p) => part.endsWith(p) && [...part].length - [...p].length >= 2)
        const word = particle ? part.slice(0, part.length - particle.length) : part
        if (!STOP.has(word)) pairs([...word], out)
        continue
      }
      if (part.length >= 3 && !/^\d+$/.test(part) && !STOP.has(part)) out.add(part)
    }
  }
  return out
}
