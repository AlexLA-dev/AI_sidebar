// The page a task starts on, when it is about one thing (2.7.1, the owner on 121: on a booking site's page of one barbershop
// «Забукай меня на стрижку…» planned «Выбираю барбершоп…» and «I'll pick the place»). A single place, product or
// specialist's page — its name in the title and on the page, a button that books or buys it, no list of places — is
// the task's target when the request names no other.

import type { PageMap } from "./types.ts"
import { wordTest } from "./match.ts"
import { venuesOn } from "./venues.ts"
import { BOOKING_WORDS } from "./words.ts"

const bookingWord = wordTest(BOOKING_WORDS)

export interface Subject {
  kind: "place" | "product" | "person"
  name: string
}

// A button that books or buys this one thing, in the panel's languages.
const BOOK = /(?<!\p{L})(book|reserv|make a booking|schedule|choose time|réserv|prenot|buch|termin|agend|запис|заброн|予約|예약|预订|預訂|預約|احجز|đặt (lịch|bàn|chỗ))/iu
const BUY = /(?<!\p{L})(add to (cart|bag|basket)|buy now|in den warenkorb|ajouter au panier|añadir al carrito|aggiungi al carrello|adicionar ao carrinho|в корзину|купить|до кошика|sepete ekle|カートに入れる|장바구니|加入购物车|加入購物車|أضف إلى السلة|thêm vào giỏ)/iu
// A specialist's own page: their role on it.
const PERSON = /(?<!\p{L})(stylist|therapist|specialist|doctor|dr\.|мастер|стилист|врач|friseurin|coiffeuse|peluquer)/iu
// Titles that name a list or a site's page, never one thing.
const LISTY = /(?<!\p{L})(best|top \d+|near me|restaurants in|hotels in|search|results|find |book (a|an) |all |category|catalog|deals|offers|compare|рядом|лучшие|поиск|каталог|результат|отели в|hôtels à|hoteles en|hotel a |unterkünfte|호텔 및|숙소|검색|비교|ホテル一覧|一覧|検索|比較|の宿|酒店及|住宿|搜索|比较|搜尋|比較|فنادق في|khách sạn tại)/iu

// A search a site offers for places (its box, its button): what, where, find, in the panel's languages.
const SEARCH = /(?<!\p{L})(search|find|where|location|recherch|où|buscar|dónde|cerca|dove|suche|wo\b|pesquis|onde|поиск|найти|где|пошук|знайти|ara|nerede|検索|検索|어디|검색|搜索|搜尋|哪里|بحث|أين|tìm)/iu

/** The title's own name: before « | », « - », « – », « · » (the site and the city come after). */
function nameOf(title: string): string {
  return title.split(/\s+[|–—·-]\s+|\s*\|\s*/)[0].replace(/\s+/g, " ").trim()
}

/** The thing this page is about, or null: a list, a home page, or nothing to book or buy here. */
/** The name the page's title gives, as the page itself shows it (its heading): «Trattoria Sole in Paris» is «Trattoria Sole»;
 *  "" for a title that is the page's action («Book a table»), a list's, or a name the page doesn't show. */
export function titleName(map: PageMap): string {
  const head = `${map.text.slice(0, 1500)}\n${map.items.slice(0, 60).map((i) => i.label).join("\n")}`.toLocaleLowerCase()
  // The title's parts in order: the first that is a name the page shows. (Round 141, the director's 8a: a booking
  // engine's page titled «Datos del huésped – Casa España Casa Boutique» — the step first, the property after it.)
  for (const part of titleParts(map.title)) {
    // (A part that is the page's action — «Забронировать столик», «Book a table» — or its step names nothing.)
    if (part.length < 3 || part.length > 80 || LISTY.test(part) || bookingWord(part.split(" ")[0]) || STEP.test(part)) continue
    const words = part.split(" ")
    for (let n = words.length; n >= 1; n--) {
      const cand = words.slice(0, n).join(" ")
      if (cand.length >= 3 && head.includes(cand.toLocaleLowerCase())) return cand
    }
  }
  return ""
}

function titleParts(title: string): string[] {
  return title.split(/\s+[|–—·-]\s+|\s*\|\s*/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
}

// A booking flow's step named in a title («Guest details», «Datos del huésped», «Paiement»), in the panel's languages.
const STEP = /(?<!\p{L})(guest|details|checkout|payment|confirm|review your|select (a |your )?room|add-?ons|extras|datos|huésped|pago|confirmaci|détails|paiement|vos coordonnées|gäste|zahlung|ihre daten|ospiti|pagamento|i tuoi dati|hóspede|seus dados|данные|гост|оплат|ゲスト|お客様情報|お支払い|게스트|결제|客人|付款|بيانات|الدفع|thông tin khách|thanh toán)/iu

// A page's own booking controls with no button that says «book»: a booking engine's check-in and check-out (round 141).
const STAY_DATES = /(?<!\p{L})(check-?in|check-?out|arrival|departure|llegada|salida|entrada|arrivée|départ|anreise|abreise|arrivo|partenza|chegada|saída|заезд|выезд|заїзд|виїзд|giriş|çıkış|チェックイン|チェックアウト|체크인|체크아웃|入住|退房|الوصول|المغادرة|nhận phòng|trả phòng)(?!\p{L})/iu

export function pageSubject(map: PageMap): Subject | null {
  // (A results list shows its places on the screen; a place's own page may list «nearby» ones far below it.)
  if (venuesOn({ ...map, items: map.items.filter((i) => i.where !== "below") }).length) return null
  const name = titleName(map)
  if (!name) return null
  // The site's own name on its home page with a search for places (a marketplace: «Doctolib» on doctolib.fr, 126) isn't
  // one place: the task searches it. (A restaurant's own site with no search stays its place.)
  const brand = (() => {
    try {
      return new URL(map.url).hostname.replace(/^www\./, "").split(".")[0]
    } catch {
      return ""
    }
  })()
  const flat = (x: string) => x.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "")
  const searches = map.items.some((i) => ((i.role === "textbox" || i.role === "combobox") && SEARCH.test(`${i.label} ${i.type ?? ""}`)) || (i.role === "button" && SEARCH.test(i.label)))
  if (brand && flat(name) === flat(brand) && searches) return null
  const labels = map.items.filter((i) => i.role === "button" || i.role === "link").map((i) => i.label)
  if (labels.some((l) => BUY.test(l))) return { kind: "product", name }
  // (A booking engine's page books through its own dates: «Reserve su estancia» and its check-in and check-out, no
  // «Book» button — its one property is the place, round 141.)
  const engine = map.items.filter((i) => STAY_DATES.test(i.label) || i.type === "date").length >= 2 && BOOK.test(map.text.slice(0, 1500))
  if (!labels.some((l) => BOOK.test(l)) && !engine) return null
  const placeName = /(?<!\p{L})(shop|salon|studio|clinic|restaurant|bar|cafe|café|spa|barbershop|бар|салон|ресторан|кафе|клиник)/iu.test(name)
  return { kind: !placeName && PERSON.test(map.text.slice(0, 300)) ? "person" : "place", name }
}

/** As the plan and the steps hear it. */
export function subjectLine(s: Subject, host: string): string {
  return `the page is about one ${s.kind === "place" ? "place" : s.kind === "person" ? "specialist" : "product"}: «${s.name}» (${host})`
}
