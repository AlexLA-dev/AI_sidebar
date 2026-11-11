// Page watch (2.5): is a selection something worth watching? The eye shows by a selection only for a price,
// stock, a date or a status; ordinary text keeps the bubble as it was (Ask, Google, Template).
// Words for the 14 languages the panel speaks (Traditional Chinese, Arabic and Vietnamese since 2.6). Short selections only: a sentence is text, not a value.

export type WatchWhat = "price" | "stock" | "date" | "status"

const MAX_LEN = 80

// Symbols and words that sit right by a number, in any case ("40 usd" on some shops).
const SYMBOLS =
  String.raw`US\$|R\$|C\$|A\$|HK\$|NZ\$|S\$|NT\$|MX\$|[$€£¥￥₩₽₴₹₺₪฿₫₸₾₼₱]|zł|Kč|kr\.?|lei|лв\.?|руб\.?|р\.|грн\.?|円|元|원` +
  // Vietnamese dong as shops write it ("299.000đ", "299.000 VNĐ"); the Gulf's and Egypt's riyal, dirham, dinar, pound.
  String.raw`|vnđ|đ|ر\.\s?س\.?|د\.\s?إ\.?|ر\.\s?ع\.?|د\.\s?ك\.?|ر\.\s?ق\.?|د\.\s?ب\.?|ج\.\s?م\.?|ريال|درهم|دينار|جنيه|ل\.\s?س\.?`
// The codes shops also write in small letters, which are never words.
const SMALL_CODES = "usd|eur|gbp|chf|jpy|cny|rmb|rub|uah|pln|sek|nok|dkk|czk|huf|brl|inr|krw|aud|cad|nzd|sgd|hkd|mxn"
// ISO 4217 codes, in capitals only: in small letters some are words ("try 3", "mad 10"); ALL, CUP, SOS and TOP
// stay out ("TOP 10", "ALL 40 ITEMS" in headlines).
const CODES = [
  "AED", "AFN", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD",
  "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CVE",
  "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF",
  "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS",
  "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR",
  "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RMB", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG",
  "SEK", "SGD", "SHP", "SLE", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TRY", "TTD",
  "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR",
  "ZMW", "ZWL"
].join("|")
const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f.,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
// A price is a number with a currency right before or after it ("USD 40", "40 EUR", "CHF 12.–"), not inside a word.
const priceSource = (cur: string) =>
  String.raw`(?:(?<![\p{L}])(?:${cur})\s?(?:${NUMBER})(?:\.[-–—])?)|(?:(?:${NUMBER})(?:\.[-–—])?\s?(?:${cur})(?![\p{L}]))`
// Two patterns: symbols and small-letter codes in any case, ISO codes in capitals only (no inline case flags: older
// Safari lacks them).
const PRICE_ANY = new RegExp(priceSource(`${SYMBOLS}|${SMALL_CODES}`), "iu")
const PRICE_CODE = new RegExp(priceSource(CODES), "u")
const PRICE = { test: (s: string) => PRICE_ANY.test(s) || PRICE_CODE.test(s) }

/** The first price a text states, in any of the panel's currencies and ways of writing them (null: none). */
export function firstPrice(text: string): string | null {
  return prices(text)[0] ?? null
}

/** Every price in a text, in order (both patterns). */
function prices(text: string): string[] {
  const found = [...text.matchAll(new RegExp(PRICE_ANY.source, "giu")), ...text.matchAll(new RegExp(PRICE_CODE.source, "gu"))]
  return found.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((m) => m[0].trim())
}

// Stock: phrases a shop shows by its buy button. Lower case; "#" stands for a number ("only 3 left").
const STOCK_WORDS = [
  // en
  "in stock", "out of stock", "sold out", "available", "unavailable", "currently unavailable", "back in stock",
  "pre-order", "preorder", "coming soon", "add to cart", "add to bag", "notify me", "low stock", "backorder",
  "discontinued", "temporarily out of stock", "only # left", "# left in stock",
  // ru
  "в наличии", "нет в наличии", "распродано", "нет на складе", "под заказ", "ожидается", "скоро в продаже",
  "закончился", "товар закончился", "предзаказ", "осталось #", "доступно для заказа", "недоступно",
  // uk
  "в наявності", "є в наявності", "немає в наявності", "розпродано", "під замовлення", "очікується",
  "закінчився", "передзамовлення",
  // de
  "auf lager", "nicht auf lager", "ausverkauft", "lieferbar", "nicht lieferbar", "sofort lieferbar", "verfügbar",
  "nicht verfügbar", "derzeit nicht verfügbar", "vorbestellen", "bald verfügbar", "nur noch #",
  // fr
  "en stock", "rupture de stock", "en rupture de stock", "épuisé", "épuisée", "disponible", "indisponible",
  "précommande", "bientôt disponible", "plus que #",
  // es
  "agotado", "agotada", "sin stock", "no disponible", "preventa", "próximamente", "quedan #",
  // it
  "disponibile", "non disponibile", "esaurito", "esaurita", "in magazzino", "preordine", "prossimamente",
  "disponibilità immediata",
  // pt
  "em estoque", "esgotado", "esgotada", "fora de estoque", "disponível", "indisponível", "pré-venda", "em breve",
  // ja
  "在庫あり", "在庫切れ", "在庫なし", "品切れ", "売り切れ", "入荷待ち", "予約受付中", "販売終了", "残りわずか", "近日発売",
  // ko
  "재고 있음", "재고 없음", "품절", "일시품절", "입고 예정", "예약 판매", "구매 가능", "판매 종료",
  // zh
  "有货", "无货", "缺货", "售罄", "已售完", "现货", "预售", "到货通知", "即将上市", "库存紧张",
  // zh-Hant
  "有貨", "無貨", "缺貨", "售完", "已售完", "已售罄", "完售", "現貨", "預購", "預售", "到貨通知", "即將上市", "庫存緊張",
  "補貨中", "暫時缺貨",
  // ar
  "متوفر", "متوفر في المخزون", "متاح", "متوفر الآن", "غير متوفر", "غير متاح", "غير متوفر حاليًا", "نفد", "نفدت الكمية",
  "نفذت الكمية", "نفد من المخزون", "نفدت الكمية مؤقتًا", "قريبًا", "طلب مسبق", "أضف إلى السلة", "تبقى #", "متبقي #",
  // vi
  "còn hàng", "hết hàng", "tạm hết hàng", "đặt trước", "sắp có hàng", "hàng sắp về", "sắp ra mắt", "ngừng kinh doanh",
  "chỉ còn #", "còn # sản phẩm", "thêm vào giỏ hàng", "cháy hàng"
]

// Statuses: an application, an order, a registration, an event. A few words at most.
const STATUS_WORDS = [
  // en
  "approved", "pending", "processing", "shipped", "delivered", "in transit", "out for delivery", "received",
  "rejected", "declined", "accepted", "cancelled", "canceled", "on hold", "under review", "confirmed", "completed",
  "waitlist", "waitlisted", "registration open", "registration closed", "tickets on sale", "on sale now",
  "postponed", "rescheduled", "case was approved", "case was received", "open", "closed", "status",
  // ru
  "статус", "одобрено", "одобрен", "на рассмотрении", "в обработке", "отправлен", "отправлено", "доставлен",
  "доставлено", "в пути", "получен", "получено", "отклонено", "отклонён", "принято", "принят", "отменено", "отменён",
  "подтверждено", "завершено", "регистрация открыта", "регистрация закрыта", "приём заявок", "перенесено", "открыто",
  "закрыто", "лист ожидания",
  // uk
  "схвалено", "на розгляді", "в обробці", "відправлено", "в дорозі", "отримано", "відхилено", "прийнято",
  "скасовано", "підтверджено", "реєстрація відкрита", "реєстрація закрита",
  // de
  "genehmigt", "ausstehend", "in bearbeitung", "versandt", "versendet", "zugestellt", "unterwegs", "eingegangen",
  "abgelehnt", "angenommen", "storniert", "abgesagt", "bestätigt", "abgeschlossen", "warteliste", "anmeldung offen",
  "anmeldung geschlossen", "verschoben",
  // fr
  "statut", "approuvé", "approuvée", "en attente", "en cours", "en cours de traitement", "expédié", "expédiée",
  "livré", "livrée", "en transit", "reçu", "reçue", "refusé", "refusée", "accepté", "acceptée", "annulé", "annulée",
  "confirmé", "confirmée", "terminé", "liste d'attente", "inscriptions ouvertes", "inscriptions closes", "reporté",
  // es
  "estado", "aprobado", "aprobada", "pendiente", "en proceso", "enviado", "enviada", "entregado", "entregada",
  "en tránsito", "recibido", "recibida", "rechazado", "rechazada", "aceptado", "aceptada", "cancelado", "cancelada",
  "confirmado", "confirmada", "completado", "lista de espera", "inscripciones abiertas", "inscripciones cerradas",
  "aplazado",
  // it
  "stato", "approvato", "approvata", "in attesa", "in lavorazione", "spedito", "spedita", "consegnato", "consegnata",
  "in transito", "ricevuto", "ricevuta", "rifiutato", "rifiutata", "accettato", "accettata", "annullato",
  "annullata", "confermato", "confermata", "completato", "lista d'attesa", "iscrizioni aperte", "iscrizioni chiuse",
  "rinviato",
  // pt
  "aprovado", "aprovada", "pendente", "em processamento", "entregue", "em trânsito", "recusado", "recusada",
  "aceito", "aceita", "concluído", "inscrições abertas", "inscrições encerradas", "adiado",
  // ja
  "ステータス", "承認済み", "保留中", "処理中", "発送済み", "配達済み", "配送中", "受付済み", "受付中", "却下", "キャンセル",
  "確定", "完了", "受付終了", "延期",
  // ko
  "상태", "승인됨", "대기 중", "처리 중", "배송 중", "배송 완료", "발송 완료", "접수 완료", "거절", "취소", "확정", "완료",
  "접수 마감", "연기",
  // zh
  "状态", "已批准", "审核中", "处理中", "已发货", "已送达", "运输中", "已签收", "已受理", "已拒绝", "已取消", "已确认",
  "已完成", "报名开始", "报名截止", "已延期",
  // zh-Hant
  "狀態", "已核准", "審核中", "處理中", "已出貨", "已發貨", "已送達", "配送中", "運送中", "已簽收", "已受理", "已拒絕",
  "已取消", "已確認", "已完成", "報名開始", "報名截止", "已延期",
  // ar
  "الحالة", "تمت الموافقة", "قيد المراجعة", "قيد المعالجة", "تم الشحن", "تم التسليم", "قيد التوصيل", "في الطريق",
  "تم الاستلام", "مرفوض", "تم الرفض", "مقبول", "تم القبول", "تم الإلغاء", "ملغى", "مؤكد", "تم التأكيد", "مكتمل",
  "التسجيل مفتوح", "التسجيل مغلق", "مؤجل", "تم التأجيل",
  // vi
  "trạng thái", "đã duyệt", "đã phê duyệt", "đang chờ", "đang chờ xử lý", "đang xử lý", "đã gửi hàng", "đã giao",
  "đã giao hàng", "đang giao", "đang giao hàng", "đang vận chuyển", "đã nhận", "bị từ chối", "đã từ chối", "đã chấp nhận",
  "đã hủy", "đã xác nhận", "hoàn tất", "đã hoàn thành", "mở đăng ký", "đóng đăng ký", "đã hoãn"
]

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/#/g, "\\d+")

// A Russian or Ukrainian word of five letters or more is matched by its stem with any short ending
// ("заявление" → "заявлени…": "заявления", "заявлением"); shorter ones ("до") as they are.
function withEndings(word: string): string {
  const last = word.split(" ").pop() ?? word
  if (!/^[\u0400-\u04ff]{5,}$/.test(last)) return escape(word)
  return escape(word.replace(/[аяеёиыоуюьйії]$/u, "")) + "\\p{L}{0,3}"
}

// Whole phrases: in scripts with spaces, not inside a longer word (Russian and Ukrainian words with their endings:
// "заявление" also finds "заявления"); Chinese, Japanese and Korean words anywhere.
export function phrases(list: string[]): RegExp {
  const spaced = list.filter((w) => !CJK.test(w)).map(withEndings)
  const dense = list.filter((w) => CJK.test(w)).map(escape)
  const parts = [`(?<![\\p{L}\\p{N}])(?:${spaced.join("|")})(?![\\p{L}\\p{N}])`]
  if (dense.length) parts.push(`(?:${dense.join("|")})`)
  return new RegExp(parts.join("|"), "iu")
}

const STOCK = phrases(STOCK_WORDS)
const STATUS = phrases(STATUS_WORDS)

// Month names in every shipped language, January first (en, ru, uk, de, fr, es, it, pt and ar, with their
// abbreviations; the Arabic ones also as the Levant and Iraq name them). Vietnamese writes the month's number ("tháng 3").
const MONTH_NAMES: string[][] = [
  ["jan(?:uary)?", "январ[яь]", "янв", "січ(?:ня|ень)", "januar", "jän(?:ner)?", "janvier", "janv", "enero", "ene", "gennaio", "gen", "janeiro", "يناير", "كانون الثاني"],
  ["feb(?:ruary)?", "феврал[яь]", "фев", "лют(?:ого|ий)", "februar", "février", "févr", "febrero", "febbraio", "fevereiro", "fev", "فبراير", "شباط"],
  ["mar(?:ch)?", "марта?", "берез(?:ня|ень)", "märz", "mars", "marzo", "março", "مارس", "آذار"],
  ["apr(?:il)?", "апрел[яь]", "апр", "квіт(?:ня|ень)", "avril", "avr", "abril", "abr", "aprile", "أبريل", "إبريل", "نيسان"],
  ["may", "мая", "май", "трав(?:ня|ень)", "mai", "mayo", "maggio", "mag", "maio", "مايو", "أيار"],
  ["june?", "июн[яь]", "черв(?:ня|ень)", "juni", "juin", "junio", "giugno", "giu", "junho", "يونيو", "حزيران"],
  ["july?", "июл[яь]", "лип(?:ня|ень)", "juli", "juillet", "juil", "julio", "luglio", "lug", "julho", "يوليو", "تموز"],
  ["aug(?:ust)?", "августа?", "авг", "серп(?:ня|ень)", "août", "agosto", "ago", "أغسطس", "آب"],
  ["sep(?:t(?:ember)?)?", "сентябр[яь]", "сент?", "верес(?:ня|ень)", "septembre", "septiembre", "setiembre", "settembre", "setembro", "set", "سبتمبر", "أيلول"],
  ["oct(?:ober)?", "октябр[яь]", "окт", "жовт(?:ня|ень)", "oktober", "okt", "octobre", "octubre", "ottobre", "ott", "outubro", "out", "أكتوبر", "تشرين الأول"],
  ["nov(?:ember)?", "ноябр[яь]", "ноя", "листопада?", "novembre", "noviembre", "novembro", "نوفمبر", "تشرين الثاني"],
  ["dec(?:ember)?", "декабр[яь]", "дек", "груд(?:ня|ень)", "dezember", "dez", "décembre", "déc", "diciembre", "dic", "dicembre", "dezembro", "ديسمبر", "كانون الأول"]
]
const MONTHS = [...MONTH_NAMES.flat(), "tháng\\s?\\d{1,2}"]
/** A month's name in any shipped language, as a pattern's source (no flags; match with "iu"). */
export const MONTH_WORD = `(?:${MONTH_NAMES.flat().join("|")})`
const MONTH_EXACT = MONTH_NAMES.map((names) => new RegExp(`^(?:${names.join("|")})\\.?$`, "iu"))
/** Which month (1–12) a name stands for in any shipped language ("марта", "März", "déc."); null when it's none. */
export function monthOf(word: string): number | null {
  const i = MONTH_EXACT.findIndex((re) => re.test(word.trim()))
  return i >= 0 ? i + 1 : null
}
const MONTH = `(?:${MONTHS.join("|")})\\.?`
const DATE = new RegExp(
  [
    // 2026-11-04, 04.11.2026, 4/11/26
    String.raw`(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)`,
    String.raw`(?<!\d)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?!\d)`,
    // 12 March, 12. März, 12 de marzo, 4 ноября; March 12, 2026
    String.raw`(?<![\p{L}\d])\d{1,2}(?:\.|st|nd|rd|th|er)?\s?(?:de\s)?${MONTH}(?!\p{L})`,
    String.raw`(?<!\p{L})${MONTH}\s\d{1,2}(?:st|nd|rd|th)?(?![\d\p{L}])`,
    // 4 tháng 11 năm 2026, ngày 4 tháng 11: the day before the month, as in Vietnamese
    String.raw`(?<![\p{L}\d])(?:ngày\s)?\d{1,2}\stháng\s?\d{1,2}(?!\d)`,
    // 2026年11月, 11月4日, 11월 4일
    String.raw`\d{1,4}\s?[年년]\s?\d{1,2}\s?[月월]`,
    String.raw`\d{1,2}\s?[月월]\s?\d{1,2}\s?[日일]`
  ].join("|"),
  "iu"
)

/** Whether a text states a date in any of the panel's languages ("4 March 2026", "4. März", "2026年3月4日"). */
export function hasDate(text: string): boolean {
  return DATE.test(text)
}

// A bare day and month, 04.11 or 4/11: both parts must fit, so "19.99" and "12.50" stay numbers, and "1/2"
// (three digits at least) stays a fraction.
function shortDate(text: string): boolean {
  const m = /^(\d{1,2})[./](\d{1,2})$/.exec(text)
  if (m && m[1].length + m[2].length < 3) return false
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a >= 1 && a <= 31 && b >= 1 && b <= 12
}

// Stock phrases that mean "can't buy now"; any other stock phrase means it can be bought (or soon).
const STOCK_OUT = phrases([
  "out of stock", "sold out", "unavailable", "currently unavailable", "discontinued", "temporarily out of stock",
  "нет в наличии", "распродано", "нет на складе", "закончился", "товар закончился", "недоступно",
  "немає в наявності", "розпродано", "закінчився",
  "nicht auf lager", "ausverkauft", "nicht lieferbar", "nicht verfügbar", "derzeit nicht verfügbar",
  "rupture de stock", "en rupture de stock", "épuisé", "épuisée", "indisponible",
  "agotado", "agotada", "sin stock", "no disponible",
  "non disponibile", "esaurito", "esaurita",
  "esgotado", "esgotada", "fora de estoque", "indisponível",
  "在庫切れ", "在庫なし", "品切れ", "売り切れ", "販売終了",
  "재고 없음", "품절", "일시품절", "판매 종료",
  "无货", "缺货", "售罄", "已售完", "outofstock", "soldout", "discontinued",
  "無貨", "缺貨", "售完", "已售罄", "完售", "暫時缺貨",
  "غير متوفر", "غير متاح", "غير متوفر حاليًا", "نفد", "نفدت الكمية", "نفذت الكمية", "نفد من المخزون", "نفدت الكمية مؤقتًا",
  "hết hàng", "tạm hết hàng", "ngừng kinh doanh", "cháy hàng"
])

/** A stock value says it can't be bought now ("Sold out", "Нет в наличии", schema.org OutOfStock). */
export function isOutOfStock(value: string): boolean {
  return STOCK_OUT.test(value.replace(/([a-z])([A-Z])/g, "$1 $2")) || /OutOfStock|SoldOut|Discontinued/i.test(value)
}

const patternOf = (what: Exclude<WatchWhat, "price">) => (what === "stock" ? STOCK : what === "date" ? DATE : STATUS)

/** The first value of that kind in a piece of text: the price, the stock phrase, the date. */
export function firstValue(what: WatchWhat, text: string): string | null {
  if (what === "price") return prices(text)[0] ?? null
  return patternOf(what).exec(text)?.[0]?.trim() ?? null
}

/** The last value of that kind in a piece of text. */
export function lastValue(what: WatchWhat, text: string): string | null {
  if (what === "price") return prices(text).at(-1) ?? null
  const all = [...text.matchAll(new RegExp(patternOf(what).source, "giu"))]
  return all.length ? all[all.length - 1][0].trim() : null
}

const wordCount = (s: string) => (CJK.test(s) ? Math.ceil(s.replace(/\s/g, "").length / 4) : s.split(" ").length)

/** What a selection is, for the eye: a price, stock, a date or a status; null for ordinary text. */
export function detectWatchable(selection: string): WatchWhat | null {
  const text = selection.replace(/\s+/g, " ").trim()
  if (!text || text.length > MAX_LEN) return null
  const n = wordCount(text)
  if (n <= 8 && /\d/.test(text) && PRICE.test(text)) return "price"
  if (n <= 8 && STOCK.test(text)) return "stock"
  if (n <= 8 && (DATE.test(text) || shortDate(text))) return "date"
  if (n <= 5 && STATUS.test(text)) return "status"
  return null
}

// When the eye shows by itself (the bubble), a date and a status need more than their own words: the date an
// article was published or a lone "shipped" in a story aren't something to watch (the director's audit, 27).

// Words of an event around a date: something opens, starts, sells or closes then.
const EVENT_WORDS = phrases([
  // en
  "open", "opens", "opening", "registration", "register", "sign up", "on sale", "sale", "sales", "tickets",
  "deadline", "due", "until", "till", "closes", "booking", "appointment", "slot", "starts", "begins", "release",
  "launch", "available from", "pre-order", "preorder", "restock", "expires", "apply by", "doors",
  // ru
  "открытие", "открывается", "откроется", "регистрация", "запись", "продажа", "продажи", "старт", "начало", "до",
  "дедлайн", "срок", "билеты", "бронирование", "приём", "прием", "выход", "релиз", "предзаказ", "поступление",
  "истекает",
  // uk
  "відкриття", "реєстрація", "запис", "продаж", "початок", "дедлайн", "термін", "квитки", "бронювання", "прийом",
  "вихід", "передзамовлення",
  // de
  "eröffnung", "öffnet", "anmeldung", "registrierung", "verkauf", "vorverkauf", "tickets", "frist", "bis",
  "termin", "buchung", "start", "beginn", "erscheint", "vorbestellung",
  // fr
  "ouverture", "ouvre", "inscription", "inscriptions", "vente", "billets", "date limite", "jusqu'au", "avant le",
  "réservation", "rendez-vous", "début", "sortie", "précommande",
  // es
  "apertura", "abre", "inscripción", "inscripciones", "registro", "venta", "entradas", "boletos", "fecha límite",
  "hasta", "reserva", "cita", "comienzo", "inicio", "lanzamiento", "preventa",
  // it
  "apre", "iscrizione", "registrazione", "vendita", "biglietti", "scadenza", "entro", "fino al", "prenotazione",
  "appuntamento", "inizio", "uscita", "preordine",
  // pt
  "abertura", "inscrição", "venda", "ingressos", "bilhetes", "prazo", "até", "agendamento", "início",
  "lançamento", "pré-venda",
  // ja, ko, zh
  "開始", "受付", "申込", "予約", "発売", "販売", "締切", "期限", "まで", "チケット", "開催", "公開",
  "시작", "접수", "신청", "예약", "판매", "발매", "마감", "까지", "티켓", "오픈", "출시",
  "开始", "报名", "预约", "预订", "发售", "开售", "截止", "门票", "上市", "开放", "之前",
  "開始", "報名", "預約", "預訂", "發售", "開賣", "開售", "截止", "門票", "上市", "開放", "之前", "售票",
  // ar
  "التسجيل", "تسجيل", "يفتح", "افتتاح", "البيع", "بيع", "تذاكر", "التذاكر", "موعد", "آخر موعد", "حتى", "حجز", "يبدأ",
  "بداية", "إطلاق", "طلب مسبق", "ينتهي", "الطرح",
  // vi
  "mở", "mở bán", "đăng ký", "bán", "vé", "hạn chót", "hạn", "đến", "cho đến", "đặt chỗ", "đặt lịch", "lịch hẹn",
  "bắt đầu", "ra mắt", "phát hành", "đặt trước", "hết hạn"
])

// What a status is about: an order, a parcel, a flight, an application.
const STATUS_CONTEXT = phrases([
  // en
  "order", "delivery", "shipment", "package", "parcel", "tracking", "flight", "application", "case", "visa",
  "booking", "reservation", "claim", "request", "refund", "payment", "passport", "appointment",
  // ru
  "заказ", "заказа", "доставка", "доставки", "посылка", "посылки", "отправление", "трек", "рейс", "заявка",
  "заявки", "заявление", "дело", "виза", "бронь", "бронирование", "обращение", "возврат", "платёж", "оплата",
  "паспорт",
  // uk
  "замовлення", "посилка", "відправлення", "заява", "справа", "віза", "звернення", "повернення",
  // de
  "bestellung", "lieferung", "sendung", "paket", "flug", "antrag", "bewerbung", "visum", "buchung", "reservierung",
  "anfrage", "erstattung", "zahlung",
  // fr
  "commande", "livraison", "colis", "envoi", "vol", "demande", "candidature", "dossier", "remboursement",
  "paiement", "passeport",
  // es
  "pedido", "envío", "entrega", "paquete", "vuelo", "solicitud", "caso", "visado", "reembolso", "pago", "pasaporte",
  // it
  "ordine", "consegna", "spedizione", "pacco", "volo", "domanda", "richiesta", "pratica", "visto", "rimborso",
  "pagamento", "passaporto",
  // pt
  "encomenda", "pacote", "voo", "solicitação", "processo", "pagamento", "passaporte",
  // ja, ko, zh
  "注文", "配送", "配達", "荷物", "申請", "返金", "支払", "ビザ", "パスポート",
  "주문", "배송", "택배", "항공편", "환불", "결제", "비자", "여권",
  "订单", "快递", "包裹", "航班", "申请", "退款", "付款", "签证", "护照",
  "訂單", "配送", "快遞", "包裹", "航班", "申請", "退款", "付款", "簽證", "護照", "物流",
  // ar
  "طلب", "الطلب", "طلبك", "شحنة", "الشحنة", "توصيل", "التوصيل", "طرد", "الطرد", "تتبع", "رحلة", "الرحلة", "تأشيرة",
  "التأشيرة", "حجز", "الحجز", "استرداد", "دفع", "الدفع", "جواز السفر", "موعد",
  // vi
  "đơn hàng", "giao hàng", "vận chuyển", "kiện hàng", "bưu kiện", "mã vận đơn", "chuyến bay", "đơn", "hồ sơ", "visa",
  "thị thực", "đặt chỗ", "hoàn tiền", "thanh toán", "hộ chiếu", "lịch hẹn"
])

/**
 * The eye by a selection: a price or stock as before; a date only with words of an event next to it (or an event
 * in the page's markup), a status only next to what it's the status of. `around`: the text of the selection's
 * paragraph or row. Null keeps the bubble as it is.
 */
export function eyeFor(selection: string, around: string, eventMarkup = false): WatchWhat | null {
  const what = detectWatchable(selection) ?? (priceAround(selection, around) ? "price" : null)
  const near = `${selection} ${around}`.replace(/\s+/g, " ")
  if (what === "date") return eventMarkup || EVENT_WORDS.test(near) ? "date" : null
  if (what === "status") return STATUS_CONTEXT.test(near) ? "status" : null
  return what
}

/**
 * A bare number selected next to its currency: a tap on "40" in "USD 40" or "40 EUR" selects only the number (the
 * code is a word of its own; "$40" comes whole). The price as the page writes it, from the selection's paragraph or
 * row; null when the number has no currency right by it.
 */
export function priceAround(selection: string, around: string): string | null {
  const sel = selection.replace(/\s+/g, " ").trim()
  if (!/^\d[\d \u00a0\u202f.,']*$/.test(sel) || sel.length > 20) return null
  const text = around.replace(/\s+/g, " ")
  const digits = sel.replace(/\D/g, "")
  for (const price of prices(text)) if (price.replace(/\D/g, "") === digits && price.includes(sel)) return price
  return null
}
