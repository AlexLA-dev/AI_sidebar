// The language a request is written in (2.7.1): the model writes its step lines and summary in it. The panel's
// language was the only hint before, and Haiku followed it over the request half the time (a Russian request in an
// English panel got English lines: the director on the real-Safari shots). By the script first, then, for the
// languages written in Latin letters, by their letters and common words. Unknown: the panel's language.

const COMMON: Record<string, string[]> = {
  en: ["the", "and", "to", "my", "for", "add", "book", "buy", "please", "me", "in", "of", "with", "find", "show", "a", "an", "on", "at", "it", "all", "from"],
  de: ["und", "der", "die", "das", "mir", "mich", "nur", "bitte", "für", "mit", "ein", "eine", "zeig", "von", "nach", "unter", "ist", "den", "dem", "auf"],
  fr: ["le", "la", "les", "des", "et", "pour", "mon", "ma", "mes", "un", "une", "du", "avec", "moi", "sur", "dans", "ajoute", "réserve"],
  es: ["el", "la", "los", "las", "y", "para", "mi", "mis", "por", "un", "una", "con", "del", "añade", "reserva", "en", "de"],
  it: ["il", "lo", "gli", "le", "e", "per", "mio", "mia", "un", "una", "con", "del", "della", "aggiungi", "prenota", "di", "che"],
  pt: ["o", "os", "as", "e", "para", "meu", "minha", "um", "uma", "com", "do", "da", "dos", "adicione", "reserve", "no", "na"],
  tr: ["ve", "için", "bir", "bu", "ile", "bana", "beni", "ekle", "olan", "da", "de"],
  vi: ["và", "cho", "của", "tôi", "một", "với", "thêm", "đặt", "là"]
}

export function requestLanguage(text: string, fallback: string): string {
  const s = text.normalize("NFC")
  const has = (re: RegExp) => re.test(s)
  if (has(/[぀-ヿ]/)) return "ja"
  if (has(/[가-힯]/)) return "ko"
  if (has(/[一-鿿]/)) return /^zh[-_](tw|hk|mo|hant)/i.test(fallback) ? "zh_TW" : fallback.toLowerCase().startsWith("zh") ? fallback : "zh_CN"
  if (has(/[؀-ۿ]/)) return "ar"
  if (has(/[Ѐ-ӿ]/)) return has(/[іїєґІЇЄҐ]/) ? "uk" : has(/[ыэъЫЭЪ]/) ? "ru" : fallback.startsWith("uk") ? "uk" : "ru"
  if (has(/[ăơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i)) return "vi"
  // (Links and addresses say nothing of the language: "com" isn't Portuguese.)
  const words = s.replace(/\S+(?:\/\/|@|\.\w{2,})\S*/g, " ").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)
  if (!words.length) return fallback
  const score: Record<string, number> = {}
  for (const [lang, list] of Object.entries(COMMON)) score[lang] = words.filter((w) => list.includes(w)).length
  if (has(/[ğışİ]/)) score.tr += 2
  if (has(/[äöüß]/i)) score.de += 2
  if (has(/[ñ¿¡]/)) score.es += 2
  if (has(/[ãõ]/)) score.pt += 2
  if (has(/[èêœàù]/)) score.fr += 1
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0]
  // One common word is too little to go by (short words are shared): two, or one and a letter of the language.
  if (!best || best[1] < 2) return fallback
  const panel = fallback.toLowerCase().replace(/[-_].*/, "")
  // A tie with the panel's own language: the panel's.
  if (score[panel] === best[1]) return fallback
  return best[0] === "pt" ? "pt_BR" : best[0]
}
