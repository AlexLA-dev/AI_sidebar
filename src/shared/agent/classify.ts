// A step's class (free / confirm / self / blocked), decided by code from the call, the control and the page: the
// model's own words about a step never change it. The server checks with this before it answers, and the extension
// checks again before it acts (the extension is the one that presses).

import { anyWord, wordKind, wordTest } from "./match.ts"
import { amounts } from "./money.ts"
import { blockedSite, hostOf, sameSite, type SitePolicy } from "./sites.ts"
import type { MapItem, PageMap, StepVerdict, ToolCall } from "./types.ts"
import { CHOSEN_COUNT_WORDS, CONSENT_DIALOG, TERMS_BOX } from "./words.ts"

export interface StepContext {
  map: PageMap
  // The site the task began on: going elsewhere needs a «Да».
  startHost: string
  // The person's own words: text the model types that names an address or an e-mail not in them needs a «Да».
  request: string
  // A «Да» was given on this site during the task already (the first step on a site the task came to asks).
  confirmedHere: boolean
  policy: SitePolicy
}

// Mail, chat and social sites: «Send» there is a message in the person's name.
const MESSAGING = /(^|\.)(mail\.google|chat\.google|messages\.google|fastmail|zoho|zohomail|tutanota|tuta|gmx|hey|outlook|live|yahoo|proton|icloud|mail\.ru|yandex|telegram|t\.me|web\.whatsapp|whatsapp|messenger|facebook|instagram|x|twitter|threads|linkedin|vk|ok|reddit|discord|slack|teams\.microsoft|tiktok|pinterest|quora|medium|substack|tumblr|mastodon|bsky|line|kakao|naver|weibo|wechat|zalo)\.[a-z.]+$/
// Mail and chat hosts whose name already ends in their own domain (mail.ru, t.me): the whole host.
const MESSAGING_EXACT = /(^|\.)(mail\.ru|t\.me|mail\.com|gmx\.net|gmx\.com|web\.de|fastmail\.fm|hey\.com)$/

// Cart words in the 15 languages (the submit list's «add to cart» entries).
const CART = /cart|basket|bag|trolley|корзин|кошик|warenkorb|panier|carrito|cesta|carrello|carrinho|sacola|sepet|السلة|カート|장바구니|购物车|購物車|giỏ/i

// Booking words that open a booking flow (not «confirm», «submit», «send»): the words matched in WORDS.submit.
const BOOK_ENTRY = /^(book|book now|book appointment|make an appointment|reserve|schedule|забронировать|бронировать|записаться|записаться на прием|забронювати|записатися|buchen|jetzt buchen|termin buchen|reservieren|réserver|prendre rendez-vous|reservar|pedir cita|prenota|prenota ora|agendar|rezervasyon yap|randevu al|احجز|حجز|予約する|予約|예약|예약하기|预订|预约|預訂|預約|đặt chỗ|đặt lịch|đặt bàn)$/
// A page where a booking or an order is being committed: fields of the person's, payment, or a review / confirm address.
const COMMIT_PATH = /(^|[/._-])(review|confirm|confirmation|checkout|summary|payment|pay|complete|finish)([/._?-]|$)/i

function commitStage(map: PageMap): boolean {
  let path = ""
  try {
    path = new URL(map.url).pathname
  } catch {
    path = ""
  }
  return !!map.pay || COMMIT_PATH.test(path) || map.items.some((i) => i.lock === "personal")
}

const READ_ONLY = new Set(["read_page", "scroll", "extract", "ask_user", "done", "back", "reminders", "calendar"])
// The person's Calendar and Reminders changed: always «Сделать?» first, wherever the page is.
const APPLE_WRITES = new Set(["reminder_add", "reminder_done", "event_add"])
const SELF_KINDS = new Set(["pay", "post", "rate", "account", "auth", "consent"])
// An address or an e-mail address in text the model wants typed.
const ADDRESS = /\bhttps?:\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+/gi

/** A card number (13–19 digits passing the Luhn check, spaces or dashes allowed) or an IBAN anywhere in the text. */
export function hasSecretNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const digits = m[0].replace(/\D/g, "")
    if (digits.length < 13 || digits.length > 19) continue
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i])
      if (i % 2 === 1) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
    }
    if (sum % 10 === 0) return true
  }
  for (const m of text.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g)) {
    const iban = m[0].replace(/ /g, "")
    const moved = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
    let rest = 0
    for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97
    if (rest === 1) return true
  }
  return false
}

export function itemById(map: PageMap, id: string | undefined): MapItem | null {
  return (id && map.items.find((i) => i.id === id)) || null
}

function verdict(cls: StepVerdict["cls"], reason: string): StepVerdict {
  return { cls, reason }
}

/** The host a link goes to, from the map's href ("/path" on this site, "host/path" elsewhere). */
function linkHost(item: MapItem, pageHost: string): string {
  const href = item.href ?? ""
  if (!href || href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return pageHost
  return href.split("/")[0].toLowerCase()
}

function isConsentDialog(map: PageMap, item: MapItem): boolean {
  return item.where === "dialog" && (map.consent === true || !!anyWord(map.text.slice(0, 1500), CONSENT_DIALOG))
}

/** A «Send» is a message when it's on a mail or social site, or in a form (or a page) that's a message composer. */
function isMessage(map: PageMap, item: MapItem, host: string): boolean {
  if (MESSAGING.test(host) || MESSAGING_EXACT.test(host)) return true
  if (item.form !== undefined) {
    const form = map.forms.find((f) => f.n === item.form)
    const fields = map.items.filter((i) => i.form === item.form && (i.role === "textbox" || i.role === "textarea" || i.role === "editor"))
    const composer = fields.some((i) => i.role === "editor" || i.role === "textarea")
    const personal = fields.some((i) => i.lock === "personal")
    return !!form && composer && !personal
  }
  // Outside a form: a page with a composer (a rich editor or a plain textarea) sends a message.
  return map.items.some((i) => i.role === "editor" || i.role === "textarea")
}

const PRICE_FROM = /(^|\s)(from|starting at|ab|à partir de|dès|desde|a partir de|da|a partire da|от|від|itibaren|から|부터|起|起價|ابتداءً من|từ)(\s|$)/i

/** A link that is a listing's card: long words with a price «from …» among them (not a button that pays). */
function listingCard(item: MapItem): boolean {
  return item.role === "link" && (item.label.length > 40 || PRICE_FROM.test(item.label))
}

// The word right after a count in a label («1 item», «2 услуги», «3 Artikel», «2点»): what's counted.
const chosenCountWord = wordTest(CHOSEN_COUNT_WORDS)
function countsChosen(label: string): boolean {
  for (const m of label.matchAll(/(?<![\d.,])\d{1,2}\s*([\p{L}\p{M}]+(?:\s[\p{L}\p{M}]+)?)/gu)) if (chosenCountWord(m[1])) return true
  return false
}

/** A booking's or shop's summary bar: the total and how many things are chosen, with no word that pays or orders —
 *  it shows the choice and goes on; the checkout comes after it. */
function cartSummary(item: MapItem, kind: string | undefined): boolean {
  return item.role === "button" && countsChosen(item.label) && (kind === undefined || kind === "nav" || kind === "weak")
}

/** The class of a click on `item` (a button, a link, a checkbox…) by its words and where it is. A press that commits
 *  (a booking, a form sent) on a page that holds money (a deposit, a no-show fee) pays: the person's. */
function clickClass(map: PageMap, item: MapItem, host: string): StepVerdict {
  const v = pressClass(map, item, host)
  // Only the press that commits, on the page where it commits (personal fields, a review / confirm page): a fee named
  // in a home page's text or a cookie banner's «Accept» isn't paying.
  return map.deposit && v.cls === "confirm" && v.reason === "submit" && commitStage(map) && !isConsentDialog(map, item) ? verdict("self", "pay") : v
}

function pressClass(map: PageMap, item: MapItem, host: string): StepVerdict {
  const hit = wordKind(item.label)
  const form = item.form !== undefined ? map.forms.find((f) => f.n === item.form) : undefined
  const toggle = item.role === "checkbox" || item.role === "radio" || item.role === "switch"
  if (toggle) {
    // «I agree to the terms», «I consent to…»: the person ticks it.
    if (hit?.kind === "consent" || anyWord(item.label, TERMS_BOX)) return verdict("self", "consent")
    return verdict("free", "toggle")
  }
  if (item.role === "file") return verdict("self", "file")
  // Money (the security review: paying was stopped by word lists only). An amount on the button («Donate €10», «Rent
  // $3.99») pays; on a page that takes payment (card fields, a payment frame, a checkout address) every press that
  // isn't a link elsewhere on the page, a tab, an option or a refusal is the person's own.
  // (A listing's card is a link with its price on it — «Salon … Men's haircut from £35», a salon marketplace: that's going to
  // the salon, not paying. A button with an amount, or a short link that names one, still pays.)
  if (amounts(item.label).length && !listingCard(item) && !cartSummary(item, hit?.kind)) return verdict("self", "pay")
  const quiet = item.role === "tab" || item.role === "option" || item.role === "summary" || item.role === "menuitem" || hit?.kind === "nav" || hit?.kind === "reject"
  if (map.pay && !quiet && !(item.role === "link" && !form)) return verdict("self", "pay")
  if (form?.secret && (hit?.kind === "submit" || hit?.kind === "weak" || hit?.kind === "send")) return verdict("self", "auth")
  if (hit) {
    if (hit.kind === "send") return isMessage(map, item, host) ? verdict("self", "send") : verdict("confirm", "submit")
    if (hit.kind === "consent" && isConsentDialog(map, item)) return verdict("self", "cookies_accept")
    if (SELF_KINDS.has(hit.kind)) return verdict("self", hit.kind)
    if (hit.kind === "reject") return isConsentDialog(map, item) ? verdict("free", "cookies_reject") : verdict("confirm", "decline")
    // A «Book now» / «Book an appointment» that only leads into a booking flow (TestFlight 118, the director on a salon booking site:
    // a question per step) is a free step; the press that commits the booking still asks — one in a form to fill, on
    // a page with personal fields, on a page that takes payment, or on a review / confirm / checkout page.
    if (hit.kind === "submit" && BOOK_ENTRY.test(hit.word) && !CART.test(hit.word) && !form?.fillable && !commitStage(map)) return verdict("free", "entry")
    // The cart: asked first, but undone on the site (the card doesn't say «can't be undone»).
    if (hit.kind === "submit") return verdict("confirm", CART.test(hit.word) ? "cart" : "submit")
    if (hit.kind === "weak") return form?.fillable ? verdict("confirm", "submit") : verdict("free", "weak")
    if (hit.kind === "nav") return form?.secret ? verdict("self", "auth") : verdict("free", "nav")
  }
  // No word we know: by what the control is.
  const submits = item.type === "submit" || item.type === "image" || (item.role === "button" && form !== undefined && item.type !== "button" && item.type !== "reset")
  if (submits && form) {
    if (form.secret) return verdict("self", "auth")
    if (form.otherSite) return verdict("confirm", "other_site")
    if (form.fillable) return verdict("confirm", "submit")
  }
  // A button with no words in something drawn over the page, outside a form: its close «×» (a salon marketplace's app banner had
  // one, and asking about it stopped the task). Elsewhere a wordless control still asks.
  if (!item.label.trim() && item.where === "dialog" && item.form === undefined && item.type !== "submit" && item.role === "button") return verdict("free", "close")
  if (!item.label.trim()) return verdict("confirm", "unknown")
  return verdict("free", "click")
}

/** The class of `call` on the page in `ctx`. The model's call is assumed checked (call.ts) against the map. */
export function classify(call: ToolCall, ctx: StepContext): StepVerdict {
  const host = hostOf(ctx.map.url)
  if (READ_ONLY.has(call.tool)) return verdict("free", "read")
  if (APPLE_WRITES.has(call.tool)) return verdict("confirm", call.tool)
  const blocked = blockedSite(host, ctx.policy)
  if (blocked) return verdict("blocked", `site_${blocked}`)
  const item = itemById(ctx.map, call.id)
  if (!item) return verdict("blocked", "no_item")
  if (item.lock === "secret") return verdict("blocked", "secret")

  let v: StepVerdict
  // The person's saved details go in only after their «Заполнить?» (the card shows the values; the model never does).
  if (call.tool === "fill") return verdict("confirm", "fill")
  if (call.tool === "type") {
    // A card number or an IBAN is never typed, into any field.
    if (hasSecretNumber(call.text ?? "")) return verdict("blocked", "secret_text")
    if (item.lock === "personal") v = verdict("confirm", "personal")
    else {
      const request = ctx.request.toLowerCase()
      const foreign = (call.text ?? "").match(ADDRESS)?.some((a) => !request.includes(a.toLowerCase().replace(/[.,;]+$/, "")))
      v = foreign ? verdict("confirm", "text_from_page") : verdict("free", "type")
    }
  } else if (call.tool === "select") {
    v = item.lock === "personal" ? verdict("confirm", "personal") : verdict("free", "select")
  } else {
    // click and go: a link elsewhere first, then the words.
    const to = item.role === "link" || call.tool === "go" ? linkHost(item, host) : host
    if (!sameSite(to, host)) return verdict("confirm", "other_site")
    v = clickClass(ctx.map, item, host)
  }
  // The first thing done on a site the task came to (not the one it began on) asks first.
  if (v.cls === "free" && !ctx.confirmedHere && ctx.startHost && !sameSite(host, ctx.startHost) && call.tool !== "scroll") {
    return verdict("confirm", "first_here")
  }
  return v
}
