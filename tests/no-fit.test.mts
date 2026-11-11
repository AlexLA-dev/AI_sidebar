// Build 95, the owner: «Важно вообще весь код проверить на наличие таких подгонов под меня, их быть не должно. И при
// этом все описанные в заданиях и чате требования и ожидания должны эффективно работать». The director's check found
// rules that knew English and Russian only; these hold them to every language.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { parseHTML } from "linkedom"

import { LANGS } from "../netlify/shared/lexicon.mts"
import { actionLabel, pdfName } from "../src/content/pdf.ts"
import { noButtonField, SEARCH_WORDS, searchNamed } from "../src/content/insert/spot.ts"
import { unaccent } from "../src/shared/fold.ts"
import { normalize, searchTemplates } from "../src/shared/templates.ts"
import { foldText, searchThreads, type Thread } from "../src/shared/threads.ts"

const file = "https://example.org/docs/annual-report-2025.pdf"

test("a PDF link that says what to do, in any language, is named by its file", () => {
  for (const label of [
    "Download", "Download PDF", "PDF", "Open PDF (2.4 MB)", "Скачать PDF (2,4 МБ)", "Завантажити", "PDF herunterladen",
    "Datei öffnen", "Descargar el PDF", "Télécharger le PDF", "Scarica il PDF", "Baixar o arquivo", "PDFをダウンロード",
    "PDF 다운로드", "下载PDF", "下載 (1 MB)", "تحميل الملف", "Tải xuống PDF", "click here"
  ]) {
    assert.equal(actionLabel(label), true, label)
    assert.equal(pdfName(file, label), "annual-report-2025.pdf", label)
  }
})

test("a PDF link that names its file keeps its words, in any language", () => {
  for (const label of [
    "Annual report 2025", "Годовой отчёт 2025", "Річний звіт", "Jahresbericht 2025", "Informe anual", "Rapport annuel",
    "Relazione annuale", "Relatório anual", "年次報告書", "연례 보고서", "年度报告", "التقرير السنوي", "Báo cáo thường niên",
    "Open data handbook", "Download speeds in 2025"
  ]) {
    assert.equal(actionLabel(label), false, label)
    assert.equal(pdfName(file, label), label, label)
  }
})

test("template search: accents off for every language, scripts whose marks are letters kept whole", () => {
  // Latin, Cyrillic, Greek, Vietnamese tones, Arabic short vowels.
  assert.equal(normalize("Café Crème"), "cafe creme")
  assert.equal(normalize("Ёлка, ПРИВЕТ!"), "елка привет")
  // "ї" is "і" with an accent; "ґ" is a letter of its own, kept.
  assert.equal(normalize("Ґанок і їжак"), "ґанок і іжак")
  assert.equal(normalize("Señor Müller, São Paulo"), "senor muller sao paulo")
  assert.equal(normalize("Tải xuống báo cáo"), "tai xuong bao cao")
  assert.equal(normalize("Αθήνα"), "αθηνα")
  assert.equal(normalize("مَرْحَبًا"), "مرحبا")
  // Korean syllables and Japanese voicing stay as written; Thai and Hindi vowels aren't torn off their letters.
  assert.equal(normalize("안녕하세요"), "안녕하세요")
  assert.equal(normalize("ガイド・ご案内"), "ガイド ご案内")
  assert.equal(normalize("สวัสดี"), "สวัสดี")
  assert.equal(normalize("नमस्ते"), "नमस्ते")
})

test("template search finds a template whatever accents the query has or lacks", () => {
  const t = (id: string, title: string, text: string) => ({ id, title, text, keywords: [], createdAt: 1, updatedAt: 1 }) as any
  const list = [t("a", "Réponse au café", "Merci pour votre message."), t("b", "Phản hồi khách hàng", "Cảm ơn bạn."), t("c", "Ёмкость", "Ответ")]
  const ctx = { host: "example.org", use: {}, now: 2 } as any
  for (const [query, id] of [["cafe", "a"], ["reponse", "a"], ["phan hoi", "b"], ["khach", "b"], ["емкость", "c"], ["ёмкость", "c"]] as const) {
    assert.ok(searchTemplates(list, query, ctx).some((x: any) => x.id === id), query)
  }
})

test("the watch notification's example names no currency of its own", () => {
  const server = readFileSync(new URL("../netlify/shared/watch.mts", import.meta.url), "utf8")
  const judge = server.slice(server.indexOf("export const JUDGE_SYSTEM"), server.indexOf("const PLAN_SCHEMA"))
  assert.doesNotMatch(judge, /[€$£¥₽₴]|\b\d+ ?(EUR|USD|RUB)\b/)
  assert.match(judge, /as the page writes it/)
})

test("Find similar's prompts and the read-aloud rules carry no price, currency or test case of their own", async () => {
  process.env.SUPABASE_URL ??= "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-key"
  process.env.ANTHROPIC_API_KEY ??= "test-key"
  const similar = await import("../netlify/shared/similar.mts")
  const { SCRIPT_RULES } = await import("../netlify/shared/speakscript.mts")
  const prompts: Record<string, string> = {
    PLAN_SYSTEM: similar.PLAN_SYSTEM, SEARCH_SYSTEM: similar.SEARCH_SYSTEM, WRITE_SYSTEM: similar.WRITE_SYSTEM, SEARCH_ONE_SYSTEM: similar.SEARCH_ONE_SYSTEM,
    SEARCH_OWN_SYSTEM: similar.SEARCH_OWN_SYSTEM, PRICING_SYSTEM: similar.PRICING_SYSTEM, READ_SYSTEM: similar.READ_SYSTEM,
    REVIEW_SEARCH_SYSTEM: similar.REVIEW_SEARCH_SYSTEM, REVIEW_READ_SYSTEM: similar.REVIEW_READ_SYSTEM, SHIP_READ_SYSTEM: similar.SHIP_READ_SYSTEM, SCRIPT_RULES
  }
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text && text.length > 100, name)
    // A price in an example teaches the model that price; placeholders say "<its price as the page shows it>".
    assert.doesNotMatch(text, /[€£¥₽₴₹₩₫]\s?\d|\d\s?[€£¥₽₴₹₩₫]|\$\s?\d|\b\d+(?:[.,]\d+)? ?(?:EUR|USD|GBP|RUB|UAH|JPY|dollars|euros)\b/i, name)
    assert.doesNotMatch(text, /airback|backvac|vacpack|fanwoli|ryden|markus|sihoo|kallax|poäng|lego|ikea|cyprus|кипр|stephanis/i, name)
  }
})

// The director's second check (overfit95-review.md, S3): the panel's chat search folded Latin accents and «ё» only,
// while the app's ignores accents in every language. Now one rule for templates and chats (fold.ts).
test("chat search ignores accents in every language, and marks the words where they are", () => {
  const page = { url: "https://example.org/a", title: "Example" }
  const chat = (id: string, question: string, answer: string): Thread =>
    ({ id, u: 1, a: 1, m: [{ role: "user", content: question, page }, { role: "assistant", content: answer }] }) as Thread
  const threads = [
    chat("vi", "Phản hồi khách hàng thế nào?", "Hãy cảm ơn họ trước, rồi trả lời từng câu hỏi."),
    chat("ar", "كيف أكتب رسالة مَرْحَبًا للعملاء؟", "ابدأ بالتَّحِيَّة ثم اشرح العرض."),
    chat("de", "Wie lange hält die Größe 42 im Geschäft?", "Im Geschäft sind die Straßenschuhe ab Lager lieferbar."),
    chat("fr", "Où acheter un café crème à Genève ?", "Les cafés près du lac ouvrent tôt."),
    chat("uk", "Як доглядати за їжаком узимку?", "Ґанок має бути теплим, а їжа свіжою.")
  ]
  for (const [query, id] of [
    ["phan hoi", "vi"], ["PHẢN HỒI", "vi"], ["cam on", "vi"], ["khach hang", "vi"],
    ["مرحبا", "ar"], ["مَرْحَبًا", "ar"], ["التحية", "ar"],
    ["geschaft", "de"], ["größe 42", "de"], ["grosse", "de"], ["strassenschuhe", "de"],
    ["cafe creme", "fr"], ["geneve", "fr"], ["cafés", "fr"],
    ["іжаком", "uk"], ["їжаком", "uk"], ["ґанок", "uk"], ["ЇЖА", "uk"]
  ] as const) {
    assert.deepEqual(searchThreads(threads, query).map((r) => r.thread.id), [id], query)
  }
  // As in the app's search (.diacriticInsensitive): "й" is "и" with an accent, "ї" is "і"; "ґ" is a letter of its own.
  assert.deepEqual(searchThreads([chat("ru", "Хвойное дерево", "Ёлка и сосна")], "хвоиное").length, 1)
  assert.deepEqual(searchThreads(threads, "ганок"), [])
  // The marks fall on the words as written, accents and all.
  for (const [query, id, written] of [['"cam on"', "vi", "cảm ơn"], ["التحية", "ar", "التَّحِيَّة"], ["geschaft", "de", "Geschäft"], ["cafes", "fr", "cafés"]] as const) {
    const [hit] = searchThreads(threads, query).find((r) => r.thread.id === id)!.hits
    const [s, e] = hit.marks[0]
    assert.equal(hit.excerpt.slice(s, e), written, query)
  }
  // A text typed with separate accents (as macOS may store it) is found alike, and its marks keep the accents.
  const decomposed = chat("nfd", "Phan hoi", "Pha\u0309n ho\u0302\u0300i ngay.")
  const [hit] = searchThreads([decomposed], "phan hoi")[0].hits
  const [s, e] = hit.marks[0]
  assert.equal(hit.excerpt.slice(s, e).normalize("NFC"), "Phản")
  // The same fold as template search.
  for (const text of ["Phản hồi", "مَرْحَبًا", "Größe", "Crème", "Їжак", "Ёлка"]) assert.equal(foldText(text), unaccent(text), text)
})

// S6: the words that say a field is a site's search, in all 14 languages the app speaks.
test("a site's search field is known by its words in every language the app speaks", () => {
  assert.deepEqual(Object.keys(SEARCH_WORDS).sort(), [...LANGS].sort())
  for (const lang of LANGS) assert.ok(SEARCH_WORDS[lang].length > 0, lang)
  const hints: Record<(typeof LANGS)[number], string> = {
    en: "Search products", ru: "Поиск по сайту", uk: "Пошук товарів", de: "Suchbegriff eingeben", fr: "Rechercher un article",
    es: "Busqueda de productos", it: "Cerca nel negozio", pt: "Pesquisar produtos", ja: "サイト内検索", ko: "상품 검색",
    zh: "搜索商品", "zh-Hant": "搜尋商品", vi: "Tìm kiếm sản phẩm", ar: "ابحث عن منتج"
  }
  for (const lang of LANGS) {
    assert.equal(searchNamed(hints[lang]), true, lang)
    const { document } = parseHTML(`<body><input id="f" type="text" placeholder="${hints[lang]}"></body>`)
    assert.equal(noButtonField(document.getElementById("f")!), true, lang)
  }
  // Ordinary fields keep the button, in any language.
  for (const hint of ["Your name", "Ваше имя", "Ваш відгук", "Ihre Nachricht", "Votre message", "Tu respuesta", "La tua email",
    "Seu comentário", "お名前", "메시지", "留言", "留言內容", "Tin nhắn của bạn", "رسالتك"]) {
    assert.equal(searchNamed(hint), false, hint)
  }
})
