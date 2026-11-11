// Build 95, the owner: «Важно вообще весь код проверить на наличие таких подгонов под меня, их быть не должно. И при
// этом все описанные в заданиях и чате требования и ожидания должны эффективно работать». The director's check found
// rules that knew English and Russian only; these hold them to every language.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { actionLabel, pdfName } from "../src/content/pdf.ts"
import { normalize, searchTemplates } from "../src/shared/templates.ts"

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
    REVIEW_SEARCH_SYSTEM: similar.REVIEW_SEARCH_SYSTEM, REVIEW_READ_SYSTEM: similar.REVIEW_READ_SYSTEM, SCRIPT_RULES
  }
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text && text.length > 100, name)
    // A price in an example teaches the model that price; placeholders say "<its price as the page shows it>".
    assert.doesNotMatch(text, /[€£¥₽₴₹₩₫]\s?\d|\d\s?[€£¥₽₴₹₩₫]|\$\s?\d|\b\d+(?:[.,]\d+)? ?(?:EUR|USD|GBP|RUB|UAH|JPY|dollars|euros)\b/i, name)
    assert.doesNotMatch(text, /airback|backvac|vacpack|fanwoli|ryden|markus|sihoo|kallax|poäng|lego|ikea|cyprus|кипр|stephanis/i, name)
  }
})
