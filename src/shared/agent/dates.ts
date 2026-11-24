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

function weekdayIn(text: string): boolean {
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
