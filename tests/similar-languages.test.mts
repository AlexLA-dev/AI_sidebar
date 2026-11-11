// Build 95: Find similar reads pages in every language the app speaks (netlify/shared/lexicon.mts). One test a language:
// a review page's title, a rating with its count in a product header, a page's own reviews, "no longer sold", what a
// quote proves (free, not free, in stock, out of stock, a length), a subscription's period, a link to prices, the link
// to open next for "cheaper", and an intro that says how many.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, reviewsSection, textRating } = await import("../netlify/shared/pagecheck.mts")
const { nextPages, quoteFacts } = await import("../netlify/shared/dig.mts")
const { plansPricing, pricingLinks } = await import("../netlify/shared/apppricing.mts")
const { saysCount } = await import("../netlify/shared/similar.mts")
const { LANGS, REVIEW_PAGE, pattern } = await import("../netlify/shared/lexicon.mts")

interface Sample {
  reviewTitle: string
  header: string
  head: string
  review: string
  gone: string
  free: string
  notFree: string
  inStock: string
  outStock: string
  length: [string, number]
  perMonth: [string, string]
  pricing: string
  lead: string
  howMany: string
}

const SAMPLES: Record<(typeof LANGS)[number], Sample> = {
  en: { reviewTitle: "Sony WH-CH720N review: tested for a month", header: "Rated 4.3 out of 5 · 1,204 reviews", head: "Customer reviews", review: "Verified purchase · 2 weeks ago. Comfortable for long flights. Was this helpful?", gone: "This item is no longer available", free: "Free to download", notFree: "Free shipping", inStock: "In stock — ships today", outStock: "Currently out of stock", length: ["Total time: 1 hr 20 mins", 4800], perMonth: ["$9.99", "$9.99 per month"], pricing: "Pricing", lead: "Pricing", howMany: "Here are two options like yours." },
  ru: { reviewTitle: "Обзор Sony WH-CH720N: тест за месяц", header: "Рейтинг 4,3 из 5 · 1 204 отзыва", head: "Отзывы покупателей", review: "Подтвержденная покупка · 2 недели назад. Удобно в долгих перелётах. Полезно", gone: "Товар снят с продажи", free: "Бесплатно", notFree: "Бесплатная доставка", inStock: "В наличии", outStock: "Нет в наличии", length: ["Время: 1 час 20 минут", 4800], perMonth: ["299 ₽", "299 ₽ в месяц"], pricing: "Тарифы", lead: "Цены", howMany: "Вот два варианта, похожих на ваш." },
  uk: { reviewTitle: "Огляд навушників Sony WH-CH720N", header: "Оцінка 4,3 з 5 · 1 204 відгуки", head: "Відгуки покупців", review: "Підтверджена покупка · 2 тижні тому. Зручні в довгих перельотах. Корисно", gone: "Товар знято з продажу", free: "Безкоштовно", notFree: "Безкоштовна доставка", inStock: "В наявності", outStock: "Немає в наявності", length: ["Тривалість: 1 година 20 хвилин", 4800], perMonth: ["99 грн", "99 грн на місяць"], pricing: "Тарифи", lead: "Ціни", howMany: "Ось два варіанти, схожі на ваш." },
  de: { reviewTitle: "Sony WH-CH720N im Test", header: "4,3 von 5 · 1.204 Bewertungen", head: "Kundenbewertungen", review: "Verifizierter Kauf · vor 2 Wochen. Bequem auf langen Flügen. Hilfreich", gone: "Dieser Artikel ist nicht mehr verfügbar", free: "Kostenlos", notFree: "Kostenloser Versand", inStock: "Auf Lager, sofort lieferbar", outStock: "Ausverkauft", length: ["Dauer: 1 Std. 20 Min.", 4800], perMonth: ["9,99 €", "9,99 € pro Monat"], pricing: "Preise", lead: "Preise", howMany: "Hier sind zwei Optionen wie Ihre." },
  fr: { reviewTitle: "Test et avis : Sony WH-CH720N", header: "4,3 sur 5 · 1 204 avis", head: "Avis clients", review: "Achat vérifié · il y a 2 semaines. Confortable en avion. Utile", gone: "Ce produit n'est plus disponible", free: "Gratuit", notFree: "Livraison gratuite", inStock: "En stock", outStock: "Rupture de stock", length: ["Durée : 1 heure 20 minutes", 4800], perMonth: ["9,99 €", "9,99 € par mois"], pricing: "Tarifs", lead: "Tarifs", howMany: "Voici deux options comme la vôtre." },
  es: { reviewTitle: "Reseña de los Sony WH-CH720N: prueba", header: "4,3 de 5 · 1.204 reseñas", head: "Opiniones de clientes", review: "Compra verificada · hace 2 semanas. Cómodos en vuelos largos. Útil", gone: "Este producto ya no está disponible", free: "Gratis", notFree: "Envío gratis", inStock: "En stock", outStock: "Agotado", length: ["Duración: 1 hora 20 minutos", 4800], perMonth: ["9,99 €", "9,99 € al mes"], pricing: "Precios", lead: "Precios", howMany: "Aquí tienes dos opciones como la tuya." },
  it: { reviewTitle: "Recensione Sony WH-CH720N: la prova", header: "4,3 su 5 · 1.204 recensioni", head: "Recensioni dei clienti", review: "Acquisto verificato · 2 settimane fa. Comode nei voli lunghi. Utile", gone: "Questo prodotto non è più disponibile", free: "Gratis", notFree: "Spedizione gratuita", inStock: "Disponibile", outStock: "Esaurito", length: ["Durata: 1 ora 20 minuti", 4800], perMonth: ["9,99 €", "9,99 € al mese"], pricing: "Prezzi", lead: "Prezzi", howMany: "Ecco due opzioni come la tua." },
  pt: { reviewTitle: "Análise do Sony WH-CH720N: teste", header: "4,3 de 5 · 1.204 avaliações", head: "Avaliações de clientes", review: "Compra verificada · há 2 semanas. Confortável em voos longos. Útil", gone: "Este produto não está mais disponível", free: "Grátis", notFree: "Frete grátis", inStock: "Em estoque", outStock: "Esgotado", length: ["Duração: 1 hora 20 minutos", 4800], perMonth: ["R$ 29,90", "R$ 29,90 por mês"], pricing: "Preços", lead: "Preços", howMany: "Aqui estão duas opções como a sua." },
  ja: { reviewTitle: "Sony WH-CH720N レビュー", header: "5つ星のうち4.3 1,204件の評価", head: "カスタマーレビュー", review: "認証済みの購入 2週間前。長時間のフライトでも快適です。役に立った", gone: "この商品は販売終了しました", free: "無料", notFree: "送料無料", inStock: "在庫あり", outStock: "在庫切れ", length: ["所要時間：1時間20分", 4800], perMonth: ["¥980", "¥980/月"], pricing: "料金", lead: "料金", howMany: "二つの候補があります。" },
  ko: { reviewTitle: "Sony WH-CH720N 리뷰", header: "5점 만점에 4.3 · 리뷰 1,204개", head: "고객 리뷰", review: "구매 인증 · 2주 전. 장거리 비행에도 편안해요. 도움이 돼요", gone: "판매 종료된 상품입니다", free: "무료", notFree: "무료 배송", inStock: "재고 있음", outStock: "품절", length: ["소요 시간: 1시간 20분", 4800], perMonth: ["9,900원", "월 9,900원"], pricing: "요금제", lead: "가격", howMany: "두 가지 제품을 찾았어요." },
  zh: { reviewTitle: "Sony WH-CH720N 评测", header: "4.3分（满分5分）· 1,204条评价", head: "用户评价", review: "已购买 · 2周前。长途飞行也很舒适。有用", gone: "该商品已下架", free: "免费", notFree: "包邮", inStock: "有货", outStock: "缺货", length: ["时长：1小时20分钟", 4800], perMonth: ["¥68", "¥68/月"], pricing: "价格", lead: "价格", howMany: "这里有两个选择。" },
  "zh-Hant": { reviewTitle: "Sony WH-CH720N 評測", header: "4.3分（滿分5分）· 1,204則評價", head: "顧客評價", review: "已購買 · 2週前。長途飛行也很舒適。有幫助", gone: "此商品已下架", free: "免費", notFree: "免運費", inStock: "有貨", outStock: "缺貨", length: ["時長：1小時20分鐘", 4800], perMonth: ["$150", "$150/月"], pricing: "價格", lead: "價格", howMany: "這裡有兩個選擇。" },
  vi: { reviewTitle: "Đánh giá tai nghe Sony WH-CH720N", header: "4,3 trên 5 · 1.204 đánh giá", head: "Đánh giá của khách hàng", review: "Đã mua hàng · 2 tuần trước. Thoải mái khi bay đường dài. Hữu ích", gone: "Sản phẩm ngừng kinh doanh", free: "Miễn phí", notFree: "Miễn phí vận chuyển", inStock: "Còn hàng", outStock: "Hết hàng", length: ["Thời lượng: 1 giờ 20 phút", 4800], perMonth: ["99.000đ", "99.000đ/tháng"], pricing: "Bảng giá", lead: "Bảng giá", howMany: "Đây là hai lựa chọn giống của bạn." },
  ar: { reviewTitle: "مراجعة سماعات Sony WH-CH720N", header: "4.3 من 5 · 1,204 تقييم", head: "آراء العملاء", review: "مشتري موثق · منذ أسبوعين. مريحة في الرحلات الطويلة. مفيد", gone: "هذا المنتج لم يعد متوفرا", free: "مجاني", notFree: "شحن مجاني", inStock: "متوفر في المخزون", outStock: "غير متوفر", length: ["المدة: 1 ساعة 20 دقيقة", 4800], perMonth: ["$9.99", "$9.99 شهريًا"], pricing: "الأسعار", lead: "الأسعار", howMany: "إليك ثلاثة خيارات مثل خيارك." }
}

const filler = "A pair of wireless over-ear headphones with noise cancelling, a long battery and a light, foldable build. ".repeat(6)
const page = (lang: string, body: string, title = "Headphones") =>
  `<html lang="${lang}"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${filler}</p>${body}</main></body></html>`

for (const lang of LANGS) {
  const s = SAMPLES[lang]
  test(`Find similar reads pages in ${lang}`, () => {
    assert.ok(pattern(REVIEW_PAGE).test(s.reviewTitle), "a review page's title")
    const rating = textRating(`${s.header}\n${filler}`)
    assert.deepEqual(rating, { value: 4.3, best: 5, count: 1204 }, "the rating and its count in a header")
    const reviews = reviewsSection(page(lang, `<h2>${s.head}</h2>${`<div><p>${s.review}</p></div>`.repeat(6)}`))
    assert.ok(reviews, "the page's own reviews")
    const gone = describePage(page(lang, `<p>${s.gone}</p>`), "https://shop.test/p", "https://shop.test/p", 200, 0)
    assert.equal(gone.reason, "unavailable", "no longer sold")
    assert.deepEqual(quoteFacts("free", s.free), { price: { amount: 0, currency: "" } }, "free")
    assert.equal(quoteFacts("free", s.notFree), null, "free delivery isn't a free item")
    assert.deepEqual(quoteFacts("in_stock", s.inStock), { stock: "in" }, "in stock")
    assert.deepEqual(quoteFacts("in_stock", s.outStock), { stock: "out" }, "out of stock")
    assert.deepEqual(quoteFacts("shorter", s.length[0]), { duration: s.length[1] }, "a length")
    const sub = plansPricing([{ name: "Pro", price: s.perMonth[0], period: "month" }], false, `Pro ${s.perMonth[1]}`, "https://app.test/pricing")
    assert.equal(sub?.period, "month", "a monthly price")
    assert.deepEqual(pricingLinks(`<a href="/x">${s.pricing}</a>`, "https://app.test/"), ["https://app.test/x"], "a link to prices")
    const item = { ...describePage(page(lang, ""), "https://shop.test/p", "https://shop.test/p", 200, 0), links: [{ url: "https://shop.test/about", text: "About" }, { url: "https://shop.test/x1", text: s.lead }] }
    assert.deepEqual(nextPages(item, "cheaper", "Headphones", false).map((n) => n.url), ["https://shop.test/x1"], "the link to open next for cheaper")
    assert.equal(saysCount(s.howMany), true, "an intro that says how many")
  })
}
