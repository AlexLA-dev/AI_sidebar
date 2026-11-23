// The page a task starts on, when it is about one thing (2.7.1, the owner on 121: on fresha's page of Mancave Barbershop
// «Забукай меня на стрижку…» planned «Выбираю барбершоп…» and «I'll pick the place»). A single place, product or
// specialist's page — its name in the title and on the page, a button that books or buys it, no list of places — is
// the task's target when the request names no other.

import type { PageMap } from "./types.ts"
import { venuesOn } from "./venues.ts"

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
const LISTY = /(?<!\p{L})(best|top \d+|near me|restaurants in|search|results|find |book (a|an) |all |category|catalog|deals|offers|рядом|лучшие|поиск|каталог|результат)/iu

/** The title's own name: before « | », « - », « – », « · » (the site and the city come after). */
function nameOf(title: string): string {
  return title.split(/\s+[|–—·-]\s+|\s*\|\s*/)[0].replace(/\s+/g, " ").trim()
}

/** The thing this page is about, or null: a list, a home page, or nothing to book or buy here. */
export function pageSubject(map: PageMap): Subject | null {
  const full = nameOf(map.title)
  if (full.length < 3 || full.length > 80 || LISTY.test(full)) return null
  if (venuesOn(map).length) return null
  // The name as the page itself shows it (its heading), not only in the tab's title: «Il Fico in Paris» is «Il Fico».
  const head = map.text.slice(0, 1500).toLocaleLowerCase()
  const words = full.split(" ")
  let name = ""
  for (let n = words.length; n >= 1 && !name; n--) {
    const cand = words.slice(0, n).join(" ")
    if (cand.length >= 3 && head.includes(cand.toLocaleLowerCase())) name = cand
  }
  if (!name) return null
  const labels = map.items.filter((i) => i.role === "button" || i.role === "link").map((i) => i.label)
  if (labels.some((l) => BUY.test(l))) return { kind: "product", name }
  if (!labels.some((l) => BOOK.test(l))) return null
  const placeName = /(?<!\p{L})(shop|salon|studio|clinic|restaurant|bar|cafe|café|spa|barbershop|бар|салон|ресторан|кафе|клиник)/iu.test(name)
  return { kind: !placeName && PERSON.test(map.text.slice(0, 300)) ? "person" : "place", name }
}

/** As the plan and the steps hear it. */
export function subjectLine(s: Subject, host: string): string {
  return `the page is about one ${s.kind === "place" ? "place" : s.kind === "person" ? "specialist" : "product"}: «${s.name}» (${host})`
}
