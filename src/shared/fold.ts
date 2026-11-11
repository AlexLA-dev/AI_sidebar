// One rule for "accents don't matter" wherever the panel searches: templates (templates.ts normalize), chats
// (threads.ts searchThreads) and the words that mark a site's search field (insert/spot.ts). Build 95, the owner:
// «Важно вообще весь код проверить на наличие таких подгонов под меня, их быть не должно»; chat search folded only
// Latin accents and «ё», so "phan hoi" didn't find "Phản hồi". The app's search ignores accents in every language
// (Chats.swift, .diacriticInsensitive).

// The marks that come off letters: Latin, Cyrillic and Greek accents and Vietnamese tones (combining diacritics),
// Arabic short vowels, tanwin, shadda, sukun and the dagger alef. Scripts whose marks are part of their letters keep
// them: Korean syllables, Japanese voicing, Thai and Hindi vowels.
const ACCENTS = /[\u0300-\u036f\u064b-\u065f\u0670]/g

/**
 * Lower case, the accents off: "Phản hồi" → "phan hoi", "Ёлка" → "елка", "مَرْحَبًا" → "مرحبا"; "ß" is "ss", as the
 * app's search has it ("Straße" is found by "strasse"). Letters of their own stay: "ґ" isn't "г".
 */
export function unaccent(text: string): string {
  return text.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(ACCENTS, "").normalize("NFC")
}
