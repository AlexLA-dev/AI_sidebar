// «Правила поручений» (2.7.1, the owner 2026-11-22: «доделывай нормальную автономизацию»): what the person decided once
// for bookings of any kind (a table, a session with a specialist, a stay, a rental, a class, a ticket), so the agent
// doesn't ask it each time. «Specialist» is whoever gives the service; «place» a venue, a property or a branch; the
// party is people, rooms or tickets as the page counts them. Kept on the device (storage.local), edited in «Мои данные»; the
// model hears them as a line and the plan doesn't ask what they decide. A rule never widens what's allowed: paying,
// cards, codes, signing in, messages and Amazon stay the person's whatever the rules say (classify.ts decides those).

export interface AgentRules {
  // A requested time may move this many minutes either way.
  window: number
  // A full day: up to this many days later.
  days: number
  // People (guests, tickets, seats) when the request doesn't say.
  party: number
  // Any specialist (true), or ask.
  anySpecialist: boolean
  // Only what can be cancelled for free (the page's own terms): never a non-refundable rate (2.7.1, B2).
  freeCancel: boolean
  // The service chosen last time on that site, when known.
  usual: boolean
  // Look at free times in the Calendar before choosing one (when the app may read it).
  calendar: boolean
  // Book without a plan card when every answer is known and nothing is paid.
  auto: boolean
  // A request that names no place: the agent chooses it (rated at least this, with enough reviews).
  chooseVenue: boolean
  rating: number
}

export const DEFAULT_RULES: AgentRules = { window: 60, days: 2, party: 2, anySpecialist: true, freeCancel: false, usual: true, calendar: true, auto: true, chooseVenue: true, rating: 4.5 }

export const RULES_KEY = "agentRules"

/** The rules as stored, with the defaults for what's missing or out of range. */
export function readRules(raw: unknown): AgentRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AgentRules>
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)
  return {
    window: num(r.window, 0, 240, DEFAULT_RULES.window),
    days: num(r.days, 0, 7, DEFAULT_RULES.days),
    party: num(r.party, 1, 20, DEFAULT_RULES.party),
    anySpecialist: bool(r.anySpecialist, DEFAULT_RULES.anySpecialist),
    freeCancel: bool(r.freeCancel, DEFAULT_RULES.freeCancel),
    usual: bool(r.usual, DEFAULT_RULES.usual),
    calendar: bool(r.calendar, DEFAULT_RULES.calendar),
    auto: bool(r.auto, DEFAULT_RULES.auto),
    chooseVenue: bool(r.chooseVenue, DEFAULT_RULES.chooseVenue),
    rating: typeof r.rating === "number" && r.rating >= 3 && r.rating <= 5 ? Math.round(r.rating * 10) / 10 : DEFAULT_RULES.rating
  }
}

/** The line the model reads (English, as the prompt is). */
export function rulesLine(r: AgentRules, calendarFree: boolean): string {
  return [
    `a requested time may move up to ${r.window} minutes either way`,
    r.days ? `if the requested day has no free time, up to ${r.days} day${r.days === 1 ? "" : "s"} later` : "the requested day only",
    `${r.party} ${r.party === 1 ? "person" : "people"} when the request doesn't say how many (guests, tickets, seats — as the page counts them; one room for them)`,
    r.anySpecialist ? "the specialist the plan's answer names — whoever gives the service: a stylist, a doctor, a tutor, a trainer, an instructor, a guide («any» is its first option)" : "ask which specialist (whoever gives the service)",
    r.freeCancel ? "only an option the page says can be cancelled for free (its own cancellation terms); never a non-refundable or prepaid-only rate — when none is free to cancel, ask" : "",
    r.usual ? "the service chosen last time on this site when the answers say it" : "",
    calendarFree ? "only times free in the person's calendar (<calendar>)" : "",
    r.chooseVenue ? `when the request names no place (a venue, a property, a branch, a provider), choose it yourself: what it offers matches the request, rated ${r.rating} or more with at least 20 reviews, open with free slots then, the nearest to where the request or the site says; if its slots don't fit, try the next two before asking` : "when the request names no place, ask which one"
  ].filter(Boolean).join("; ")
}

// Kept around the person's own events: time to get there and back. More when the event has a place (it may be across town).
export const PAD_MIN = 30
export const PAD_PLACE_MIN = 60

/** A time slot's words on a page ("17:45", "5:45 PM", "17.45", "14h30"). */
export const SLOT_TIME = /(^|[^\d])([01]?\d|2[0-3])\s*[:.h]\s*([0-5]\d)(?!\d)|(^|[^\d])(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)/i

/** Whether a control's words look like a time to book (a slot), not a date or a button. */
export function looksLikeSlot(label: string): boolean {
  return label.length <= 40 && SLOT_TIME.test(label)
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** "HH:MM" plus minutes, within the day (clamped to 00:00–23:59). */
export function addMinutes(time: string, minutes: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!m) return time
  const t = Math.min(23 * 60 + 59, Math.max(0, Number(m[1]) * 60 + Number(m[2]) + minutes))
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`
}

/** The day after `date` ("YYYY-MM-DD"), `n` days on. */
export function addDays(date: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// ------------------------------------------------------------ the place's time zone

/** Minutes east of UTC in `tz` at the instant `utcMs`. */
function zoneOffset(tz: string, utcMs: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - utcMs) / 60000)
}

/** The device's own zone. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * A wall-clock date and time in one zone as the same instant in another («19:00 in Paris» is 20:00 in Nicosia). The
 * same when either zone is missing or they're equal.
 */
export function shiftZone(date: string, time: string, from?: string, to?: string): { date: string; time: string } {
  const a = from || deviceZone()
  const b = to || deviceZone()
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (a === b || !d || !t) return { date, time }
  try {
    const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2])
    // The instant whose wall time in `a` is `wall` (one correction for the offset at that instant).
    let utc = wall - zoneOffset(a, wall) * 60000
    utc = wall - zoneOffset(a, utc) * 60000
    const out = new Date(utc + zoneOffset(b, utc) * 60000)
    return { date: `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`, time: `${pad2(out.getUTCHours())}:${pad2(out.getUTCMinutes())}` }
  } catch {
    return { date, time }
  }
}

/** The Calendar's free times («2026-11-24 17:00–19:30; …», in the device's zone) as the place's wall clock. */
export function freeLineIn(line: string, tz?: string): string {
  if (!tz || tz === deviceZone()) return line
  return line.split(";").map((part) => {
    const m = /^\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})–(\d{2}:\d{2})\s*$/.exec(part)
    if (!m) return part.trim()
    const a = shiftZone(m[1], m[2], undefined, tz)
    const b = shiftZone(m[1], m[3], undefined, tz)
    return `${a.date} ${a.time}–${b.time}`
  }).join("; ")
}

// ------------------------------------------------------------ the page's own slots

/** Every time a text names, as HH:MM (24 h): «17:45», «5:45 PM», «17.45», «14h30». */
export function timesIn(text: string): string[] {
  const out: string[] = []
  const re = /(?<![\d:])([01]?\d|2[0-3])\s*[:.h]\s*([0-5]\d)(?!\d)(\s*(am|pm|a\.m\.|p\.m\.))?|(?<![\d:])(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)/gi
  for (const m of text.matchAll(re)) {
    let h = Number(m[1] ?? m[5])
    const min = m[2] ? Number(m[2]) : 0
    const ap = (m[4] ?? m[6] ?? "").toLowerCase()
    if (ap.startsWith("p") && h < 12) h += 12
    if (ap.startsWith("a") && h === 12) h = 0
    out.push(`${pad2(h)}:${pad2(min)}`)
  }
  return out
}

/** The question's choices that name times the page doesn't show (taken from the Calendar alone) are dropped. */
export function pageChoices(choices: string[], pageTimes: Set<string>): string[] {
  return choices.filter((c) => timesIn(c).every((t) => pageTimes.has(t)))
}
