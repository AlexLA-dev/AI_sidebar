// Which fields the agent never reads or types into ("secret") and which it types into only after «Сделать?» and
// shows the model only as filled or empty ("personal"). From what the page says about a field: its type, its
// autocomplete token, its name and id, its label. Plain data in, so the tests and the server use it as it is.

import { wordList } from "./match.ts"
import type { Lock } from "./types.ts"
import { PERSONAL_FIELD, SECRET_FIELD } from "./words.ts"

export interface FieldFacts {
  tag: string
  type?: string
  autocomplete?: string
  name?: string
  id?: string
  label?: string
  inputmode?: string
}

const SECRET_AUTO = /\b(cc-[a-z-]+|current-password|new-password|one-time-code|transaction-amount)\b/
const PERSONAL_AUTO = /\b(name|honorific-prefix|given-name|additional-name|family-name|honorific-suffix|nickname|username|email|tel|tel-[a-z-]+|street-address|address-line\d|address-level\d|country|country-name|postal-code|bday|bday-[a-z]+|sex|organization|organization-title|impp)\b/
// What sites call their card, account and code fields in names and ids (any language's site uses English names).
const SECRET_NAME = /pass(word|wd|code)?\b|\bpwd\b|card.?(num|no\b|number)|\bccnum|\bcc.?(number|num|exp|cvc|cvv)|\bcvc\b|\bcvv\d?\b|\biban\b|\bbic\b|\bswift\b|security.?code|\botp\b|one.?time|verif(y|ication).?code|sms.?code|\bssn\b|passport|\binn\b|\bsnils\b|\btckn\b|\bcpf\b|\bdni\b|routing|account.?(num|no\b)/i
const PERSONAL_NAME = /(^|[\W_])(first.?name|last.?name|full.?name|surname|fname|lname|e.?mail|phone|mobile|tel\b|address|street|city|zip|postcode|postal|birth|bday|dob)([\W_]|$)/i

const SEARCH_LABEL = /\b(search|find|look(ing)? for|keyword|cuisine|restaurant|product|item|dish|treatment|service|destination)\b|поиск|найти|искать|что ищете|ресторан|кухн|блюд|услуг|пошук|шукати|suche|suchen|recherche|rechercher|buscar|búsqueda|cerca|cercare|pesquisar|buscar|ara\b|arama|検索|探す|검색|搜索|搜尋|查找|بحث|tìm/i

const secretLabel = wordList(SECRET_FIELD)
const personalLabel = wordList(PERSONAL_FIELD)

/** The field's lock, or null when the model may see and the agent may type its value. */
export function fieldLock(f: FieldFacts): Lock | null {
  const type = (f.type ?? "").toLowerCase()
  const auto = (f.autocomplete ?? "").toLowerCase()
  const names = `${f.name ?? ""} ${f.id ?? ""}`
  if (type === "password" || type === "hidden") return "secret"
  if (SECRET_AUTO.test(auto)) return "secret"
  if (SECRET_NAME.test(names)) return "secret"
  if (f.label && secretLabel(f.label)) return "secret"
  if (type === "email" || type === "tel") return "personal"
  if (PERSONAL_AUTO.test(auto)) return "personal"
  if (PERSONAL_NAME.test(names)) return "personal"
  // A search box isn't the person's: «Cuisine, restaurant name…» (TheFork) read as a name field, and typing a search
  // asked first. Its page's own type or words say so; a field the page names as personal stays so (above).
  if (type === "search" || (f.label && SEARCH_LABEL.test(f.label))) return null
  if (f.label && personalLabel(f.label)) return "personal"
  return null
}
