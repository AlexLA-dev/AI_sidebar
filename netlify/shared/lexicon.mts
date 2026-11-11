// The words Find similar's readers look for on pages, in the 14 languages the app speaks (build 95): one place for
// all of them, built the way page watch's are (src/shared/watch/detect.ts): whole phrases in scripts with spaces,
// Russian and Ukrainian words with their endings, Chinese, Japanese and Korean words anywhere. Every reader that
// decides from a page's words (a review page, a review count, a rating, "no longer sold", free, in stock, a length, a
// subscription period, which link to open) takes them from here, so a page in any of these languages is read alike.

import { phrases } from "../../src/shared/watch/detect.ts"

export const LANGS = ["en", "ru", "uk", "de", "fr", "es", "it", "pt", "ja", "ko", "zh", "zh-Hant", "vi", "ar"] as const
export type Lang = (typeof LANGS)[number]
type Words = Record<Lang, string[]>

const all = (w: Words): string[] => [...new Set(Object.values(w).flat())]
/** A phrase list as one pattern; `g` for matching all of them in a text. */
export const pattern = (w: Words, flags = "iu"): RegExp => new RegExp(phrases(all(w)).source, flags)
const alternation = (w: Words): string => all(w).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")

// ------------------------------------------------------------ reviews

/** A search result whose title or address says it reviews or tests something. */
export const REVIEW_PAGE: Words = {
  en: ["review", "reviews", "rating", "ratings", "tested", "test", "tests", "hands-on", "verdict"],
  ru: ["отзыв", "отзывы", "обзор", "рейтинг", "тест"],
  uk: ["відгук", "відгуки", "огляд", "рейтинг", "тест"],
  de: ["test", "testbericht", "bewertung", "erfahrungen", "im test"],
  fr: ["avis", "test", "critique", "essai"],
  es: ["reseña", "reseñas", "opiniones", "análisis", "prueba"],
  it: ["recensione", "recensioni", "prova"],
  pt: ["análise", "avaliação", "avaliações", "review", "teste"],
  ja: ["レビュー", "口コミ", "評価", "使用感"],
  ko: ["리뷰", "후기", "평가", "사용기"],
  zh: ["评测", "评价", "测评", "点评", "开箱"],
  "zh-Hant": ["評測", "評價", "開箱", "心得"],
  vi: ["đánh giá", "trải nghiệm", "review"],
  ar: ["مراجعة", "تقييم", "تجربة"]
}

/** What follows a number of reviews ("687 reviews", "687 Bewertungen", "687件のレビュー"). */
export const REVIEW_COUNTED: Words = {
  en: ["reviews", "review", "ratings", "rating", "verified reviews"],
  ru: ["отзыв", "отзыва", "отзывов", "оценка", "оценки", "оценок"],
  uk: ["відгук", "відгуки", "відгуків", "оцінка", "оцінки", "оцінок"],
  de: ["bewertungen", "bewertung", "rezensionen", "rezension", "sternebewertungen"],
  fr: ["avis", "évaluations", "notes"],
  es: ["reseñas", "valoraciones", "opiniones", "calificaciones"],
  it: ["recensioni", "valutazioni"],
  pt: ["avaliações", "comentários", "classificações"],
  ja: ["件のレビュー", "件の評価", "件のカスタマーレビュー", "件の口コミ"],
  ko: ["개의 리뷰", "개 리뷰", "개의 평가", "건의 리뷰", "개 후기"],
  zh: ["条评价", "条评论", "个评价", "条点评"],
  "zh-Hant": ["則評價", "則評論", "個評價", "則留言"],
  vi: ["đánh giá", "lượt đánh giá", "nhận xét"],
  ar: ["تقييم", "تقييمات", "مراجعة", "مراجعات"]
}

/** What comes before a number of reviews ("리뷰 687개", "评价 (687)", "التقييمات (687)"). */
export const REVIEW_COUNT_FIRST: Words = {
  en: ["reviews", "ratings"], ru: ["отзывы", "оценки"], uk: ["відгуки", "оцінки"], de: ["bewertungen", "rezensionen"],
  fr: ["avis"], es: ["reseñas", "opiniones"], it: ["recensioni"], pt: ["avaliações"],
  ja: ["レビュー", "評価", "口コミ"], ko: ["리뷰", "후기", "상품평", "평가"], zh: ["评价", "评论"], "zh-Hant": ["評價", "評論"],
  vi: ["đánh giá"], ar: ["التقييمات", "المراجعات", "تقييمات"]
}

// A count, with its thousands separated as the language writes them ("1,204", "1.204", "1 204").
const NUM = String.raw`\d{1,3}(?:[,.\u00a0\u202f ]\d{3})+|\d+`
/** A review count in a text: the number (first group or second). */
export const REVIEW_COUNT = new RegExp(
  `(${NUM})\\s*\\+?\\s*(?:${alternation(REVIEW_COUNTED)})(?![\\p{L}])|(?<![\\p{L}])(?:${alternation(REVIEW_COUNT_FIRST)})\\s*[(（:：]?\\s*(${NUM})`,
  "iu"
)

/** The words between a rating and its scale ("4.6 out of 5", "4,6 von 5", "4.6 من 5", "4.6 trên 5"). */
const OUT_OF: Words = {
  en: ["out of", "of", "/"], ru: ["из"], uk: ["з", "із"], de: ["von"], fr: ["sur"], es: ["de", "sobre"], it: ["su", "di"],
  pt: ["de"], ja: ["/"], ko: ["/"], zh: ["/"], "zh-Hant": ["/"], vi: ["trên"], ar: ["من"]
}
const SCORE = String.raw`[1-5](?:[.,]\d{1,2})?`
/**
 * A rating on a 5 scale, its average in the first group found: "4.6 out of 5", "5つ星のうち4.6", "5점 만점에 4.6",
 * "4.6分（满分5分）".
 */
export const RATING_OF_5 = new RegExp(
  [
    `(?<![\\d.,])(${SCORE})\\s*(?:${alternation(OUT_OF)})\\s*5(?![\\d.,])`,
    `5つ星のうち\\s*(${SCORE})`,
    `5\\s*점\\s*만점에?\\s*(${SCORE})`,
    `(?<![\\d.,])(${SCORE})\\s*分?\\s*[（(]?\\s*(?:满分|滿分)\\s*5`
  ].join("|"),
  "iu"
)

/** A heading over a page's own reviews. */
export const REVIEWS_HEAD: Words = {
  en: ["customer reviews", "ratings & reviews", "ratings and reviews", "reviews", "what customers say", "what our customers are saying", "verified buyer", "verified purchase"],
  ru: ["отзывы покупателей", "отзывы клиентов", "отзывы"],
  uk: ["відгуки покупців", "відгуки клієнтів", "відгуки"],
  de: ["kundenbewertungen", "kundenrezensionen", "bewertungen", "rezensionen"],
  fr: ["avis clients", "avis des clients", "avis vérifiés", "commentaires"],
  es: ["opiniones de clientes", "reseñas", "opiniones", "valoraciones"],
  it: ["recensioni dei clienti", "recensioni"],
  pt: ["avaliações de clientes", "avaliações", "comentários"],
  ja: ["カスタマーレビュー", "レビュー", "口コミ", "お客様の声"],
  ko: ["고객 리뷰", "구매후기", "상품평", "리뷰", "후기"],
  zh: ["用户评价", "商品评价", "买家评价", "评价"],
  "zh-Hant": ["顧客評價", "商品評價", "買家評價", "評價"],
  vi: ["đánh giá của khách hàng", "đánh giá sản phẩm", "nhận xét"],
  ar: ["آراء العملاء", "تقييمات العملاء", "المراجعات", "التقييمات"]
}

/** A reviewer marked verified. */
export const VERIFIED: Words = {
  en: ["verified buyer", "verified purchase", "verified customer", "verified reviewer"],
  ru: ["подтвержденная покупка", "подтверждённая покупка", "проверенный покупатель"],
  uk: ["підтверджена покупка", "перевірений покупець"],
  de: ["verifizierter kauf", "verifizierte bewertung", "verifizierter käufer"],
  fr: ["achat vérifié", "avis vérifié", "acheteur vérifié"],
  es: ["compra verificada", "comprador verificado"],
  it: ["acquisto verificato", "acquirente verificato"],
  pt: ["compra verificada", "comprador verificado"],
  ja: ["認証済みの購入", "購入者", "購入済み"],
  ko: ["구매 인증", "구매확인", "실구매"],
  zh: ["已购买", "已验证购买", "已购"],
  "zh-Hant": ["已購買", "已驗證購買"],
  vi: ["đã mua hàng", "đã xác minh"],
  ar: ["مشتري موثق", "عملية شراء موثقة", "شراء موثق"]
}

/** "Was this helpful?" under a review. */
export const HELPFUL: Words = {
  en: ["helpful"], ru: ["полезно", "полезный", "полезен"], uk: ["корисно", "корисний"], de: ["hilfreich"], fr: ["utile"],
  es: ["útil"], it: ["utile"], pt: ["útil"], ja: ["役に立った", "参考になった"], ko: ["도움이 돼요", "도움이 됐어요", "도움됨"],
  zh: ["有用", "有帮助"], "zh-Hant": ["有用", "有幫助"], vi: ["hữu ích"], ar: ["مفيد", "مفيدة"]
}

/** "… ago" by a review's date. */
export const AGO: Words = {
  en: ["days ago", "weeks ago", "months ago", "years ago", "day ago", "week ago", "month ago", "year ago"],
  ru: ["назад"], uk: ["тому"], de: ["vor # tagen", "vor # wochen", "vor # monaten", "vor # jahren", "vor einem tag", "vor einer woche", "vor einem monat", "vor einem jahr"], fr: ["il y a"], es: ["hace"],
  it: ["giorni fa", "settimane fa", "mesi fa", "anni fa"], pt: ["dias atrás", "meses atrás", "anos atrás", "há"],
  ja: ["日前", "週間前", "か月前", "年前"], ko: ["일 전", "주 전", "개월 전", "년 전"], zh: ["天前", "周前", "个月前", "年前"],
  "zh-Hant": ["天前", "週前", "個月前", "年前"], vi: ["ngày trước", "tuần trước", "tháng trước", "năm trước"], ar: ["منذ"]
}

/** Stars by a review ("5 stars", "★", "5 Sterne", "5つ星", "별점 5"). */
export const STARS = /★|\b[1-5](?:[.,]\d)?\s*(?:out of 5|\/ ?5|stars?|звезд\p{L}*|зір\p{L}*|sterne?n?|étoiles?|estrellas?|stelle|estrelas?|sao)\b|[1-5]\s*(?:つ星|점|星|نجوم)|별점\s*[1-5]/iu

// ------------------------------------------------------------ a page that sells nothing now

/** "No longer sold", a listing or a deal that has ended. */
export const GONE: Words = {
  en: ["no longer available", "this item is no longer available", "this item is not available", "product is discontinued", "product discontinued",
    "product unavailable", "listing has ended", "listing ended", "this listing was removed", "this listing has ended", "job is no longer available",
    "no longer accepting applications", "this position has been filled", "this deal has expired", "this deal is expired", "deal expired",
    "expired deal", "this offer has expired", "this offer is expired"],
  ru: ["снят с продажи", "больше не продается", "больше не продаётся", "вакансия в архиве", "вакансия закрыта", "акция завершена", "предложение истекло"],
  uk: ["знято з продажу", "більше не продається", "вакансія закрита", "акція завершена", "пропозиція закінчилася"],
  de: ["nicht mehr verfügbar", "nicht mehr erhältlich", "angebot ist abgelaufen", "angebot abgelaufen", "deal abgelaufen", "artikel wurde entfernt"],
  fr: ["n'est plus disponible", "n'est plus vendu", "n'est plus en vente", "offre expirée", "cette offre a expiré", "annonce expirée"],
  es: ["ya no está disponible", "ya no se vende", "descatalogado", "oferta expirada", "oferta caducada", "anuncio finalizado"],
  it: ["non è più disponibile", "fuori produzione", "non più in vendita", "offerta scaduta", "annuncio scaduto"],
  pt: ["não está mais disponível", "não está mais à venda", "fora de linha", "oferta expirada", "anúncio encerrado"],
  ja: ["販売終了", "取り扱い終了", "生産終了", "掲載終了", "セール終了"],
  ko: ["판매 종료", "판매종료", "단종", "판매 중지"],
  zh: ["已下架", "停产", "停售", "已停售", "活动已结束"],
  "zh-Hant": ["已下架", "停產", "停售", "已停售", "活動已結束"],
  vi: ["ngừng kinh doanh", "ngừng bán", "ngừng sản xuất", "hết hạn khuyến mãi"],
  ar: ["لم يعد متوفرا", "لم يعد متوفرًا", "توقف بيعه", "انتهى العرض", "تم إيقاف المنتج"]
}

// ------------------------------------------------------------ what a quote proves

/** Free of charge. */
export const FREE: Words = {
  en: ["free"], ru: ["бесплатно", "бесплатный", "бесплатная"], uk: ["безкоштовно", "безкоштовний"], de: ["kostenlos", "gratis"],
  fr: ["gratuit", "gratuite"], es: ["gratis", "gratuito", "gratuita"], it: ["gratis", "gratuito", "gratuita"], pt: ["grátis", "gratuito", "gratuita"],
  ja: ["無料"], ko: ["무료"], zh: ["免费"], "zh-Hant": ["免費"], vi: ["miễn phí"], ar: ["مجاني", "مجانا", "مجانًا"]
}

/** "Free" that isn't the item's price (free delivery, a free trial). */
export const NOT_FREE: Words = {
  en: ["free shipping", "free delivery", "free returns", "free return", "free trial", "free estimate", "free quote", "free consultation"],
  ru: ["бесплатная доставка", "бесплатной доставки", "пробный период", "бесплатный возврат"],
  uk: ["безкоштовна доставка", "пробний період"],
  de: ["kostenloser versand", "kostenlose lieferung", "versandkostenfrei", "kostenlose rücksendung", "kostenlos testen", "probeabo"],
  fr: ["livraison gratuite", "retours gratuits", "essai gratuit"],
  es: ["envío gratis", "envío gratuito", "devoluciones gratis", "prueba gratuita", "prueba gratis"],
  it: ["spedizione gratuita", "reso gratuito", "prova gratuita"],
  pt: ["frete grátis", "entrega grátis", "devolução grátis", "teste grátis", "avaliação gratuita"],
  ja: ["送料無料", "無料体験", "無料トライアル", "返品無料"],
  ko: ["무료 배송", "무료배송", "무료 체험", "무료 반품"],
  zh: ["免运费", "包邮", "免费试用", "免费退货"],
  "zh-Hant": ["免運費", "免運", "免費試用", "免費退貨"],
  vi: ["miễn phí vận chuyển", "giao hàng miễn phí", "dùng thử miễn phí"],
  ar: ["شحن مجاني", "توصيل مجاني", "تجربة مجانية", "إرجاع مجاني"]
}

/** Can be bought now. */
export const IN_STOCK: Words = {
  en: ["in stock", "available now", "available to order", "ships today", "ships in", "ships within", "add to cart", "add to bag", "add to basket", "only # left"],
  ru: ["в наличии", "есть в наличии", "доступно для заказа", "добавить в корзину", "осталось #"],
  uk: ["в наявності", "є в наявності", "додати в кошик", "залишилось #"],
  de: ["auf lager", "sofort lieferbar", "lieferbar", "in den warenkorb", "nur noch #"],
  fr: ["en stock", "ajouter au panier", "plus que #"],
  es: ["en stock", "disponible", "añadir al carrito", "añadir a la cesta", "quedan #"],
  it: ["disponibile", "in magazzino", "aggiungi al carrello", "disponibilità immediata"],
  pt: ["em estoque", "disponível", "adicionar ao carrinho", "adicionar à sacola"],
  ja: ["在庫あり", "カートに入れる", "残りわずか", "即納"],
  ko: ["재고 있음", "구매 가능", "장바구니 담기", "바로 구매"],
  zh: ["有货", "现货", "加入购物车", "立即购买"],
  "zh-Hant": ["有貨", "現貨", "加入購物車", "立即購買"],
  vi: ["còn hàng", "thêm vào giỏ hàng", "mua ngay", "chỉ còn #"],
  ar: ["متوفر", "متوفر في المخزون", "أضف إلى السلة", "اشتر الآن", "تبقى #"]
}

/** Hours and minutes in a length ("1 hr 20 mins", "1 Std. 20 Min.", "1時間20分", "1시간 20분"). */
const HOURS: Words = {
  en: ["h", "hr", "hrs", "hour", "hours"], ru: ["ч", "час", "часа", "часов"], uk: ["год", "година", "години", "годин"],
  de: ["std", "stunde", "stunden"], fr: ["h", "heure", "heures"], es: ["h", "hora", "horas"], it: ["h", "ora", "ore"], pt: ["h", "hora", "horas"],
  ja: ["時間"], ko: ["시간"], zh: ["小时"], "zh-Hant": ["小時"], vi: ["giờ"], ar: ["ساعة", "ساعات"]
}
const MINUTES: Words = {
  en: ["m", "min", "mins", "minute", "minutes"], ru: ["мин", "минута", "минуты", "минут"], uk: ["хв", "хвилина", "хвилини", "хвилин"],
  de: ["min", "minute", "minuten"], fr: ["min", "minute", "minutes"], es: ["min", "minuto", "minutos"], it: ["min", "minuto", "minuti"],
  pt: ["min", "minuto", "minutos"], ja: ["分"], ko: ["분"], zh: ["分钟"], "zh-Hant": ["分鐘"], vi: ["phút"], ar: ["دقيقة", "دقائق"]
}
const unit = (w: Words) => `(?:${all(w).sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
export const HOURS_IN = new RegExp(`(\\d+(?:[.,]\\d)?)\\s*${unit(HOURS)}\\.?(?![\\p{L}])`, "iu")
export const MINUTES_IN = new RegExp(`(\\d+)\\s*${unit(MINUTES)}\\.?(?![\\p{L}])`, "iu")

// ------------------------------------------------------------ what an app costs

/** A subscription and its periods. */
export const SUBSCRIPTION: Words = {
  en: ["subscription", "subscribe", "sub"], ru: ["подписка", "подписки"], uk: ["підписка", "передплата"], de: ["abo", "abonnement"],
  fr: ["abonnement"], es: ["suscripción"], it: ["abbonamento"], pt: ["assinatura"], ja: ["サブスクリプション", "定期購入", "月額", "年額"],
  ko: ["구독", "정기 결제"], zh: ["订阅", "包月", "包年"], "zh-Hant": ["訂閱", "訂閱制"], vi: ["gói đăng ký", "đăng ký"], ar: ["اشتراك"]
}
export const WEEK: Words = {
  en: ["week", "weekly", "wk", "wks"], ru: ["неделя", "неделю", "недели", "еженедельно"], uk: ["тиждень", "тижня", "щотижня"],
  de: ["woche", "wöchentlich"], fr: ["semaine", "hebdomadaire"], es: ["semana", "semanal"], it: ["settimana", "settimanale"],
  pt: ["semana", "semanal"], ja: ["週", "週間"], ko: ["주", "주간"], zh: ["周", "每周"], "zh-Hant": ["週", "每週"], vi: ["tuần"], ar: ["أسبوع", "أسبوعي", "أسبوعيًا"]
}
export const MONTH: Words = {
  en: ["month", "monthly", "mo", "mos"], ru: ["месяц", "месяца", "мес", "ежемесячно"], uk: ["місяць", "місяця", "міс", "щомісяця"],
  de: ["monat", "monatlich"], fr: ["mois", "mensuel", "mensuelle"], es: ["mes", "mensual"], it: ["mese", "mensile"], pt: ["mês", "mensal"],
  ja: ["月", "ヶ月", "か月", "月額"], ko: ["월", "개월", "매월"], zh: ["月", "每月", "包月"], "zh-Hant": ["月", "每月"], vi: ["tháng"],
  ar: ["شهر", "شهري", "شهريًا"]
}
export const YEAR: Words = {
  en: ["year", "yearly", "annual", "annually", "yr", "yrs"], ru: ["год", "года", "годовая", "годовой", "ежегодно"], uk: ["рік", "року", "річна", "щороку"],
  de: ["jahr", "jährlich"], fr: ["an", "année", "annuel", "annuelle"], es: ["año", "anual"], it: ["anno", "annuale"], pt: ["ano", "anual"],
  ja: ["年", "年額", "年間"], ko: ["년", "연간", "매년"], zh: ["年", "每年", "包年"], "zh-Hant": ["年", "每年"], vi: ["năm"], ar: ["سنة", "سنوي", "سنويًا"]
}
/** Paid once ("lifetime", "one-time"). */
export const ONE_TIME: Words = {
  en: ["lifetime", "one-time", "one time", "forever", "permanent", "pay once"], ru: ["навсегда", "пожизненно", "пожизненная", "разовая оплата"],
  uk: ["назавжди", "довічно", "довічна", "разова оплата"], de: ["einmalig", "lebenslang", "dauerhaft"], fr: ["à vie", "paiement unique"],
  es: ["de por vida", "pago único"], it: ["a vita", "una tantum", "pagamento unico"], pt: ["vitalício", "pagamento único"],
  ja: ["買い切り", "永久"], ko: ["평생", "일회성", "영구"], zh: ["买断", "永久", "一次性"], "zh-Hant": ["買斷", "永久", "一次性"],
  vi: ["trọn đời", "một lần"], ar: ["مدى الحياة", "دفعة واحدة"]
}
/** A link to an app's or a service's prices. */
export const PRICING_LINK: Words = {
  en: ["pricing", "plans", "prices", "price", "plans & pricing", "plans and pricing", "premium", "upgrade"], ru: ["тарифы", "цены", "стоимость"],
  uk: ["тарифи", "ціни", "вартість"], de: ["preise", "tarife", "preis"], fr: ["tarifs", "prix", "offres"], es: ["precios", "planes", "tarifas"],
  it: ["prezzi", "piani", "tariffe"], pt: ["preços", "planos"], ja: ["料金", "価格", "プラン", "料金プラン"], ko: ["요금", "가격", "요금제", "플랜"],
  zh: ["价格", "定价", "套餐"], "zh-Hant": ["價格", "定價", "方案"], vi: ["bảng giá", "giá", "gói"], ar: ["الأسعار", "الخطط", "الباقات"]
}

// ------------------------------------------------------------ which link to open next, for a condition

const BUY: Words = {
  en: ["price", "prices", "pricing", "plans", "plan", "buy", "shop", "offers", "offer", "deals", "tuition", "fees", "enroll", "enrolment", "tickets", "rates", "booking", "book", "order", "cost"],
  ru: ["цена", "цены", "купить", "тарифы", "стоимость", "заказать", "билеты"], uk: ["ціна", "ціни", "купити", "тарифи", "вартість", "замовити", "квитки"],
  de: ["preise", "preis", "kaufen", "tarife", "tickets", "buchen", "bestellen", "kosten"], fr: ["prix", "tarifs", "acheter", "billets", "réserver", "commander"],
  es: ["precios", "precio", "comprar", "tarifas", "entradas", "reservar", "pedir"], it: ["prezzi", "prezzo", "acquista", "tariffe", "biglietti", "prenota", "ordina"],
  pt: ["preços", "preço", "comprar", "planos", "ingressos", "reservar", "pedir"], ja: ["価格", "料金", "購入", "プラン", "予約", "チケット"],
  ko: ["가격", "구매", "요금", "플랜", "예약", "티켓"], zh: ["价格", "购买", "套餐", "定价", "预订", "门票"], "zh-Hant": ["價格", "購買", "方案", "定價", "預訂", "門票"],
  vi: ["giá", "mua", "bảng giá", "đặt", "vé"], ar: ["السعر", "الأسعار", "شراء", "الخطط", "حجز", "تذاكر"]
}
const FREE_LEADS: Words = {
  en: ["pricing", "plans", "free", "tuition", "fees", "tickets", "admission", "cost"], ru: ["тарифы", "цены", "бесплатно", "стоимость"],
  uk: ["тарифи", "ціни", "безкоштовно", "вартість"], de: ["preise", "tarife", "kostenlos", "eintritt"], fr: ["tarifs", "prix", "gratuit", "entrée"],
  es: ["precios", "planes", "gratis", "entrada"], it: ["prezzi", "piani", "gratis", "ingresso"], pt: ["preços", "planos", "grátis", "entrada"],
  ja: ["料金", "無料", "プラン"], ko: ["요금", "무료", "플랜"], zh: ["价格", "免费", "套餐"], "zh-Hant": ["價格", "免費", "方案"], vi: ["bảng giá", "miễn phí"],
  ar: ["الأسعار", "مجاني", "الخطط"]
}
const WHERE_TO_BUY: Words = {
  en: ["buy", "shop", "offers", "availability", "order", "where to buy", "retailers", "stores", "store locator"],
  ru: ["купить", "наличие", "где купить", "магазины"], uk: ["купити", "наявність", "де купити", "магазини"],
  de: ["kaufen", "verfügbarkeit", "händler", "wo kaufen"], fr: ["acheter", "disponibilité", "magasins", "où acheter"],
  es: ["comprar", "disponibilidad", "tiendas", "dónde comprar"], it: ["acquista", "disponibilità", "negozi", "dove acquistare"],
  pt: ["comprar", "disponibilidade", "lojas", "onde comprar"], ja: ["購入", "在庫", "取扱店"], ko: ["구매", "재고", "매장"],
  zh: ["购买", "库存", "门店"], "zh-Hant": ["購買", "庫存", "門市"], vi: ["mua", "cửa hàng", "còn hàng"], ar: ["شراء", "المتاجر", "التوفر"]
}
const NEWS: Words = {
  en: ["updated", "changelog", "release notes", "what's new", "whats new", "latest", "news", "version"], ru: ["обновление", "что нового", "новости", "версия"],
  uk: ["оновлення", "що нового", "новини", "версія"], de: ["neuigkeiten", "änderungen", "was ist neu", "version"], fr: ["nouveautés", "mises à jour", "version"],
  es: ["novedades", "actualizaciones", "versión"], it: ["novità", "aggiornamenti", "versione"], pt: ["novidades", "atualizações", "versão"],
  ja: ["更新履歴", "新着", "最新情報", "バージョン"], ko: ["업데이트", "새로운 기능", "버전"], zh: ["更新日志", "新功能", "版本"], "zh-Hant": ["更新記錄", "新功能", "版本"],
  vi: ["cập nhật", "có gì mới", "phiên bản"], ar: ["التحديثات", "ما الجديد", "الإصدار"]
}
const LENGTH: Words = {
  en: ["recipe", "jump to recipe", "full recipe", "print", "syllabus", "curriculum", "duration", "schedule", "course details", "agenda"],
  ru: ["рецепт", "программа", "длительность", "расписание"], uk: ["рецепт", "програма", "тривалість", "розклад"],
  de: ["rezept", "lehrplan", "dauer", "zeitplan"], fr: ["recette", "programme", "durée", "horaires"], es: ["receta", "temario", "duración", "horario"],
  it: ["ricetta", "programma", "durata", "orari"], pt: ["receita", "programa", "duração", "horário"], ja: ["レシピ", "カリキュラム", "所要時間"],
  ko: ["레시피", "커리큘럼", "소요 시간"], zh: ["食谱", "课程大纲", "时长"], "zh-Hant": ["食譜", "課程大綱", "時長"], vi: ["công thức", "giáo trình", "thời lượng"],
  ar: ["الوصفة", "المنهج", "المدة"]
}
const DETAILS: Words = {
  en: ["details", "specs", "spec", "specifications", "features", "faq", "apply", "careers", "jobs", "rates", "rooms", "amenities", "policies", "pricing", "plans", "syllabus", "requirements"],
  ru: ["подробнее", "характеристики", "вакансии", "номера", "условия"], uk: ["детальніше", "характеристики", "вакансії", "номери", "умови"],
  de: ["details", "technische daten", "ausstattung", "zimmer", "karriere"], fr: ["détails", "caractéristiques", "chambres", "carrières"],
  es: ["detalles", "especificaciones", "habitaciones", "empleo"], it: ["dettagli", "specifiche", "camere", "lavora con noi"],
  pt: ["detalhes", "especificações", "quartos", "carreiras"], ja: ["詳細", "仕様", "スペック", "客室", "採用"], ko: ["상세", "사양", "객실", "채용"],
  zh: ["详情", "规格", "参数", "客房", "招聘"], "zh-Hant": ["詳情", "規格", "客房", "招募"], vi: ["chi tiết", "thông số", "phòng", "tuyển dụng"],
  ar: ["التفاصيل", "المواصفات", "الغرف", "الوظائف"]
}
export const LEADS = { cheaper: BUY, free: FREE_LEADS, in_stock: WHERE_TO_BUY, newer: NEWS, shorter: LENGTH, other: DETAILS } as const

// ------------------------------------------------------------ an answer that says how many

/** How-many words: an intro never says how many items there are. */
export const HOW_MANY: Words = {
  en: ["one", "two", "three", "four", "five", "six", "couple", "several", "few", "both", "single"],
  ru: ["один", "одна", "одно", "одну", "два", "две", "три", "четыре", "пять", "шесть", "пара", "пару", "пары", "несколько", "оба", "обе"],
  uk: ["один", "одна", "одне", "два", "дві", "три", "чотири", "п'ять", "шість", "пара", "кілька", "декілька", "обидва", "обидві"],
  de: ["eins", "zwei", "drei", "vier", "fünf", "sechs", "einige", "paar", "beide"],
  fr: ["deux", "trois", "quatre", "cinq", "six", "quelques", "plusieurs"],
  es: ["dos", "tres", "cuatro", "cinco", "seis", "algunos", "algunas", "varios", "varias", "ambos"],
  it: ["due", "tre", "quattro", "cinque", "sei", "alcuni", "alcune", "entrambi"],
  pt: ["dois", "duas", "três", "quatro", "cinco", "seis", "alguns", "algumas", "ambos"],
  ja: ["一つ", "二つ", "三つ", "四つ", "五つ", "いくつか", "数点", "2つ", "3つ"],
  ko: ["두 가지", "세 가지", "네 가지", "다섯 가지", "몇 가지", "두 개", "세 개"],
  zh: ["两个", "三个", "四个", "五个", "几个", "两款", "三款", "几款"],
  "zh-Hant": ["兩個", "三個", "四個", "五個", "幾個", "兩款", "三款", "幾款"],
  vi: ["hai", "ba", "bốn", "năm", "sáu", "vài", "một số"],
  ar: ["اثنان", "اثنين", "ثلاثة", "أربعة", "خمسة", "ستة", "بعض", "عدة"]
}

// ------------------------------------------------------------ words that don't tell names apart

/** Function words in names ("the", "für", "de", "và"): left out when names are matched. */
export const NAME_STOP: Words = {
  en: ["the", "a", "an", "and", "or", "of", "for", "with", "by", "in", "on", "to", "at", "from", "vs"],
  ru: ["и", "в", "на", "с", "по", "для", "от", "до", "из", "или", "о", "об", "это", "как"],
  uk: ["і", "й", "та", "в", "у", "на", "з", "із", "для", "від", "до", "або"],
  de: ["der", "die", "das", "und", "für", "mit", "von", "im", "in", "zum", "zur", "oder"],
  fr: ["le", "la", "les", "et", "pour", "avec", "de", "du", "des", "en", "ou"],
  es: ["el", "la", "los", "las", "y", "para", "con", "de", "del", "en", "o"],
  it: ["il", "lo", "la", "gli", "le", "e", "per", "con", "di", "del", "della", "in", "o"],
  pt: ["o", "a", "os", "as", "e", "para", "com", "de", "do", "da", "em", "ou"],
  ja: [], ko: [], zh: [], "zh-Hant": [],
  vi: ["và", "cho", "của", "với", "các", "những"],
  ar: ["و", "في", "من", "على", "مع", "أو"]
}

// ------------------------------------------------------------ delivery

/** Shipping and delivery, as a shop writes it on a link to its delivery page. */
export const SHIPPING: Words = {
  en: ["shipping", "delivery", "postage", "shipping policy", "shipping & returns", "shipping and returns", "delivery information"],
  ru: ["доставка", "доставка и оплата"],
  uk: ["доставка", "доставка і оплата", "доставка та оплата"],
  de: ["versand", "lieferung", "versandkosten", "porto", "versand & lieferung", "lieferinformationen", "versandinformationen"],
  fr: ["livraison", "frais de port", "expédition", "livraison et retours"],
  es: ["envío", "envíos", "envio", "envios", "entrega", "gastos de envío"],
  it: ["spedizione", "spedizioni", "consegna", "costi di spedizione"],
  pt: ["frete", "envio", "entrega", "envios"],
  ja: ["送料", "配送", "配達", "配送について"],
  ko: ["배송", "배송비", "배송안내", "배송 정보", "택배"],
  zh: ["运费", "配送", "快递", "邮费", "配送说明"],
  "zh-Hant": ["運費", "配送", "宅配", "配送說明"],
  vi: ["vận chuyển", "giao hàng", "phí ship", "chính sách giao hàng"],
  ar: ["شحن", "الشحن", "توصيل", "التوصيل", "سياسة الشحن"]
}

/** A delivery page saying it ships anywhere. */
export const WORLDWIDE: Words = {
  en: ["worldwide", "international shipping", "ship internationally", "ships internationally", "all countries", "anywhere in the world", "international delivery"],
  ru: ["по всему миру", "международная доставка", "во все страны"],
  uk: ["по всьому світу", "міжнародна доставка", "у всі країни"],
  de: ["weltweit", "internationaler versand", "in alle länder", "internationale lieferung"],
  fr: ["dans le monde entier", "livraison internationale", "partout dans le monde", "expédition internationale"],
  es: ["a todo el mundo", "envíos internacionales", "envío internacional"],
  it: ["in tutto il mondo", "spedizioni internazionali", "spedizione internazionale"],
  pt: ["para todo o mundo", "envio internacional", "envios internacionais"],
  ja: ["海外発送", "世界中", "国際配送", "海外配送"],
  ko: ["해외배송", "전 세계", "국제 배송", "해외 배송"],
  zh: ["全球配送", "国际配送", "海外直邮", "全球发货"],
  "zh-Hant": ["全球配送", "國際配送", "海外直送"],
  vi: ["toàn cầu", "giao hàng quốc tế", "vận chuyển quốc tế"],
  ar: ["جميع أنحاء العالم", "شحن دولي", "الشحن الدولي"]
}

/** A delivery page naming the European Union or Europe (for a country in it). */
export const EUROPE: Words = {
  en: ["europe", "european union", "eu countries", "within the eu", "to the eu"], ru: ["европа", "евросоюз", "страны ес"],
  uk: ["європа", "євросоюз", "країни єс"], de: ["europa", "eu-länder", "europäische union", "innerhalb der eu"],
  fr: ["europe", "union européenne", "pays de l'ue"], es: ["europa", "unión europea", "países de la ue"],
  it: ["europa", "unione europea", "paesi ue"], pt: ["europa", "união europeia", "países da ue"], ja: ["ヨーロッパ", "欧州"],
  ko: ["유럽"], zh: ["欧洲", "欧盟"], "zh-Hant": ["歐洲", "歐盟"], vi: ["châu âu"], ar: ["أوروبا", "الاتحاد الأوروبي"]
}

// ------------------------------------------------------------ which language a text is in

/**
 * Short words that mark a language in running text, for the languages that share a script with others (Latin,
 * Cyrillic): each list keeps words the others don't use, so counting them tells the language apart. The other
 * shipped languages are told by their letters (pagecheck.mts textLanguage).
 */
export const MARK_WORDS: Record<"en" | "de" | "fr" | "es" | "it" | "pt" | "ru" | "uk", string[]> = {
  en: ["the", "and", "with", "your", "this", "that", "are", "from", "our", "will", "you", "have", "about", "which", "what", "how"],
  de: ["der", "die", "das", "und", "ist", "mit", "für", "nicht", "auf", "ein", "eine", "sie", "sich", "auch", "wir", "werden", "bei", "oder", "zum", "nach"],
  fr: ["les", "et", "est", "des", "pour", "avec", "dans", "sur", "pas", "vous", "nous", "qui", "aux", "cette", "sont", "leur", "très"],
  es: ["los", "las", "y", "es", "por", "sus", "más", "como", "pero", "también", "muy", "del", "hay", "puede", "usted"],
  it: ["gli", "è", "per", "della", "che", "sono", "più", "anche", "nel", "alla", "delle", "questo", "questa", "degli", "molto"],
  pt: ["os", "é", "com", "uma", "dos", "das", "não", "você", "mais", "são", "pelo", "pela", "seu", "sua", "também", "muito"],
  ru: ["что", "это", "как", "или", "все", "они", "мы", "его", "только", "если", "уже", "при"],
  uk: ["що", "це", "як", "або", "всі", "вони", "ми", "його", "тільки", "якщо", "вже", "при"]
}

// ------------------------------------------------------------ the words of a search, by language

/** Words our own searches add, in the plan's language: "<subject> alternatives", "delivery to <country>", "<item>
 * review", and what an item's own page is for an app, a recipe, a course or a book. */
export interface SearchWords { alternatives: string; deliveryTo: (country: string) => string; review: string; app: string; recipe: string; course: string; book: string }
export const SEARCH_WORDS: Record<Lang, SearchWords> = {
  en: { alternatives: "alternatives", deliveryTo: (c) => `delivery to ${c}`, review: "review", app: "app", recipe: "recipe", course: "course", book: "book" },
  ru: { alternatives: "аналоги", deliveryTo: (c) => `доставка ${c}`, review: "отзывы", app: "приложение", recipe: "рецепт", course: "курс", book: "книга" },
  uk: { alternatives: "аналоги", deliveryTo: (c) => `доставка ${c}`, review: "відгуки", app: "застосунок", recipe: "рецепт", course: "курс", book: "книга" },
  de: { alternatives: "Alternativen", deliveryTo: (c) => `Lieferung nach ${c}`, review: "Test", app: "App", recipe: "Rezept", course: "Kurs", book: "Buch" },
  fr: { alternatives: "alternatives", deliveryTo: (c) => `livraison ${c}`, review: "avis", app: "application", recipe: "recette", course: "cours", book: "livre" },
  es: { alternatives: "alternativas", deliveryTo: (c) => `envío a ${c}`, review: "opiniones", app: "app", recipe: "receta", course: "curso", book: "libro" },
  it: { alternatives: "alternative", deliveryTo: (c) => `spedizione ${c}`, review: "recensione", app: "app", recipe: "ricetta", course: "corso", book: "libro" },
  pt: { alternatives: "alternativas", deliveryTo: (c) => `entrega ${c}`, review: "avaliação", app: "app", recipe: "receita", course: "curso", book: "livro" },
  ja: { alternatives: "代わり", deliveryTo: (c) => `${c} 配送`, review: "レビュー", app: "アプリ", recipe: "レシピ", course: "講座", book: "本" },
  ko: { alternatives: "대안", deliveryTo: (c) => `${c} 배송`, review: "후기", app: "앱", recipe: "레시피", course: "강좌", book: "책" },
  zh: { alternatives: "替代品", deliveryTo: (c) => `配送到${c}`, review: "评测", app: "应用", recipe: "食谱", course: "课程", book: "书" },
  "zh-Hant": { alternatives: "替代品", deliveryTo: (c) => `配送到${c}`, review: "評測", app: "應用程式", recipe: "食譜", course: "課程", book: "書" },
  vi: { alternatives: "thay thế", deliveryTo: (c) => `giao hàng ${c}`, review: "đánh giá", app: "ứng dụng", recipe: "công thức", course: "khóa học", book: "sách" },
  ar: { alternatives: "بدائل", deliveryTo: (c) => `توصيل إلى ${c}`, review: "مراجعة", app: "تطبيق", recipe: "وصفة", course: "دورة", book: "كتاب" }
}

/** A BCP 47 tag ("pt-BR", "zh-TW", "uk") as one of the app's languages; English for the others. */
export function appLang(tag: string | undefined): Lang {
  const t = (tag ?? "").replace("_", "-").toLowerCase()
  if (t.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(t) ? "zh-Hant" : "zh"
  const base = t.split("-")[0] as Lang
  return (LANGS as readonly string[]).includes(base) ? base : "en"
}

// ------------------------------------------------------------ words that don't tell names apart

/** Colours a shop adds to a model's name. */
export const COLOURS: Words = {
  en: ["black", "white", "grey", "gray", "blue", "green", "red", "silver", "beige"],
  ru: ["черный", "чёрный", "белый", "серый", "синий", "зеленый", "зелёный", "красный", "серебристый", "бежевый"],
  uk: ["чорний", "білий", "сірий", "синій", "зелений", "червоний", "сріблястий", "бежевий"],
  de: ["schwarz", "weiß", "weiss", "grau", "blau", "grün", "rot", "silber", "beige"],
  fr: ["noir", "blanc", "gris", "bleu", "vert", "rouge", "argent", "beige"],
  es: ["negro", "blanco", "gris", "azul", "verde", "rojo", "plata", "beige"],
  it: ["nero", "bianco", "grigio", "blu", "verde", "rosso", "argento", "beige"],
  pt: ["preto", "branco", "cinza", "azul", "verde", "vermelho", "prata", "bege"],
  ja: ["ブラック", "ホワイト", "グレー", "ブルー", "グリーン", "レッド", "シルバー", "ベージュ"],
  ko: ["블랙", "화이트", "그레이", "블루", "그린", "레드", "실버", "베이지", "검정", "흰색"],
  zh: ["黑色", "白色", "灰色", "蓝色", "绿色", "红色", "银色", "米色"],
  "zh-Hant": ["黑色", "白色", "灰色", "藍色", "綠色", "紅色", "銀色", "米色"],
  vi: ["đen", "trắng", "xám", "xanh", "đỏ", "bạc", "be"],
  ar: ["أسود", "أبيض", "رمادي", "أزرق", "أخضر", "أحمر", "فضي", "بيج"]
}

/** What a shop adds to any name: new, buy, sale, edition, set, kit. */
export const SHOP_WORDS: Words = {
  en: ["new", "shop", "buy", "sale", "edition", "set", "kit"],
  ru: ["новый", "новинка", "купить", "магазин", "распродажа", "издание", "набор", "комплект"],
  uk: ["новий", "новинка", "купити", "магазин", "розпродаж", "видання", "набір", "комплект"],
  de: ["neu", "kaufen", "shop", "angebot", "edition", "set", "kit"],
  fr: ["nouveau", "acheter", "boutique", "soldes", "édition", "coffret", "kit"],
  es: ["nuevo", "comprar", "tienda", "oferta", "edición", "set", "kit"],
  it: ["nuovo", "acquista", "negozio", "offerta", "edizione", "set", "kit"],
  pt: ["novo", "comprar", "loja", "oferta", "edição", "kit"],
  ja: ["新品", "新作", "購入", "通販", "セール", "限定", "セット"],
  ko: ["신상", "신제품", "구매", "할인", "세트", "에디션"],
  zh: ["新款", "购买", "促销", "套装", "限量版"],
  "zh-Hant": ["新款", "購買", "促銷", "套裝", "限量版"],
  vi: ["mới", "mua", "cửa hàng", "khuyến mãi", "phiên bản", "bộ"],
  ar: ["جديد", "شراء", "متجر", "تخفيضات", "إصدار", "مجموعة"]
}

/** A page title's usual extras around a name: best, top, official site, app, free, online, review. */
export const NAME_EXTRAS: Words = {
  en: ["best", "top", "new", "official", "site", "app", "apps", "free", "online", "buy", "shop", "review", "reviews"],
  ru: ["лучший", "лучшие", "топ", "официальный", "сайт", "приложение", "бесплатно", "онлайн", "купить", "отзывы", "обзор"],
  uk: ["найкращий", "найкращі", "топ", "офіційний", "сайт", "застосунок", "безкоштовно", "онлайн", "купити", "відгуки", "огляд"],
  de: ["beste", "besten", "top", "offiziell", "offizielle", "app", "kostenlos", "online", "kaufen", "test", "bewertungen"],
  fr: ["meilleur", "meilleurs", "top", "officiel", "site", "application", "gratuit", "en ligne", "acheter", "avis"],
  es: ["mejor", "mejores", "top", "oficial", "sitio", "aplicación", "gratis", "online", "comprar", "opiniones"],
  it: ["migliore", "migliori", "top", "ufficiale", "sito", "app", "gratis", "online", "acquista", "recensioni"],
  pt: ["melhor", "melhores", "top", "oficial", "site", "aplicativo", "grátis", "online", "comprar", "avaliações"],
  ja: ["おすすめ", "公式", "サイト", "アプリ", "無料", "オンライン", "レビュー", "通販"],
  ko: ["추천", "공식", "사이트", "앱", "무료", "온라인", "리뷰", "후기"],
  zh: ["推荐", "官方", "官网", "应用", "免费", "在线", "评测"],
  "zh-Hant": ["推薦", "官方", "官網", "應用程式", "免費", "線上", "評測"],
  vi: ["tốt nhất", "chính hãng", "trang", "ứng dụng", "miễn phí", "trực tuyến", "đánh giá"],
  ar: ["أفضل", "رسمي", "موقع", "تطبيق", "مجاني", "أونلاين", "مراجعة"]
}

/** Every word of these lists as names are compared: lower case, accents folded (pagecheck.mts nameTokens). */
export const foldedWords = (...lists: Words[]): string[] => [...new Set(lists.flatMap(all).flatMap((w) => w.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean))]

/** Paid every three months. */
export const QUARTER: Words = {
  en: ["quarter", "quarterly"], ru: ["квартал", "ежеквартально"], uk: ["квартал", "щокварталу"], de: ["quartal", "vierteljährlich"],
  fr: ["trimestre", "trimestriel"], es: ["trimestre", "trimestral"], it: ["trimestre", "trimestrale"], pt: ["trimestre", "trimestral"],
  ja: ["四半期"], ko: ["분기"], zh: ["季度", "季付"], "zh-Hant": ["季度", "季繳"], vi: ["quý"], ar: ["ربع سنوي"]
}
