import { test } from "node:test"
import assert from "node:assert/strict"

import { guessLanguage, languageName, translateTarget } from "../src/content/translateTarget.ts"
import { readFileSync } from "node:fs"

test("the selection's language, from its letters and commonest words", () => {
  const cases: Array<[string, string | null]> = [
    ["The quick brown fox jumps over the lazy dog and runs to the forest.", "en"],
    ["Привет, это короткий текст на русском языке для проверки.", "ru"],
    ["Привіт, це короткий текст українською мовою, і він їй належить.", "uk"],
    ["Der schnelle braune Fuchs springt über den faulen Hund und die Katze.", "de"],
    ["El rápido zorro marrón salta sobre el perro perezoso y la casa.", "es"],
    ["Le renard brun rapide saute par-dessus le chien paresseux et les chats.", "fr"],
    ["Il veloce cane marrone salta sopra la volpe che dorme e non si sveglia.", "it"],
    ["O rápido cachorro marrom pula sobre a raposa que não acorda com o barulho.", "pt"],
    ["这是一个用于测试的中文句子，看看能不能识别出来。", "zh"],
    ["これはテスト用の日本語の文章です。", "ja"],
    ["이것은 테스트를 위한 한국어 문장입니다.", "ko"],
    ["Đây là một câu tiếng Việt để kiểm tra ngôn ngữ.", "vi"],
    ["هذه جملة باللغة العربية للاختبار", "ar"],
    ["OK", null],
    ["iPhone 17 Pro Max", null]
  ]
  for (const [text, lang] of cases) assert.equal(guessLanguage(text), lang, text)
})

test("Translate goes into the interface's language unless the text is already in it", () => {
  const ru = "Привет, это короткий текст на русском языке для проверки."
  const en = "The quick brown fox jumps over the lazy dog and runs to the forest."
  // Not in the interface's language (or unsure): into it, as before.
  assert.deepEqual(translateTarget(en, "ru", ["ru-RU", "en"]), { code: null })
  assert.deepEqual(translateTarget("iPhone 17 Pro Max", "ru", ["ru"]), { code: null })
  // Already in it: into English.
  assert.deepEqual(translateTarget(ru, "ru-RU", ["ru-RU"]), { code: "en" })
  assert.deepEqual(translateTarget("Привіт, це текст українською мовою, і він їй належить.", "uk", ["uk"]), { code: "en" })
  // English text, English interface: the next language the person reads, or no Translate.
  assert.deepEqual(translateTarget(en, "en-US", ["en-US", "en", "es-MX"]), { code: "es" })
  assert.equal(translateTarget(en, "en", ["en-GB"]), null)
  // Brazilian Portuguese interface: Portuguese text counts as its own.
  assert.deepEqual(translateTarget("O rápido cachorro marrom pula sobre a raposa que não acorda.", "pt_BR", ["pt-BR"]), { code: "en" })
})

test("the fallback's label and prompt read right in each interface language", () => {
  const msg = (lang: string) => JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8"))
  const fill = (s: string, v: string) => s.replace("{0}", v)
  const ru = msg("ru")
  assert.equal(ru.langCode, "ru")
  assert.equal(fill(ru.selTranslateTo, languageName("en", ru.langCode)), "Перевести на английский")
  assert.equal(fill(ru.promptSelTranslate, languageName("en", ru.langCode)), "Переведи выделенный текст на английский.")
  assert.equal(fill(msg("fr").selTranslateTo, languageName("en", "fr")), "Traduire en anglais")
  assert.equal(fill(msg("es").selTranslateTo, languageName("en", "es")), "Traducir al inglés")
  assert.equal(fill(msg("en").selTranslateTo, languageName("es", "en")), "Translate to Spanish")
  assert.equal(fill(msg("ja").selTranslateTo, languageName("en", "ja")), "英語に翻訳")
  // Every locale names its own language code, which the fallback compares against.
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "uk", "vi", "zh_CN", "zh_TW"]) {
    const code = msg(lang).langCode
    assert.ok(code && new Intl.Locale(code).language === lang.split("_")[0], `${lang}: ${code}`)
  }
  // The panel's lang and direction come from it (2.6): Traditional and Simplified by script, Arabic right to left.
  assert.equal(msg("zh_TW").langCode, "zh-Hant")
  assert.equal(msg("zh_CN").langCode, "zh-Hans")
  assert.equal(fill(msg("ar").selTranslateTo, languageName("en", "ar")), "ترجمة إلى الإنجليزية")
  assert.equal(fill(msg("zh_TW").selTranslateTo, languageName("en", "zh-Hant")), "翻譯成英文")
  assert.equal(fill(msg("vi").selTranslateTo, languageName("en", "vi")), "Dịch sang Tiếng Anh")
})
