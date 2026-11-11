// Find similar across scripts and languages: CJK by share, Vietnamese by its own letters, colours in every gender,
// phrases kept whole, shared currency signs by domain, month names as sites write them, sizes in any script.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { languageCheck, nameTokens, readPrice, textLanguage } = await import("../netlify/shared/pagecheck.mts")
const { distinctive, sameAsSubject } = await import("../netlify/shared/similar.mts")
const { quoteFacts } = await import("../netlify/shared/dig.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
const plan = (subject: string, traits: string[] = []): Plan => ({
  category: "product", subject, traits, condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "", queries: ["q"], language: "en"
})
const page = (text: string) => ({ lang: "", title: "", text, inLanguage: undefined })

test("Chinese, Japanese and Korean by their share of the text: a foreign product name doesn't change the language", () => {
  const tw = "這款收納箱來自日本無印良品のポリプロピレン系列，耐用又好清潔，適合放在衣櫃或書櫃裡，我們提供台灣全島宅配服務，購買後三天內出貨。"
  assert.equal(textLanguage(tw).lang, "zh-Hant")
  assert.equal(languageCheck("zh-Hant", page(tw)), "yes")
  const ja = "このクリームはイニスフリーの人気商品で、이니스프리 グリーンティーシリーズのひとつです。乾燥肌にもやさしく、毎日使えます。"
  assert.equal(textLanguage(ja).lang, "ja")
  assert.equal(languageCheck("ja", page(ja)), "yes")
  assert.equal(textLanguage("이 크림은 민감한 피부에도 순하고 매일 사용할 수 있는 진정 크림입니다. 무향이며 빠르게 흡수됩니다.").lang, "ko")
})

test("Vietnamese by the letters only it writes; Romanian and Dutch aren't Vietnamese or German", () => {
  assert.equal(textLanguage("Hướng dẫn này giải thích cách chọn ấm đun nước cho nhà bếp của bạn, với các mẹo về kích thước.").lang, "vi")
  const ro = "Această cană este făcută din ceramică și poate fi spălată în mașina de spălat vase. Livrăm în toată țara în două zile lucrătoare."
  assert.notEqual(textLanguage(ro).lang, "vi")
  assert.equal(languageCheck("vi", page(ro)), "unknown")
  assert.notEqual(textLanguage("Deze stoel is gemaakt van eikenhout en die past goed in elke kamer, die ook licht is. Wij leveren in heel Nederland.").lang, "de")
})

test("a colour or a shop's word in any gender tells no item apart", () => {
  const p = plan("x")
  assert.deepEqual(distinctive("Кресло офисное Zento черное", p), ["кресло", "офисное", "zento"])
  assert.deepEqual(distinctive("Крісло Zento чорна", p), ["крісло", "zento"])
  assert.deepEqual(distinctive("Chaise Zento noire", p), ["chaise", "zento"])
  assert.deepEqual(distinctive("Silla Zento negra", p), ["silla", "zento"])
  assert.deepEqual(distinctive("Sedia Zento nera", p), ["sedia", "zento"])
  assert.deepEqual(distinctive("Cadeira Zento preta nova", p), ["cadeira", "zento"])
})

test("a title's extras of several words go whole: a Vietnamese name keeps its syllables", () => {
  assert.deepEqual(nameTokens("Bàn làm việc Ergo X2 chính hãng"), ["ban", "lam", "viec", "ergo", "x2"])
  assert.ok(nameTokens("Nồi cơm điện gia dụng Sunhouse").includes("gia"))
  assert.ok(nameTokens("Tour Nha Trang 3 ngày").includes("trang"))
  assert.ok(nameTokens("Kem trang điểm Lumo").includes("trang"))
})

test("a sign several currencies share by the shop's domain: 元 in Taiwan and Hong Kong, CA$ and AU$", () => {
  assert.equal(readPrice("1,290元", "", "https://shop.example.com.tw/p")?.currency, "TWD")
  assert.equal(readPrice("499元", "", "https://shop.example.com.hk/p")?.currency, "HKD")
  assert.equal(readPrice("1,290元", "", "https://shop.example.cn/p")?.currency, "CNY")
  assert.equal(readPrice("CA$99", "", "")?.currency, "CAD")
  assert.equal(readPrice("AU$149", "", "")?.currency, "AUD")
})

test("month names as sites write them: Arabic without hamza and the Maghreb's, abbreviations, no accents", () => {
  for (const q of ["4 ابريل 2026", "4 اكتوبر 2026", "4 اغسطس 2026", "4 اذار 2026", "4 جانفي 2026", "4 فيفري 2026", "4 أفريل 2026", "4 جوان 2026", "4 جويلية 2026", "4 أوت 2026", "4 شتنبر 2026", "4 نونبر 2026", "4 دجنبر 2026",
    "4 мар. 2026", "4 июн. 2026", "4 июл. 2026", "4 бер. 2026", "4 квіт. 2026", "4 лист. 2026", "4. Mär. 2026", "4. Mrz. 2026", "4 fév. 2026", "4 aout 2026", "4 fevrier 2026", "4 tháng 3, 2026"]) {
    assert.ok(quoteFacts("newer", q)?.published, q)
  }
  assert.equal(quoteFacts("newer", "4 جويلية 2026")?.published, "2026-07-04T00:00:00.000Z")
})

test("a size in any script isn't a model word: «128 ГБ», «128ГБ», «128기가»", () => {
  assert.ok(sameAsSubject("Apple iPhone 15 128GB черный", plan("Смартфон Apple iPhone 15 128 ГБ", ["смартфон"])))
  assert.ok(sameAsSubject("Apple iPhone 15 128GB", plan("Apple iPhone 15 128ГБ")))
  assert.ok(sameAsSubject("Galaxy S24 256GB", plan("갤럭시 Galaxy S24 128기가")))
  assert.ok(!sameAsSubject("Apple iPhone 16 128GB", plan("Apple iPhone 15 128 ГБ")))
})
