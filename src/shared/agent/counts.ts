// A count the request didn't ask for (the director's real-site set, report-137: a table «for 2» set to «12 people» from a
// large-party list whose options started at 9). Decided by what the control is — a choice or a counter of people,
// tickets, rooms or children — never by one site's words: its label names what it counts, or its options are numbers of
// people («2 people», «2名», «2 personas»). The number expected is the one the person said (the request, then their
// answers: the last one said wins), else their standing rule (people) or 1 room and no children.

import type { MapItem, PageMap, ToolCall } from "./types.ts"

export type CountKind = "people" | "rooms" | "children"

// What a control's label counts, in the panel's 15 languages. (Single characters like 名 or 人 only after a number: on
// their own they're a name's field or anything else.)
const CHILDREN = /child|kid|infant|baby|enfant|bébé|kinder|baby|niñ|bebé|bambin|neonat|crianç|bebê|дет|ребён|ребен|младен|діт|дитин|çocuk|bebek|أطفال|رضيع|子供|子ども|お子様|幼児|어린이|아동|유아|儿童|兒童|婴儿|嬰兒|trẻ em|em bé/i
const ROOMS = /(?<!\p{L})rooms?(?!\p{L})|chambres?|zimmer|habitaci|camer[ae]|quartos?|номер(ов|а)?(?!\p{L})|комнат|кімнат|(?<!\p{L})oda(?!\p{L})|odalar|غرف|غرفة|部屋|客室|객실|房间|房間|客房|phòng/iu
const PEOPLE = /party|people|persons?|guests?|adults?|diners|covers|pax|tickets?|seats?|attendees|travell?ers|personnes?|couverts|convives|invités|adultes|billets?|personen|gäste|erwachsene|karten|plätze|personas|comensales|huéspedes|adultos|entradas|boletos|plazas|persone|coperti|ospiti|adulti|biglietti|posti|pessoas|hóspedes|ingressos|lugares|человек|гост|взросл|персон|билет|осіб|дорослих|квитк|kişi|misafir|yetişkin|bilet|أشخاص|ضيوف|بالغين|تذاكر|人数|名様|大人|チケット|인원|성인|티켓|人數|成人|người|khách|vé/i
// A number of people written with it («2 people», «2名», «2 personas», «на 2 персоны»).
const PEOPLE_AFTER = /(?<![\d.,:])(\d{1,2})\s*(?:\p{L}{2,12}\s+)?(?:people|persons?|guests?|adults?|diners|pax|tickets?|seats?|personnes?|couverts|adultes|billets?|places|personen|gäste|erwachsene|karten|plätze|personas|comensales|huéspedes|adultos|entradas|boletos|plazas|persone|coperti|ospiti|adulti|biglietti|posti|pessoas|hóspedes|adultos|ingressos|lugares|человек|гост\S*|взросл\S*|персон\S*|билет\S*|мест\S*|осіб|гост\S*|дорослих|квитк\S*|kişi|misafir|yetişkin|bilet|أشخاص|ضيوف|تذاكر|名|人|명|位|枚|매|장|người|khách|vé)/giu
// «for 2», «table for 2», «party of 2», «für 2», «pour 2», «para 2», «per 2», «на 2», «2 kişilik».
const PEOPLE_BEFORE = /(?<![\p{L}\d])(?:for|party of|für|pour|para|per|на|для)\s+(\d{1,2})(?![\d:.,]|\s*(?:[ap]\.?m\b|h\b|uhr|heures?|horas?|ore|час|nights?|noches?|nuits?|nächte|notti|ноч|days?|días|jours?|tage|giorni|дн|rooms?|chambres?|zimmer|habitaci|camer|номер|minutes?|min))/giu
const ROOMS_AFTER = /(?<![\d.,:])(\d{1,2})\s*(?:rooms?|chambres?|zimmer|habitaci\S*|camer[ae]|quartos?|номер\S*|комнат\S*|oda|غرف\S*|部屋|室|객실|개|房间?|間|phòng)/giu
const CHILDREN_AFTER = /(?<![\d.,:])(\d{1,2})\s*(?:child\S*|kids?|infants?|enfants?|kinder\S*|niñ\S*|bambin\S*|crianç\S*|дет\S*|ребён\S*|ребен\S*|діт\S*|çocuk|أطفال|子供|お子様|어린이|아동|儿童|兒童|trẻ em)/giu
// A press that adds one to a counter («+», «Increase», «Add adult»).
const PLUS = /^\s*(\+|＋|increase|add|plus|more|увеличить|добавить|больше|збільшити|додати|erhöhen|hinzufügen|mehr|augmenter|ajouter|aumentar|añadir|agregar|aumenta|aggiungi|adicionar|artır|ekle|زيادة|إضافة|増やす|追加|증가|추가|增加|添加|tăng|thêm)(?!\p{L})/iu

function lastNumber(text: string, re: RegExp): number | null {
  let n: number | null = null
  for (const m of text.matchAll(re)) n = Number(m[1])
  return n !== null && n >= 0 && n <= 99 ? n : null
}

/** The number of people the person said (the request, then their answers: the last said), or null. */
export function peopleSaid(text: string): number | null {
  // (The last mention in the text, whichever form it takes.)
  let best: { at: number; n: number } | null = null
  for (const re of [PEOPLE_AFTER, PEOPLE_BEFORE]) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1])
      if (n >= 1 && n <= 99 && (!best || (m.index ?? 0) >= best.at)) best = { at: m.index ?? 0, n }
    }
  }
  return best?.n ?? null
}

/** What a control counts: by its label, else by its options (numbers of people). */
export function countKind(item: Pick<MapItem, "label" | "options" | "role">): CountKind | null {
  const label = item.label ?? ""
  if (CHILDREN.test(label)) return "children"
  if (ROOMS.test(label)) return "rooms"
  if (PEOPLE.test(label)) return "people"
  const opts = (item.options ?? []).slice(0, 6)
  if (opts.length >= 2 && opts.every((o) => new RegExp(PEOPLE_AFTER.source, "iu").test(o))) return "people"
  return null
}

/** The count expected for a control of this kind. */
export function countExpected(kind: CountKind, said: string, ruleParty?: number): number | null {
  if (kind === "people") return peopleSaid(said) ?? ruleParty ?? null
  if (kind === "rooms") return lastNumber(said, ROOMS_AFTER) ?? 1
  return lastNumber(said, CHILDREN_AFTER) ?? 0
}

const NAMES: Record<CountKind, string> = { people: "people (guests, tickets or seats as the page counts them)", rooms: "room(s)", children: "children" }

function firstNumber(text: string): number | null {
  const m = /(?<![\d.,:])(\d{1,2})(?![\d:.,])/.exec(text)
  return m ? Number(m[1]) : null
}

/**
 * A choice or counter set to a number that isn't the request's: the reason it's refused, or null. `said` is the person's
 * words (request and answers); `ruleParty` their standing rule for people.
 */
export function countRefusal(call: ToolCall, item: MapItem | null | undefined, map: PageMap, said: string, ruleParty?: number): string | null {
  if (!item) return null
  if (call.tool === "select" || (call.tool === "type" && (item.type === "number" || item.role === "slider"))) {
    const kind = countKind(item)
    if (!kind) return null
    const chosen = firstNumber(call.tool === "select" ? call.option ?? "" : call.text ?? "")
    const want = countExpected(kind, said, ruleParty)
    if (chosen === null || want === null || chosen === want) return null
    const offered = (item.options ?? []).map(firstNumber).filter((n): n is number => n !== null)
    const missing = offered.length && !offered.includes(want)
    return `«${(call.tool === "select" ? call.option : call.text) ?? ""}» isn't the ${want} ${NAMES[kind]} the request asks: ${missing ? `this list doesn't offer ${want} (it has ${offered[0]}–${offered[offered.length - 1]}) — another control on the page may set it; if none does, ask_user with what the page offers` : `choose ${want}`}`
  }
  if (call.tool === "click" && PLUS.test(item.label)) {
    // The counter's value beside the press (a number field or a select within three items, of a kind this counts).
    const at = map.items.indexOf(item)
    const near = map.items.slice(Math.max(0, at - 3), at + 4).find((i) => i !== item && (i.type === "number" || i.role === "slider" || i.role === "textbox" || i.role === "select" || i.role === "combobox") && firstNumber(i.value ?? "") !== null)
    const kind = countKind({ label: `${item.label} ${near?.label ?? ""}`, role: item.role }) ?? (near ? countKind(near) : null)
    if (!near || !kind) return null
    const now = firstNumber(near.value ?? "")!
    const want = countExpected(kind, said, ruleParty)
    if (want === null || now < want) return null
    return `the ${NAMES[kind]} already show ${now}, and the request asks ${want}: ${now === want ? "leave it and go on" : `lower it to ${want}`}`
  }
  return null
}
