// Calendar and Reminders (2.7, plan section 3). Shared by the server (/api/v2/item), the panel and tests; the app
// has the same date rules in AppleItems.swift.
// - «Также в Напоминания»: the Remind window's reminder goes into Apple Reminders as well (no AI, no server).
// - The AI suggests an event or a reminder, from an answer or a request in the chat: a card shows what and when, and
//   nothing is written until the person taps Add. The device writes it (EventKit); the server only reads the date and
//   time out of the text, in the device's own time and zone, and keeps nothing.
// Free for everyone; not offered on iOS 16 and macOS 13 (the native side says whether it's available).

/** One suggestion: a reminder (a task, a deadline) or an event (a flight, a meeting, a booking). */
export interface AppleItem {
  kind: "reminder" | "event"
  title: string
  notes?: string
  // The device's own wall-clock date and time ("2026-03-14", "10:40"), never UTC. A reminder may have no date at all;
  // no time: a reminder for the whole day, an all-day event.
  date?: string
  time?: string
  endDate?: string
  endTime?: string
  // A zone the text names that isn't the device's ("15:00 PT": "America/Los_Angeles"); the date and time are in it.
  tz?: string
  location?: string
  // "guess": the text didn't say it plainly (a time picked for "Friday", a year assumed); the card marks it.
  confidence: "sure" | "guess"
}

/** What a reminder or event links back to: the page it came from and the chat message (added by the device). */
export interface AppleLinks {
  url?: string
  chat?: string
}

export const MAX_ITEMS = 5
export const MAX_ITEM_TITLE = 120
export const MAX_ITEM_NOTES = 500
export const MAX_ITEM_LOCATION = 200

// ---------------------------------------------------------------- the chat's marker

/**
 * The chat's answer ends with this line when the person asked for a reminder or an event, or when the answer gives a
 * date they'll want to keep (prompt.ts ITEM_RULE). The panel hides it, keeps `addable` on the answer and asks
 * /api/v2/item for the card. Only clients that say they can add items (`items: true`) get the rule.
 */
export const ITEM_MARKER = "[[cf:add]]"

/** The answer as shown and kept: the marker gone, and while it streams, the start of one at the end too. */
export function withoutItemMarker(text: string): { text: string; marked: boolean } {
  let out = text
  const marked = out.includes(ITEM_MARKER)
  if (marked) out = out.split(ITEM_MARKER).join("")
  for (let k = Math.min(ITEM_MARKER.length - 1, out.length); k >= 2; k--) {
    if (out.endsWith(ITEM_MARKER.slice(0, k))) {
      out = out.slice(0, -k)
      break
    }
  }
  return { text: marked ? out.replace(/\s+$/, "") : out, marked }
}

// ---------------------------------------------------------------- dates

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{2}):(\d{2})$/

/** A real calendar date "YYYY-MM-DD" (not 2026-02-30). */
export function validDate(s: unknown): s is string {
  const m = typeof s === "string" ? DATE.exec(s) : null
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

export function validTime(s: unknown): s is string {
  const m = typeof s === "string" ? TIME.exec(s) : null
  return Boolean(m && Number(m[1]) < 24 && Number(m[2]) < 60)
}

/** An IANA zone this engine knows ("Europe/Berlin"); "UTC" too. */
export function validZone(s: unknown): s is string {
  if (typeof s !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(s)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s })
    return true
  } catch {
    return false
  }
}

/** How far `tz` is ahead of UTC at the moment `at` (ms). */
function zoneOffset(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(at))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000
}

/**
 * The moment (ms) a wall-clock date and time stand for: in `tz` when given, else in the device's zone. No time: the
 * day's start. A time that doesn't exist that day (the clocks go forward) comes out an hour later, as the system does.
 */
export function wallMoment(date: string, time?: string, tz?: string): number {
  const [y, mo, d] = date.split("-").map(Number)
  const [h, mi] = time ? time.split(":").map(Number) : [0, 0]
  if (!tz) return new Date(y, mo - 1, d, h, mi).getTime()
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess - zoneOffset(guess, tz)
  const second = guess - zoneOffset(first, tz)
  const shows = (at: number) => at + zoneOffset(at, tz) === guess
  if (shows(second)) return second
  if (shows(first)) return first
  // In the hour the clocks skip: the later one.
  return Math.max(first, second)
}

/** When an item starts (ms), or null for a reminder with no date. */
export function itemMoment(item: Pick<AppleItem, "date" | "time" | "tz">): number | null {
  return item.date && validDate(item.date) ? wallMoment(item.date, validTime(item.time) ? item.time : undefined, item.tz) : null
}

/** An item whose time has passed (a day without a time: once that day is over). */
export function itemPast(item: Pick<AppleItem, "date" | "time" | "tz">, now = Date.now()): boolean {
  const at = itemMoment(item)
  if (at === null) return false
  return item.time ? at < now : at + 86_400_000 <= now
}

/** The device's date and time for the server: "2026-11-14T13:05", the weekday, the zone, the offset in minutes. */
export function deviceNow(now = new Date()): { now: string; weekday: string; tz: string; offset: number } {
  const pad = (n: number) => String(n).padStart(2, "0")
  let tz = "UTC"
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    tz = "UTC"
  }
  return {
    now: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()],
    tz,
    offset: -now.getTimezoneOffset()
  }
}

/** The date and time a reminder at `at` (ms) has on this device, for «Также в Напоминания». */
export function wallOf(at: number): { date: string; time: string } {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

// ---------------------------------------------------------------- what the server's model gave back

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "")

/**
 * The model's suggestions as the device can trust them: known kinds, real dates and times, a known zone, short
 * texts, at most MAX_ITEMS. An event needs a date; an end before its start is dropped; a time without a date goes.
 */
export function checkItems(data: unknown, kind?: AppleItem["kind"]): AppleItem[] {
  const list = (data as { items?: unknown } | null)?.items
  if (!Array.isArray(list)) return []
  const out: AppleItem[] = []
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>
    const k = kind ?? (r.kind === "event" ? "event" : r.kind === "reminder" ? "reminder" : null)
    const title = clean(r.title, MAX_ITEM_TITLE)
    if (!k || !title) continue
    const item: AppleItem = { kind: k, title, confidence: r.confidence === "sure" ? "sure" : "guess" }
    const notes = typeof r.notes === "string" ? r.notes.trim().slice(0, MAX_ITEM_NOTES) : ""
    if (notes) item.notes = notes
    const location = clean(r.location, MAX_ITEM_LOCATION)
    if (location) item.location = location
    if (validDate(r.date)) {
      item.date = r.date
      if (validTime(r.time)) item.time = r.time
      if (validZone(r.tz) && item.time) item.tz = r.tz
      if (k === "event" && validDate(r.end_date ?? r.endDate)) item.endDate = (r.end_date ?? r.endDate) as string
      if (k === "event" && validTime(r.end_time ?? r.endTime) && item.time) item.endTime = (r.end_time ?? r.endTime) as string
      if (item.endTime && !item.endDate) item.endDate = item.date
      const start = itemMoment(item)
      const end = item.endDate ? wallMoment(item.endDate, item.endTime, item.tz) : null
      if (end !== null && start !== null && end < start) {
        delete item.endDate
        delete item.endTime
      }
    } else if (k === "event") {
      continue
    }
    out.push(item)
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/** The text a reminder or event keeps besides its title: the item's notes, then where it came from. */
export function itemNotes(notes: string | undefined, links: AppleLinks, pageTitle?: string): string {
  const lines = [notes?.trim() ?? ""]
  if (links.url) lines.push(pageTitle && pageTitle !== links.url ? `${pageTitle}\n${links.url}` : links.url)
  if (links.chat) lines.push(links.chat)
  return lines.filter(Boolean).join("\n\n").slice(0, 2_000)
}
