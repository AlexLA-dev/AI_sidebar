// set_dates (2.8, round 141, design-141 with the director's four additions): the device sets the booking's dates on the
// page itself, instead of the model pressing a calendar one call at a time — a native date field typed; a picker opened,
// its months turned, the day pressed (the stay's second day too), its own «Apply» pressed; a strip's day pressed.
// - Every press is classed on the device as any press is (the runner's `press` does it): only free steps go; the tool
//   stops at the first that isn't.
// - The dates and the window come from the plan only (the request and the person's answers): nothing the page says can
//   call the tool, widen the window or name a day. A day the page names outside it is reported, never set.
// - A window («this week»): the next days are tried while the page shows a day full, at most 7 days and a fixed number of
//   presses; past that it says what it saw and the model decides. The person's Stop is heard between presses.
// - «no date control recognised»: the model presses by hand, under today's day rules.

import { addDays, looksLikeSlot, timesIn } from "./rules.ts"
import { dayItems, dayWords, isDateLabel, monthIn } from "./dates.ts"
import type { MapItem, PageMap } from "./types.ts"

export const MAX_DAYS = 7
export const MAX_PRESSES = 16

export interface DatesAsk {
  // The day to set (YYYY-MM-DD), the stay's or rental's last day (check-out), and the window's last day.
  date: string
  end?: string
  last?: string
  // The times the request allows (HH:MM), for «does this day show a free time».
  from?: string
  until?: string
  // A booking by days (a stay, a rental): no times to look for, the days are what's set.
  byDays: boolean
}

export interface DatesIO {
  map(): Promise<PageMap | null>
  // A press or typing as the device does it: classed first; «not free» means it wasn't done.
  press(item: MapItem): Promise<"done" | "not free" | "failed">
  type(item: MapItem, text: string): Promise<"done" | "not free" | "failed">
  stopped(): Promise<boolean>
}

export interface DatesResult {
  // What the page shows after it, for the log and the model, in one line.
  line: string
  // The day it landed on, when it set one; the request's first day when it didn't move.
  landed?: string
  // The days it found full on the way (for the person's line: «28 Nov: 27 Nov was full»).
  full: string[]
  // No date control recognised: the model presses by hand.
  fallback?: boolean
  presses: number
  stopped?: boolean
}

// A picker's own «Apply», in the panel's languages (never a search or a booking: those are classed, and not free).
const APPLY = /^\s*(apply|done|ok|select dates|confirm dates|save dates|применить|готово|выбрать|застосувати|готово|anwenden|übernehmen|fertig|appliquer|terminé|valider les dates|aplicar|listo|hecho|applica|fatto|conferma date|concluir|pronto|uygula|tamam|適用|完了|決定|적용|완료|확인|应用|完成|确定|套用|確定|تطبيق|تم|áp dụng|xong|chọn)\s*$/iu
// A picker's «next month» (its words, or what the page's code calls a wordless arrow).
const NEXT = /(next month|next|›|»|→|>|следующ|далее|наступн|nächst|weiter|suivant|siguiente|successiv|próximo|seguinte|sonraki|次の月|次へ|다음|下个月|下一|下月|التالي|tiếp|chevron-?right|arrow-?right)/iu
// A control that opens the dates: its words name the dates or the check-in.
const OPENS = /(date|dates|check-?in|check-?out|arrival|when|calendar|fecha|llegada|entrada|date d|arrivée|datum|anreise|data|arrivo|chegada|дата|даты|заезд|когда|календар|tarih|giriş|日付|チェックイン|日程|날짜|체크인|日期|入住|التاريخ|الوصول|ngày|nhận phòng)/iu
// A page saying the day is full or has nothing free, in the panel's languages.
const FULL = /(fully booked|sold out|no availability|not available|no (free |available )?(times|slots|tables|rooms)|agotad|completo|no disponible|complet|indisponible|ausgebucht|nicht verfügbar|esaurit|non disponibil|esgotad|indisponível|нет мест|занято|нет свободн|нет доступн|dolu|müsait değil|満席|空きなし|予約不可|마감|예약 불가|만실|已满|无空|已售罄|額滿|محجوز|لا يوجد|hết chỗ|kín chỗ)/iu

const CHOICE_ROLES = new Set(["button", "option", "link", "radio", "checkbox", "tab", "other"])
const greyed = (i: MapItem) => !!i.state?.some((s) => s === "unavailable" || s === "disabled")
const chosen = (i: MapItem) => !!i.state?.some((s) => s === "selected" || s === "checked" || s === "pressed" || s === "current")
const short = (iso: string) => dayWords(iso).replace(/^\w+,\s*/, "").replace(/\s\d{4}$/, "")

/** The day's own control on the page now (a choice, not greyed first), or null. */
function dayControl(map: PageMap, iso: string): MapItem | null {
  const items = dayItems(map, iso).filter((i) => CHOICE_ROLES.has(i.role) && !i.lock)
  return items.find((i) => !greyed(i)) ?? items[0] ?? null
}

/** The month the page's picker shows first (0–11), or -1. */
function monthShown(map: PageMap): number {
  for (const t of [...map.text.split("\n"), ...map.items.map((i) => i.label)]) {
    if (t.length > 40 || !/(19|20)\d{2}/.test(t)) continue
    const m = monthIn(t)
    if (m >= 0) return m
  }
  return -1
}

const LIST_ROLES = new Set(["select", "listbox", "combobox"])

/** The times the page offers now: its time controls, and a time list's options (a form's «Time» select). */
function timesShown(map: PageMap): string[] {
  const own = map.items.filter((i) => !greyed(i) && looksLikeSlot(i.label)).flatMap((i) => timesIn(i.label))
  const listed = map.items.filter((i) => LIST_ROLES.has(i.role) && !greyed(i)).flatMap((i) => (i.options ?? []).filter(looksLikeSlot).flatMap(timesIn))
  return [...new Set([...own, ...listed])]
}

/** Whether the page shows a free time inside the request's window for the day it has chosen. */
function freeTimes(map: PageMap, ask: DatesAsk): string[] {
  return timesShown(map).filter((t) => (!ask.from || t >= ask.from) && (!ask.until || t <= ask.until)).sort()
}

/** Sets one day (and the stay's end) on the page: «set», «greyed», «no control», «stopped» or «not free». */
async function setOne(io: DatesIO, day: string, end: string | undefined, budget: { presses: number; endSet?: boolean }): Promise<"set" | "greyed" | "no control" | "stopped" | "not free"> {
  const tried = new Set<string>()
  let picked = false
  for (let k = 0; k < 8 && budget.presses < MAX_PRESSES; k++) {
    if (await io.stopped()) return "stopped"
    const map = await io.map()
    if (!map) return "no control"
    // A native date field: typed (and the second one for the end).
    const fields = map.items.filter((i) => i.type === "date" && !i.lock)
    if (fields.length && !picked) {
      budget.presses++
      const r = await io.type(fields[0], day)
      if (r !== "done") return r === "not free" ? "not free" : "no control"
      if (end && fields[1]) {
        budget.presses++
        if ((await io.type(fields[1], end)) === "done") budget.endSet = true
      }
      return "set"
    }
    const it = picked ? null : dayControl(map, day)
    if (it) {
      if (greyed(it) && tried.has(`grey:${it.id}`)) return "greyed"
      tried.add(`grey:${it.id}`)
      budget.presses++
      const r = await io.press(it)
      if (r === "not free") return "not free"
      if (greyed(it)) return "greyed"
      picked = true
      if (end) {
        const after = await io.map()
        const e = after ? dayControl(after, end) : null
        if (e && !greyed(e)) {
          budget.presses++
          const pe = await io.press(e)
          if (pe === "not free") return "not free"
          if (pe === "done") budget.endSet = true
        }
      }
      // The picker's own «Apply» when it has one.
      const now = await io.map()
      const apply = now?.items.find((i) => (i.role === "button" || i.role === "link" || i.role === "other") && APPLY.test(i.label) && !greyed(i))
      if (apply) {
        budget.presses++
        if ((await io.press(apply)) === "not free") return "not free"
      }
      return "set"
    }
    if (picked) return "set"
    // The day isn't there: a later month's arrow when the picker shows an earlier month, else what opens the dates.
    const shown = monthShown(map)
    const want = Number(day.slice(5, 7)) - 1
    const next = map.items.find((i) => (i.role === "button" || i.role === "link" || i.role === "other") && !greyed(i) && !tried.has(i.id) && i.label.length <= 30 && (NEXT.test(i.label) || (!i.label && NEXT.test(i.hint ?? ""))))
    if (shown >= 0 && next && (shown < want || (shown === 11 && want === 0))) {
      tried.add(next.id)
      budget.presses++
      if ((await io.press(next)) === "not free") return "not free"
      continue
    }
    const opener = map.items.find((i) => !tried.has(i.id) && !i.lock && (i.role === "button" || i.role === "combobox" || i.role === "textbox" || i.role === "link" || i.role === "other") && i.label.length <= 60 && (OPENS.test(i.label) || isDateLabel(i.label)) && !looksLikeSlot(i.label))
    if (opener) {
      tried.add(opener.id)
      budget.presses++
      if ((await io.press(opener)) === "not free") return "not free"
      continue
    }
    return "no control"
  }
  return picked ? "set" : "no control"
}

/** The tool: sets the request's day (or goes through its window) and says what the page shows. */
export async function setDates(ask: DatesAsk, io: DatesIO): Promise<DatesResult> {
  const budget: { presses: number; endSet?: boolean } = { presses: 0 }
  const full: string[] = []
  const last = ask.last && ask.last > ask.date ? ask.last : ask.date
  const nights = ask.end ? Math.max(1, Math.round((Date.parse(ask.end) - Date.parse(ask.date)) / 86_400_000)) : 0
  let day = ask.date
  for (let n = 0; n < MAX_DAYS && day <= last; n++, day = addDays(day, 1)) {
    const end = ask.end ? addDays(day, nights) : undefined
    const r = await setOne(io, day, end, budget)
    if (r === "stopped") return { line: "stopped by the person", full, presses: budget.presses, stopped: true }
    if (r === "no control") {
      if (n === 0) return { line: "no date control recognised: set the day by pressing the page's own controls", full, presses: budget.presses, fallback: true }
      break
    }
    if (r === "not free") return { line: `stopped before a press that isn't a free step (the dates aren't set for ${short(day)}): go on by hand`, full, presses: budget.presses }
    const map = await io.map()
    const text = map ? `${map.text}\n${map.items.map((i) => i.label).join("\n")}` : ""
    const dayItem = map ? dayControl(map, day) : null
    const shows = map ? (dayItem && chosen(dayItem)) || map.items.some((i) => (i.value ?? "").includes(day)) : false
    // A stay: the days are what's set; whether rooms are free is the page's next answer (its own Search or the list).
    if (ask.byDays) {
      if (r === "greyed") {
        full.push(day)
        if (day < last && budget.presses < MAX_PRESSES) continue
        break
      }
      // Half a stay set says so in plain words, and what's missing (round 141: «27 Nov set» read as the whole stay).
      const half = !end
        ? `only the first day, ${short(day)}, is set: the request doesn't say how many nights, so the last day isn't set — press the stay's last day on the page yourself (it's allowed)`
        : !budget.endSet
          ? `only the first day, ${short(day)}, is set: the last day, ${short(end)}, couldn't be pressed here — press ${short(end)} on the page yourself (it's allowed), then its «Apply» or Search`
          : ""
      return { line: `${half || `${short(day)} – ${short(end!)} set`}${shows || half ? "" : " (the page doesn't show them chosen yet: read it, or press its Search)"}${full.length ? `; ${full.map(short).join(", ")} couldn't be chosen` : ""}`, landed: day, full, presses: budget.presses }
    }
    const times = map ? freeTimes(map, ask) : []
    if (r !== "greyed" && times.length) return { line: `${short(day)} shows ${times.slice(0, 6).join(", ")}${full.length ? ` (${full.map(short).join(", ")} full)` : ""}`, landed: day, full, presses: budget.presses }
    // No times on the page at all, and nothing saying the day is full: the day is set, and its times are the page's next
    // step (a form whose times come later, or a list it hasn't drawn yet). Never read as full (the stand's form with a
    // «Time» list read as three full days, round 141).
    if (r !== "greyed" && map && !timesShown(map).length && !FULL.test(text)) return { line: `${short(day)} set; the page shows no times for it yet (read it, or go on to its times)${full.length ? ` (${full.map(short).join(", ")} full)` : ""}`, landed: day, full, presses: budget.presses }
    // A full day: the next one in the window, else what was seen.
    if (r === "greyed" || FULL.test(text) || !times.length) full.push(day)
    if (day >= last || budget.presses >= MAX_PRESSES) break
  }
  const seen = full.length ? `${full.map(short).join(", ")}: no free time inside the request's window` : "the dates couldn't be set"
  const further = day <= last && full.length >= MAX_DAYS ? "; not looked further" : budget.presses >= MAX_PRESSES ? "; not looked further (too many presses)" : ""
  return { line: `${seen}${further}`, full, presses: budget.presses }
}
