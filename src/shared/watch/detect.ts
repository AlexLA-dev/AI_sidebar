// Page watch (2.5): is a selection something worth watching? The eye shows by a selection only for a price,
// stock, a date or a status; ordinary text keeps the bubble as it was (Ask, Google, Template).
// Words for the 11 languages the panel speaks. Short selections only: a sentence is text, not a value.

export type WatchWhat = "price" | "stock" | "date" | "status"

const MAX_LEN = 80

// Symbols and codes that sit right by a number.
const CURRENCY =
  String.raw`(?:US\$|R\$|C\$|A\$|HK\$|NZ\$|[$€£¥₩₽₴₹₺₪฿₫]|zł|Kč|CHF|EUR|USD|GBP|JPY|KRW|CNY|RMB|RUB|UAH|BRL|PLN|SEK|NOK|DKK|CAD|AUD|INR|TRY|руб\.?|р\.|грн\.?|円|元|원)`
const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f.,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
const PRICE = new RegExp(String.raw`(?:${CURRENCY}\s?(?:${NUMBER}))|(?:(?:${NUMBER})\s?${CURRENCY})`, "iu")

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
  "有货", "无货", "缺货", "售罄", "已售完", "现货", "预售", "到货通知", "即将上市", "库存紧张"
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
  "已完成", "报名开始", "报名截止", "已延期"
]

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/#/g, "\\d+")

// Whole phrases: in scripts with spaces, not inside a longer word; Chinese, Japanese and Korean words anywhere.
function phrases(list: string[]): RegExp {
  const spaced = list.filter((w) => !CJK.test(w)).map(escape)
  const dense = list.filter((w) => CJK.test(w)).map(escape)
  const parts = [`(?<![\\p{L}\\p{N}])(?:${spaced.join("|")})(?![\\p{L}\\p{N}])`]
  if (dense.length) parts.push(`(?:${dense.join("|")})`)
  return new RegExp(parts.join("|"), "iu")
}

const STOCK = phrases(STOCK_WORDS)
const STATUS = phrases(STATUS_WORDS)

const MONTHS = [
  // en
  "jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may", "june?", "july?", "aug(?:ust)?",
  "sep(?:t(?:ember)?)?", "oct(?:ober)?", "nov(?:ember)?", "dec(?:ember)?",
  // ru
  "январ[яь]", "феврал[яь]", "марта?", "апрел[яь]", "мая", "май", "июн[яь]", "июл[яь]", "августа?", "сентябр[яь]",
  "октябр[яь]", "ноябр[яь]", "декабр[яь]", "янв", "фев", "апр", "авг", "сент?", "окт", "ноя", "дек",
  // uk
  "січ(?:ня|ень)", "лют(?:ого|ий)", "берез(?:ня|ень)", "квіт(?:ня|ень)", "трав(?:ня|ень)", "черв(?:ня|ень)",
  "лип(?:ня|ень)", "серп(?:ня|ень)", "верес(?:ня|ень)", "жовт(?:ня|ень)", "листопада?", "груд(?:ня|ень)",
  // de
  "januar", "februar", "märz", "mai", "juni", "juli", "oktober", "dezember", "jän(?:ner)?", "okt", "dez",
  // fr
  "janvier", "février", "mars", "avril", "juin", "juillet", "août", "septembre", "octobre", "novembre",
  "décembre", "janv", "févr", "avr", "juil", "déc",
  // es
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre",
  "noviembre", "diciembre", "ene", "abr", "ago", "dic",
  // it
  "gennaio", "febbraio", "aprile", "maggio", "giugno", "luglio", "settembre", "ottobre", "dicembre", "gen", "mag",
  "giu", "lug", "ott",
  // pt
  "janeiro", "fevereiro", "março", "maio", "junho", "julho", "setembro", "outubro", "novembro", "dezembro", "fev",
  "set", "out"
]
const MONTH = `(?:${MONTHS.join("|")})\\.?`
const DATE = new RegExp(
  [
    // 2026-11-04, 04.11.2026, 4/11/26
    String.raw`(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)`,
    String.raw`(?<!\d)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?!\d)`,
    // 12 March, 12. März, 12 de marzo, 4 ноября; March 12, 2026
    String.raw`(?<![\p{L}\d])\d{1,2}(?:\.|st|nd|rd|th|er)?\s?(?:de\s)?${MONTH}(?!\p{L})`,
    String.raw`(?<!\p{L})${MONTH}\s\d{1,2}(?:st|nd|rd|th)?(?![\d\p{L}])`,
    // 2026年11月, 11月4日, 11월 4일
    String.raw`\d{1,4}\s?[年년]\s?\d{1,2}\s?[月월]`,
    String.raw`\d{1,2}\s?[月월]\s?\d{1,2}\s?[日일]`
  ].join("|"),
  "iu"
)

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
  "无货", "缺货", "售罄", "已售完", "outofstock", "soldout", "discontinued"
])

/** A stock value says it can't be bought now ("Sold out", "Нет в наличии", schema.org OutOfStock). */
export function isOutOfStock(value: string): boolean {
  return STOCK_OUT.test(value.replace(/([a-z])([A-Z])/g, "$1 $2")) || /OutOfStock|SoldOut|Discontinued/i.test(value)
}

const patternOf = (what: WatchWhat) => (what === "price" ? PRICE : what === "stock" ? STOCK : what === "date" ? DATE : STATUS)

/** The first value of that kind in a piece of text: the price, the stock phrase, the date. */
export function firstValue(what: WatchWhat, text: string): string | null {
  return patternOf(what).exec(text)?.[0]?.trim() ?? null
}

/** The last value of that kind in a piece of text. */
export function lastValue(what: WatchWhat, text: string): string | null {
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
