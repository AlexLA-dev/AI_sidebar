// A step's class (free / confirm / self / blocked), decided by code from the call, the control and the page: the
// model's own words about a step never change it. The server checks with this before it answers, and the extension
// checks again before it acts (the extension is the one that presses).

import { anyWord, normalize, wordKind, wordTest } from "./match.ts"
import { isDateLabel } from "./dates.ts"
import { amounts, withoutAmounts } from "./money.ts"
import { looksLikeSlot, SLOT_TIME } from "./rules.ts"
import { counterPress } from "./counts.ts"
import { blockedSite, hostOf, sameSite, type SitePolicy } from "./sites.ts"
import type { MapItem, PageMap, StepVerdict, ToolCall } from "./types.ts"
import { CHOSEN_COUNT_WORDS, CONSENT_DIALOG, NAV_AWAY, TERMS_BOX } from "./words.ts"

export interface StepContext {
  map: PageMap
  // The site the task began on: going elsewhere needs a «Да».
  startHost: string
  // The person's own words: text the model types that names an address or an e-mail not in them needs a «Да».
  request: string
  // A «Да» was given on this site during the task already (the first step on a site the task came to asks).
  confirmedHere: boolean
  policy: SitePolicy
  // The task has an approved plan with a booking (decision 16: a priced choice there is a choice, not a payment).
  booking?: boolean
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

// (set_dates: the device classes each of its presses itself and goes only through free ones.)
const READ_ONLY = new Set(["read_page", "scroll", "extract", "ask_user", "done", "back", "reminders", "calendar", "set_dates"])
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

// A sign-in by a contact alone (the director's real-site set, report-137: a clinic booking's «Continue with your
// e-mail… if it's your first booking, we'll create a free account» was pressed with the test e-mail, twice). Decided by
// what the page is, never by the site: an e-mail or phone field with the press beside it and no other booking detail
// asked there; or a page that says an account is made for that e-mail, or offers «continue with Google/Apple».
const CONTACT_LABEL = /e-?mail|correo|courriel|почт|пошт|posta|メール|이메일|邮箱|郵箱|電子郵件|电子邮件|البريد|phone|mobile|handy|telefon|téléphone|teléfono|telefono|telefone|celular|телефон|мобильн|電話|携帯|전화|휴대폰|电话|手机|điện thoại|هاتف|جوال/i
// A field beside a phone that only picks its country code («+44», «Country code», «Código de país»).
const DIAL_CODE = /\+\d|country|code|código|codice|indicatif|vorwahl|код|kod|国番号|국가|区号|區號|mã|رمز/i
// Text that says the e-mail makes or opens an account (15 languages): «we'll create an account», «create a free account»,
// «linked to this e-mail», «sign in or create an account».
const ACCOUNT_MADE = /(we('| wi)ll|will) create (an?|your)( free)? account|create an? (free )?account|sign in or (create|register)|linked to (this|your) e-?mail|crearemos una cuenta|crear (una )?cuenta|vinculadas? a (este|tu) correo|créerons un compte|créer un compte|wir erstellen (dir|ihnen) ein( kostenloses)? konto|konto (erstellen|anlegen)|creeremo un account|crea(re)? un account|criaremos uma conta|criar (uma )?conta|созда(дим|ть|м)( бесплатн\S*)? (аккаунт|учётн\S* запис|учетн\S* запис|профиль|личный кабинет)|створ(имо|ити) (акаунт|обліков\S* запис)|hesap oluştur|سننشئ حساب|إنشاء حساب|アカウントを?作成|계정(을|이)? (만들|생성)|创建(账户|帐户|账号)|建立(帳戶|帳號)|tạo tài khoản/i
// «Continue with Google», «Sign in with Apple» in the panel's languages: a sign-in with another account.
const SOCIAL_SIGNIN = /(continue|sign in|log in|sign up|weiter|fortfahren|anmelden|continuer|se connecter|continuar|iniciar sesión|continua|accedi|entrar|продолжить|войти|продовжити|увійти|devam|giriş|متابعة|تسجيل|続け|ログイン|계속|로그인|继续|繼續|登录|登入|tiếp tục|đăng nhập)\s*(with|mit|avec|con|com|через|с|з|ile|باستخدام|で|로|使用|bằng)?\s*(google|apple|facebook)|(google|apple|facebook)\s*(で|로|で続ける|ile)/i

// A press that goes back or cancels, in the panel's languages.
const BACKWARD = /^(back|go back|previous|cancel|zurück|abbrechen|retour|précédent|annuler|atrás|volver|anterior|cancelar|indietro|annulla|voltar|назад|отмена|отменить|скасувати|geri|iptal|رجوع|إلغاء|戻る|キャンセル|뒤로|취소|返回|取消|quay lại|hủy)$/i

const FIELD_ROLES = new Set(["textbox", "textarea", "combobox", "select"])

function isContactField(i: MapItem): boolean {
  return i.type === "email" || i.type === "tel" || CONTACT_LABEL.test(i.label)
}

/** The fields the press goes with: its form's, or (no form) the fields just before it that are in no form either. */
function fieldsOfPress(map: PageMap, item: MapItem): MapItem[] {
  const field = (i: MapItem) => FIELD_ROLES.has(i.role) && i.type !== "search" && i.type !== "hidden" && i.lock !== "secret"
  if (item.form !== undefined) return map.items.filter((i) => i.form === item.form && field(i))
  // (No form: the fields just before the press, with only links or boxes between — the terms link under an e-mail.
  // Another button between them is another control's press: a shop's «Show more» isn't the e-mail's.)
  const at = map.items.indexOf(item)
  const out: MapItem[] = []
  for (let k = at - 1; k >= Math.max(0, at - 10); k--) {
    const i = map.items[k]
    if (i.form !== undefined) break
    if (field(i)) out.unshift(i)
    else if (i.role === "button" || i.role === "tab" || i.role === "option") break
  }
  return out
}

/** A press that signs in or makes an account by a contact alone (see ACCOUNT_MADE). */
export function contactSignIn(map: PageMap, item: MapItem): boolean {
  const fields = fieldsOfPress(map, item)
  const contact = fields.filter(isContactField)
  if (!contact.length) return false
  // (A phone's country-code list beside it isn't another booking detail.)
  const others = fields.filter((i) => !isContactField(i) && !((i.role === "select" || i.role === "combobox") && DIAL_CODE.test(`${i.label} ${(i.options ?? []).slice(0, 3).join(" ")}`)))
  if (!others.length) return true
  // Other fields beside it: only when the page says the e-mail makes an account and no name is asked (a booking's
  // details form asks the name).
  const named = others.some((i) => /name|nombre|nom\b|vorname|nachname|nome|имя|фамил|ім'я|прізвищ|isim|ad\b|soyad|الاسم|名前|氏名|なまえ|이름|姓名|名字|họ|tên/i.test(i.label) || /^\s*[氏名姓]\s*[*＊]?\s*(必須)?\s*$/.test(i.label))
  return !named && (ACCOUNT_MADE.test(map.text) || map.items.some((i) => i.role === "link" && SOCIAL_SIGNIN.test(i.label)))
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

// Decision 11 (round 142, the director's; a narrowing): in scripts written without spaces a card says as much in fewer
// characters — Han, Hiragana, Katakana and Hangul count two in a card's length; and the «from» written joined to its
// price («€35から», «3,500円〜», «35,000원부터», «¥300起») is a «from». Only in the amount rule, only on a page that doesn't
// take payment, links only.
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const JOINED_FROM = /(?:[€$£¥₩]\s?\d[\d.,]*|\d[\d.,]*\s?(?:円|원|元|€|₩|¥|\$))(?:から|〜|～|부터|起)/u
function cardLength(label: string): number {
  let n = 0
  for (const ch of label) n += WIDE.test(ch) ? 2 : 1
  return n
}
function listingCardWide(item: MapItem): boolean {
  return item.role === "link" && (cardLength(item.label) > 40 || PRICE_FROM.test(item.label) || JOINED_FROM.test(item.label))
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
function clickClass(map: PageMap, item: MapItem, host: string, booking = false): StepVerdict {
  const v = pressClass(map, item, host, booking)
  // Only the press that commits, on the page where it commits (personal fields, a review / confirm page): a fee named
  // in a home page's text or a cookie banner's «Accept» isn't paying.
  if (map.deposit && v.cls === "confirm" && v.reason === "submit" && commitStage(map) && !isConsentDialog(map, item)) return verdict("self", "pay")
  return v.cls === "self" || v.cls === "blocked" || !signsIn(map, item) ? v : verdict("self", "account")
}

/**
 * A press that sends a contact alone (an e-mail or a phone, nothing else of the booking beside it: «Continue», «Next»,
 * «Send code», a wordless submit), or any press beside a contact field on a page that says the e-mail makes an account:
 * signing in or making an account, the person's. A booking's own commit word («Book», «Reserve», «Confirm») beside a
 * phone alone stays the booking's press, with its «Do it?». Not a link, a tab, an option, a refusal or a «Back».
 */
function signsIn(map: PageMap, item: MapItem): boolean {
  if (item.role === "link" || item.role === "tab" || item.role === "option" || item.role === "summary" || item.role === "menuitem" || item.role === "checkbox" || item.role === "radio" || item.role === "switch") return false
  const hit = wordKind(item.label)
  if (hit?.kind === "reject" || BACKWARD.test(item.label.trim())) return false
  if (!contactSignIn(map, item)) return false
  return hit?.kind !== "submit" || ACCOUNT_MADE.test(map.text)
}

// A priced choice in a picker is a choice, not a payment (round 141, the director's decision): a control whose words are
// only a day and/or a time with its price («SAT 28 €10», «10:40 € 25»), no word of the pay, book or order lists, among
// at least three like ones, on a page that doesn't take payment, is classed as the same control without the price.
// «Pay €35 now», «Book 10:40 €25», a lone priced button and any priced press on a page that takes payment keep theirs.
const dayOrTime = (label: string) => {
  // A day: the label without its price, either reading of a space («1 200 ₽», «28/11 150.000 đ»).
  if ([withoutAmounts(label), withoutAmounts(label, true)].some((bare) => !!bare && isDateLabel(bare))) return true
  // A time: the time taken out first (its minutes aren't a price: «10:40 € 25»), then nothing but the price is left.
  if (label.length > 40 || !SLOT_TIME.test(label)) return false
  const rest = label.replace(new RegExp(SLOT_TIME.source, "gi"), " ")
  return [withoutAmounts(rest), withoutAmounts(rest, true)].some((t) => !/[\p{L}\p{N}]/u.test(t))
}
function pricedChoice(map: PageMap, item: MapItem, hit: ReturnType<typeof wordKind>): boolean {
  if (map.pay || hit || !PICKER_ROLES.has(item.role) || !dayOrTime(item.label)) return false
  const like = map.items.filter((i) => i.id !== item.id && i.role === item.role && priced(i.label) && dayOrTime(i.label))
  return like.length >= 3
}
const PICKER_ROLES = new Set(["button", "option", "radio", "link", "other", "tab"])
// (A price beside a time: the time taken out first, so «12:00 € 30» isn't read as «00 €».)
const priced = (label: string) => amounts(label).length > 0 || amounts(label.replace(new RegExp(SLOT_TIME.source, "gi"), " ")).length > 0

// Decision 16 (round 142, the director's; a money guard narrowed, with these limits): a control the amount rule alone calls
// pay is one of a set when at least one other control of its role in its group (its form, or the same place on the page
// when it has none) carries an amount and no pay word — priced rows of services, rooms, days, tickets.
function pricedSet(map: PageMap, item: MapItem): boolean {
  const group = (i: MapItem) => (item.form !== undefined ? i.form === item.form : i.form === undefined && i.where === item.where)
  return map.items.some((i) => i.id !== item.id && i.role === item.role && group(i) && priced(i.label) && wordKind(i.label)?.kind !== "pay")
}

function pressClass(map: PageMap, item: MapItem, host: string, booking = false): StepVerdict {
  // A listing's card (a long link to a place, with its address) carries the place's promo and ratings text («6% discount:
  // bring 1 friend, pay less», «614 reviews»): those words don't make opening the place a payment, a review or a post
  // (the director's real-site set, round 138: a salon card stopped as «pay»). A short link, a button, or a card on a page
  // that takes payment keeps every word; a card's sign-in words still count.
  const word = wordKind(item.label)
  const hit = word && listingCard(item) && item.label.length > 40 && !!item.href && !map.pay && (word.kind === "pay" || word.kind === "rate" || word.kind === "post") ? null : word
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
  if (amounts(item.label).length && !(map.pay ? listingCard(item) : listingCardWide(item)) && !cartSummary(item, hit?.kind) && !pricedChoice(map, item, hit)) {
    // Decision 16, only in an approved booking plan and off a page that takes payment (card fields, a payment frame or
    // a provider button make it one), never with a pay word: (b) a button whose word is a booking word with its amount
    // («Reserve 1 room for € 265») is the booking's own press — «Do it?» with the recap; (a) a control with no word but
    // its price, one of a set of priced ones («… от 1500 RUB … Выбрать», a row's «€ 25»), is a priced choice — a card.
    // A lone priced control, any pay word, a cart word, a payment page or no booking plan: the person's, as before.
    if (booking && !map.pay && hit?.kind !== "pay") {
      if (item.role === "button" && hit?.kind === "submit" && BOOK_ENTRY.test(hit.word) && !CART.test(hit.word)) return verdict("confirm", "submit")
      if ((!hit || hit.kind === "nav" || hit.kind === "weak") && pricedSet(map, item)) return verdict("confirm", "priced_choice")
    }
    return verdict("self", "pay")
  }
  // (Decision 10: on a page that takes payment only a nav word that leads away or shows more stays quiet; «Continue»,
  // «Next», «Checkout» move the purchase forward and are the person's own there.)
  const quiet = item.role === "tab" || item.role === "option" || item.role === "summary" || item.role === "menuitem" || (hit?.kind === "nav" && (!map.pay || NAV_AWAY_SET.has(hit.word))) || hit?.kind === "reject"
  if (map.pay && !quiet && !(item.role === "link" && !form)) return verdict("self", "pay")
  if (form?.secret && (hit?.kind === "submit" || hit?.kind === "weak" || hit?.kind === "send")) return verdict("self", "auth")
  // «Continue with Google / Apple»: a sign-in with another account, the person's.
  if (SOCIAL_SIGNIN.test(item.label)) return verdict("self", "auth")
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
const NAV_AWAY_SET = new Set(NAV_AWAY.map(normalize))

const FUNNEL_FIELDS = new Set(["textbox", "textarea", "editor", "combobox", "select", "listbox", "slider", "option", "tab"])
/** What stays free inside a checkout funnel: a field, a choice in a picker, a counter's plus or minus. */
function funnelFree(map: PageMap, item: MapItem): boolean {
  return FUNNEL_FIELDS.has(item.role) || isDateLabel(item.label) || looksLikeSlot(item.label) || !!counterPress(item, map)
}

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
    v = clickClass(ctx.map, item, host, ctx.booking === true)
  }
  // Inside a checkout funnel with no payment sign (decision 9): a forward press the ordinary rules call free is carded;
  // a field, a choice in a picker (a day, a time, an option, a tab) or a counter's plus or minus goes without one.
  if (ctx.map.funnel && !ctx.map.pay && v.cls === "free" && (call.tool === "click" || call.tool === "go") && !funnelFree(ctx.map, item)) v = verdict("confirm", "checkout_step")
  // The first thing done on a site the task came to (not the one it began on) asks first.
  if (v.cls === "free" && !ctx.confirmedHere && ctx.startHost && !sameSite(host, ctx.startHost) && call.tool !== "scroll") {
    return verdict("confirm", "first_here")
  }
  return v
}
