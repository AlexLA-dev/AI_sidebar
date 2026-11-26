// Days on a page, in any of the panel's 15 languages: a date strip's «Sat 26 Dec», «сб, 26 дек.», «Tue, Nov 24», a
// calendar's bare «26» under its month, «26.12», «12月26日». Month and weekday names come from the platform's own
// calendar data (Intl) for every language, short and long, the forms a day takes («декабря») and stands alone in
// («декабрь») — never a list written for one site.

import { looksLikeSlot } from "./rules.ts"
import type { MapItem, PageMap } from "./types.ts"

const LOCALES = ["en", "ru", "uk", "de", "fr", "es", "it", "pt", "tr", "ar", "ja", "ko", "zh-Hans", "zh-Hant", "vi"]

// Chinese, Japanese and Korean names sit next to digits with no space («12月26日»): matched anywhere.
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/

const clean = (s: string) => s.normalize("NFKC").toLocaleLowerCase().replace(/[.,]/g, "").trim()

interface Matcher {
  re: RegExp | null
  cjk: RegExp | null
}

interface Names {
  months: Matcher[]
  weekdays: Matcher
}

let names: Names | null = null

function partOf(locale: string, opts: Intl.DateTimeFormatOptions, date: Date, type: "month" | "weekday"): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).formatToParts(date).find((p) => p.type === type)?.value ?? ""
  } catch {
    return ""
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One pattern for a set of names: whole words (a month «dec» in «Sat 26 Dec», not in «decide»); CJK ones anywhere. */
function matcher(list: Iterable<string>): Matcher {
  const words: string[] = []
  const cjk: string[] = []
  for (const n of list) {
    if (!n || /^\d+$/.test(n)) continue
    if (CJK.test(n)) cjk.push(n)
    else words.push(n)
  }
  words.sort((a, b) => b.length - a.length)
  cjk.sort((a, b) => b.length - a.length)
  // Letters and digits around a name end it («thg 1» isn't in «thg 12»; «2月» isn't in «12月»).
  return {
    re: words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "u") : null,
    cjk: cjk.length ? new RegExp(`(?<![\\p{N}])(?:${cjk.map(esc).join("|")})`, "u") : null
  }
}

const hit = (m: Matcher, text: string) => (!!m.re && m.re.test(text)) || (!!m.cjk && m.cjk.test(text))

function allNames(): Names {
  if (names) return names
  const months: Matcher[] = []
  for (let m = 0; m < 12; m++) {
    const d = new Date(Date.UTC(2026, m, 15, 12))
    const set = new Set<string>()
    for (const loc of LOCALES) {
      for (const month of ["short", "long"] as const) {
        set.add(clean(partOf(loc, { month }, d, "month")))
        set.add(clean(partOf(loc, { month, day: "numeric" }, d, "month")))
      }
    }
    months.push(matcher(set))
  }
  const days = new Set<string>()
  for (let w = 0; w < 7; w++) {
    const d = new Date(Date.UTC(2026, 10, 1 + w, 12))
    for (const loc of LOCALES) for (const weekday of ["short", "long"] as const) days.add(clean(partOf(loc, { weekday }, d, "weekday")))
  }
  names = { months, weekdays: matcher([...days].filter((n) => n.length >= 2 || CJK.test(n))) }
  return names
}

/** The month (0–11) a text names, or -1. */
export function monthIn(text: string): number {
  const t = clean(text)
  const { months } = allNames()
  for (let m = 0; m < 12; m++) if (hit(months[m], t)) return m
  return -1
}

function namesMonth(text: string, m: number): boolean {
  return hit(allNames().months[m], clean(text))
}

export function weekdayIn(text: string): boolean {
  return hit(allNames().weekdays, clean(text))
}

// A day's number on its own (not part of a time «12:30», a price «€18» or a year).
const DAY_NUMBER = /(?<![\d:.,€$£¥])(0?[1-9]|[12]\d|3[01])(?![\d:])/u
// «26.12», «05.01», «5.1.» — a month of two digits or a closing dot (a rating «9.1» or «4.8» is neither).
const DOTTED = /(?<![\d.,])(0?[1-9]|[12]\d|3[01])[./](0[1-9]|1[0-2]|[1-9]\.)(?![\d:])/

/** A day in a date strip or calendar: a day's number with a month or weekday name, or «26.12». Never a time slot. */
export function isDateLabel(label: string): boolean {
  if (label.length > 60 || looksLikeSlot(label)) return false
  if (DOTTED.test(label)) return true
  if (!DAY_NUMBER.test(label)) return false
  return monthIn(label) >= 0 || weekdayIn(label)
}

/** The page's controls that are the day (YYYY-MM-DD): its number with its month, «26.12», or a calendar's bare «26»
 *  when the page names that month. */
export function dayItems(map: PageMap, iso: string): MapItem[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return []
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const num = new RegExp(`(?<![\\d:.,€$£¥])0?${day}(?![\\d:])`)
  const mm = month + 1
  const dotted = new RegExp(`(?<![\\d.,])0?${day}[./](?:${String(mm).padStart(2, "0")}${mm < 10 ? `|${mm}\\.` : ""})(?![\\d:])`)
  const bare = new RegExp(`^\\s*0?${day}\\s*$`)
  const monthOnPage = namesMonth(map.text, month) || namesMonth(map.title, month) || map.items.some((i) => i.label.length <= 60 && namesMonth(i.label, month))
  return map.items.filter((i) => {
    const l = i.label
    if (l.length > 60 || looksLikeSlot(l)) return false
    if (dotted.test(l)) return true
    if (num.test(l) && namesMonth(l, month)) return true
    return monthOnPage && bare.test(l)
  })
}

/** The day as words for the model: «Sat, 26 Dec 2026». */
export function dayWords(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
}

/** The day (YYYY-MM-DD) a label names with its month («Sat 28 Nov», «28.11»), its year the one nearest to `near`
 *  (YYYY-MM-DD); null when the label has no month (a calendar's bare «28»). */
export function dayOf(label: string, near: string): string | null {
  const ref = /^(\d{4})-(\d{2})-(\d{2})$/.exec(near)
  if (!ref || label.length > 60 || looksLikeSlot(label)) return null
  let month = -1
  let day = 0
  const dotted = DOTTED.exec(label)
  if (dotted) {
    day = Number(dotted[1])
    month = Number(dotted[2].replace(".", "")) - 1
  } else {
    month = monthIn(label)
    const n = DAY_NUMBER.exec(label)
    if (month < 0 || !n) return null
    day = Number(n[1])
  }
  const refMonth = Number(ref[2]) - 1
  let year = Number(ref[1])
  // December's request and a January day: next year; the other way round: last year.
  if (month - refMonth > 6) year--
  if (refMonth - month > 6) year++
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

const pad2 = (n: number) => String(n).padStart(2, "0")
const DAY_TOKEN = /^(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th|er|e|º|ª|-?го|-?е)?[.,]?$/iu

/**
 * The days (YYYY-MM-DD) a text names: «2026-12-04», «4 Dec», «December 4», «Fri, Dec 4», «04.12», «12月4日», «12월 4일»
 * (its year the one nearest to `near`). A calendar's bare «4» names no day.
 */
export function daysInText(text: string, near: string): string[] {
  const out = new Set<string>()
  const ref = /^(\d{4})-(\d{2})-(\d{2})$/.exec(near)
  if (!ref) return []
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) out.add(m[0])
  const at = (month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return
    let year = Number(ref[1])
    if (month - 1 - (Number(ref[2]) - 1) > 6) year--
    if (Number(ref[2]) - 1 - (month - 1) > 6) year++
    out.add(`${year}-${pad2(month)}-${pad2(day)}`)
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]/gu)) at(Number(m[1]), Number(m[2]))
  // («26.12», «5.1.»: never a time «19.30» or a price, which have no month of their own.)
  // «12/04/2026», «12/4 – 12/6»: day/month or month/day by the page's habit, which a text alone doesn't say — both
  // readings (one of them is the asked day or neither is; 128, the director: a US-order page never «showed» its dates).
  for (const m of text.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/g)) {
    const [a, b2, y] = [Number(m[1]), Number(m[2]), m[3]]
    for (const [mo, d] of [[b2, a], [a, b2]]) {
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue
      if (y) out.add(`${y}-${pad2(mo)}-${pad2(d)}`)
      else at(mo, d)
    }
  }
  for (const m of text.matchAll(new RegExp(DOTTED.source.replace("[./]", "\\."), "g"))) if (!/\d[.,]\d{2}\s*(€|\$|£|eur|usd)/i.test(text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 5))) at(Number(m[2].replace(".", "")), Number(m[1]))
  const words = text.split(/\s+/)
  words.forEach((w, i) => {
    if (!/\p{L}/u.test(w) || /\d/.test(w) || monthIn(w) < 0) return
    for (const n of [words[i - 1], words[i + 1]]) {
      const num = DAY_TOKEN.exec(n ?? "")
      const d = num ? dayOf(`${num[1]} ${w}`, near) : null
      if (d) out.add(d)
    }
  })
  return [...out]
}

const CHOSEN = new Set(["selected", "checked", "pressed", "current"])

/**
 * Whether the page shows the day (YYYY-MM-DD) as set: a field holding it, a day control marked chosen, a control or
 * the text naming it with its month («Fri 4 Dec – Sun 6 Dec», «2026-12-04»). A calendar of many days (each named by
 * its label) counts only by the one marked chosen: a day on offer isn't a day set.
 */
export function showsDay(map: PageMap, iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  if (map.items.some((i) => !!i.value && (i.value === iso || (i.value.length <= 60 && (dayOf(i.value, iso) === iso || daysInText(i.value, iso).includes(iso)))))) return true
  const days = dayItems(map, iso)
  if (days.some((i) => i.state?.some((s) => CHOSEN.has(s)))) return true
  const named = map.items.filter((i) => i.label.length <= 60 && isDateLabel(i.label)).length
  if (named <= 3 && days.some((i) => !/^\s*\d{1,2}\s*$/.test(i.label) && !i.state?.some((s) => s === "unavailable" || s === "disabled"))) return true
  return daysInText(`${map.title}\n${map.text}`, iso).includes(iso)
}

/** The request names its day only by a weekday («next Friday», «в пятницу», «Monday morning»): no date of its own. */
export function weekdayOnly(text: string, near: string): boolean {
  return weekdayIn(text) && !daysInText(text, near).length && !/(?<!\d)\d{1,2}[./]\d{1,2}(?!\d)/.test(text)
}


/**
 * A text with each day it names in words («Thursday 26 November», «Thu 26 Nov», «26 Nov», «December 4, 2026»,
 * «12月4日») written as YYYY-MM-DD, so one format can show them all (128: the same task said «Thursday 26 November»,
 * «Thu 26 Nov», «26 Nov» and «Thu, Nov 26»). A weekday before the day goes with it; anything else stays as it was.
 */
export function daysAsIso(text: string, near: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(near) || !text) return text
  let out = text.replace(/(?<!\d)(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]/gu, (m, mo: string, d: string) => daysInText(m, near)[0] ?? m)
  const tokens = [...out.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index ?? 0 }))
  const word = (t: string) => t.replace(/^[(«"“]+|[)»"”.,;:!?]+$/gu, "")
  const spans: Array<{ start: number; end: number; iso: string }> = []
  tokens.forEach((tok, i) => {
    const w = word(tok.text)
    // (A lowercase «may» or «mar» is a word of its own: «you may 5…», «mar» the sea.)
    if (!/\p{L}/u.test(w) || /\d/.test(w) || monthIn(w) < 0 || /^(may|mar)$/.test(w)) return
    // A range «4–6 December» / «December 4–6»: both days, as «2026-12-04 – 2026-12-06».
    const range = (t?: { text: string; at: number }) => (t ? /^(0?[1-9]|[12]\d|3[01])[–-](0?[1-9]|[12]\d|3[01])[.,;:!?)]*$/u.exec(t.text) : null)
    const rb = range(tokens[i - 1])
    const ra = rb ? null : range(tokens[i + 1])
    if (rb || ra) {
      const r = (rb ?? ra)!
      const a = dayOf(`${r[1]} ${w}`, near)
      const z = dayOf(`${r[2]} ${w}`, near)
      const from = rb ? i - 1 : i
      const to = rb ? i : i + 1
      if (a && z && !spans.some((x) => x.end > tokens[from].at)) {
        const tail = tokens[to].text.length - tokens[to].text.replace(/[)»"”.,;:!?]+$/u, "").length
        spans.push({ start: tokens[from].at, end: tokens[to].at + tokens[to].text.length - tail, iso: `${a} – ${z}` })
      }
      return
    }
    let first = -1
    let last = -1
    let day = ""
    const before = tokens[i - 1] && DAY_TOKEN.exec(word(tokens[i - 1].text)) ? word(tokens[i - 1].text) : ""
    const after = !before && tokens[i + 1] && DAY_TOKEN.exec(tokens[i + 1].text.replace(/[)»"”.,;:!?]+$/u, "")) ? tokens[i + 1].text : ""
    if (before) [first, last, day] = [i - 1, i, before]
    else if (after) [first, last, day] = [i, i + 1, word(after)]
    else return
    const iso = dayOf(`${DAY_TOKEN.exec(day)?.[1] ?? day} ${w}`, near)
    if (!iso) return
    // (Its year, when written: «December 4, 2026».)
    if (tokens[last + 1] && /^\d{4}[.,;:!?)]*$/.test(tokens[last + 1].text) && word(tokens[last + 1].text) === iso.slice(0, 4)) last++
    // (Its weekday, just before it: «Thursday 26 November», «Thu, Nov 26».)
    if (tokens[first - 1] && /\p{L}/u.test(tokens[first - 1].text) && weekdayIn(word(tokens[first - 1].text)) && word(tokens[first - 1].text).length <= 12) first--
    if (spans.some((s) => s.end > tokens[first].at)) return
    const tail = tokens[last].text.length - tokens[last].text.replace(/[)»"”.,;:!?]+$/u, "").length
    // (A bracket or a quote before it stays: «(Fri, Dec 4 to …)» kept its «(», 128.)
    const lead = tokens[first].text.length - tokens[first].text.replace(/^[(«"“]+/u, "").length
    spans.push({ start: tokens[first].at + lead, end: tokens[last].at + tokens[last].text.length - tail, iso })
  })
  for (const s of spans.reverse()) out = `${out.slice(0, s.start)}${s.iso}${out.slice(s.end)}`
  // A weekday the model wrote before a date goes: the device shows its own («Friday, 2026-12-04» read «Friday, Fri, Dec 4»).
  return out.replace(/([(«"“]?)([\p{L}.]+),?\s+(?=\d{4}-\d{2}-\d{2}(?!\d))/gu, (m, open: string, w: string) => (w.length <= 14 && weekdayWord(w.replace(/\.$/, "")) ? open : m))
}

let longDays: string[] | null = null

/** A weekday's name, its forms too («пятницу», «пятница», «Friday», «Fri»): the platform's names, a case ending aside. */
export function weekdayWord(word: string): boolean {
  if (weekdayIn(word)) return true
  const w = clean(word)
  if (w.length < 5 || /\d/.test(w)) return false
  if (!longDays) {
    const set = new Set<string>()
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.UTC(2026, 10, 1 + d, 12))
      for (const loc of LOCALES) set.add(clean(partOf(loc, { weekday: "long" }, day, "weekday")))
    }
    longDays = [...set].filter((n) => n.length >= 5)
  }
  return longDays.some((n) => w.startsWith(n.slice(0, -1)) || n.startsWith(w.slice(0, -1)))
}
