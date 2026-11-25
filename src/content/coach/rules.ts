// The hint coordinator (2.8, growth plan section 4 «Правила умных подсказок», list row В3.1). Every prompt the panel or
// the page shows unasked goes through it: the prompt says it fits here, the coordinator says whether now. One at a
// time per tab (page, panel and fields share the one slot); once a hint shows in a session nothing else shows in it
// until that one is closed or used; each hint shows at most twice, is gone after two ✕ and never comes back once
// taken; the first day only says what leads to the next rung of the ladder; one capability a day after that.
// Pure, for tests (tests/coach.test.mts). The state it reads is the device's own (state.ts), never sent.

/** The ladder's rungs the panel can see (the numbers of events-2.8.md §2): ✦ seen, the panel opened, the consent,
 *  the first answer, back on another day and asked again, the free answers' limit once (or a paid plan). */
export type Rung = 7 | 8 | 10 | 11 | 12 | 13

export const HINT_IDS = [
  "fab_pulse", "sel_ask", "agent_offer", "translate_pill", "cookie_line", "sel_icons", "write_tip", "note_tip",
  "organize_consent", "organize_mess", "organize_tags", "byok_offer", "renewal", "pro_offer", "media_tip", "chats_tip",
  "side", "whatsnew", "invite",
  "page_similar", "page_watch", "page_summary", "page_listen", "page_video", "page_templates", "page_remind", "page_calendar"
] as const
export type CoachHint = (typeof HINT_IDS)[number]

/**
 * - "hint": the ordinary kind: a budget of shows, retired after two ✕ or once taken, one per session.
 * - "answer": belongs to an answer the person asked for («Сделать на этой странице?» under an action question): any
 *   day, no session or show budget, still one at a time.
 * - "notice": says what ContextFlow just did (the cookie window closed): one at a time, nothing else.
 */
export type HintKind = "hint" | "answer" | "notice"

export interface HintSpec {
  // Higher wins when several fit at once.
  prio: number
  // The earliest rung and day (day 1: the device's first day with ContextFlow).
  rung: Rung
  day: number
  kind: HintKind
  // A capability (one a day, growth plan stage 5).
  cap?: true
  // Shows until taken, not counted (the ✦ pulse until the panel's first open).
  untilDone?: true
}

const hint = (prio: number, rung: Rung, day: number, extra: Partial<HintSpec> = {}): HintSpec => ({ prio, rung, day, kind: "hint", ...extra })

export const HINTS: Record<CoachHint, HintSpec> = {
  // Day 1: what leads to the next rung.
  fab_pulse: hint(100, 7, 1, { untilDone: true }),
  sel_ask: hint(80, 11, 1),
  agent_offer: { prio: 75, rung: 8, day: 1, kind: "answer" },
  // Day 2 on: one capability a day, where the page fits.
  translate_pill: hint(60, 11, 2, { cap: true }),
  page_similar: hint(60, 11, 2, { cap: true }),
  page_watch: hint(60, 11, 2, { cap: true }),
  page_summary: hint(60, 11, 2, { cap: true }),
  page_listen: hint(60, 11, 2, { cap: true }),
  page_video: hint(60, 11, 2, { cap: true }),
  page_templates: hint(60, 11, 2, { cap: true }),
  page_remind: hint(60, 11, 2, { cap: true }),
  page_calendar: hint(60, 11, 2, { cap: true }),
  write_tip: hint(55, 11, 2, { cap: true }),
  // How-tos once the first answer is in.
  note_tip: hint(50, 11, 1),
  media_tip: hint(50, 11, 2),
  chats_tip: hint(50, 11, 2),
  side: hint(45, 11, 2),
  sel_icons: hint(45, 11, 2),
  // Not before the second day (В3.3): organizing, invite, «New in…», the paid offers.
  organize_consent: hint(40, 11, 2),
  organize_mess: hint(40, 11, 2),
  organize_tags: hint(40, 11, 2),
  invite: hint(30, 11, 2),
  pro_offer: hint(30, 11, 2),
  byok_offer: hint(30, 11, 2),
  renewal: hint(30, 11, 2),
  whatsnew: hint(20, 11, 2),
  cookie_line: { prio: 10, rung: 11, day: 1, kind: "notice" }
}

/** Where the state is kept on the device (state.ts). */
export const COACH_KEY = "cf:coach"

/** At most this many shows of a hint, and two ✕ retire it. */
export const MAX_SHOWS = 2
export const MAX_DISMISSES = 2
/** A session ends after this long without a step (as usage.ts's sid). */
export const SESSION_GAP_MS = 30 * 60_000

export interface HintCount {
  shown: number
  dismissed: number
  // Taken (its action used): never again.
  done: boolean
}

export interface CoachState {
  v: 1
  // The first time ContextFlow ran on a page on this device (ms): day 1.
  first: number
  panelOpens: number
  answers: number
  // Device days with an answer, the last few ("2026-11-24").
  askDays: string[]
  // Asked in their own words at least once.
  own: boolean
  // The free answers ran out once (ms; 0: never).
  limitAt: number
  hints: Partial<Record<CoachHint, HintCount>>
  // This session: when it started, its last step, the hint shown in it and whether that one is settled (✕ or taken).
  session: { start: number; last: number; shown: CoachHint | null; settled: boolean }
  // The day a capability hint was shown, and which.
  capDay: string
  capId: CoachHint | null
  // Read once from what 2.7 keeps (seed.ts).
  seeded: boolean
}

export const freshCoach = (now: number): CoachState => ({
  v: 1, first: now, panelOpens: 0, answers: 0, askDays: [], own: false, limitAt: 0, hints: {},
  session: { start: now, last: now, shown: null, settled: true }, capDay: "", capId: null, seeded: false
})

/** The device's own day ("2026-11-24"), by the person's clock. */
export const dayKey = (now: number): string => {
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** Which day of ContextFlow this is on the device: 1 on the first, counted in the person's calendar days. */
export function dayNumber(first: number, now: number): number {
  const a = new Date(first)
  const b = new Date(now)
  const start = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const end = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1)
}

/** The highest rung reached. `paid`: a plan above Free (it counts as past the limit: nothing leads there). */
export function rungOf(s: Pick<CoachState, "panelOpens" | "answers" | "askDays" | "limitAt">, consent: boolean, paid: boolean): Rung {
  if (s.limitAt > 0 || paid) return 13
  if (s.askDays.length >= 2) return 12
  if (s.answers > 0) return 11
  if (consent) return 10
  if (s.panelOpens > 0) return 8
  return 7
}

/** A step of use: the session goes on, or a new one starts after a gap. */
export function touch(s: CoachState, now: number): CoachState {
  if (now - s.session.last > SESSION_GAP_MS) return { ...s, session: { start: now, last: now, shown: null, settled: true } }
  return { ...s, session: { ...s.session, last: now } }
}

const count = (s: CoachState, id: CoachHint): HintCount => s.hints[id] ?? { shown: 0, dismissed: 0, done: false }

/** Retired for good: taken, or closed twice. */
export function retired(s: CoachState, id: CoachHint): boolean {
  const c = count(s, id)
  return c.done || c.dismissed >= MAX_DISMISSES
}

export interface Moment {
  now: number
  rung: Rung
  // Something the person is in the middle of holds every hint: the consent card, the first-open guide or questions,
  // the plans at the limit, an agent task of theirs.
  flow: boolean
  // The hint up now (it stays while it still fits: no flipping between two).
  current: CoachHint | null
  // Hints already counted as shown on this page view (showing on doesn't count again).
  here: ReadonlySet<CoachHint>
}

/** Whether a hint may show now, by its gates and budgets (not whether another is up). */
export function allowed(s: CoachState, id: CoachHint, m: Moment): boolean {
  const spec = HINTS[id]
  if (m.rung < spec.rung || dayNumber(s.first, m.now) < spec.day) return false
  if (spec.kind !== "hint") return true
  const c = count(s, id)
  if (c.done || c.dismissed >= MAX_DISMISSES) return false
  if (spec.untilDone) return true
  if (c.shown >= MAX_SHOWS && !m.here.has(id)) return false
  // One new thing a session: once a hint has shown in it, only that one may come back in it (on another page, within
  // its budget, if it wasn't closed); closed or taken, the session stays quiet.
  const live = m.now - s.session.last <= SESSION_GAP_MS
  if (live && s.session.shown && s.session.shown !== id && sessionUsed(s)) return false
  if (live && s.session.shown === id && s.session.settled) return false
  // One capability a day.
  if (spec.cap && s.capDay === dayKey(m.now) && s.capId !== id) return false
  return true
}

/** A session that already had its one new thing. */
const sessionUsed = (s: CoachState): boolean => s.session.shown !== null && HINTS[s.session.shown].kind === "hint" && !HINTS[s.session.shown].untilDone

/** The one hint to show now among those that fit, or null. */
export function choose(s: CoachState, wanting: Iterable<CoachHint>, m: Moment): CoachHint | null {
  if (m.flow) return null
  const fit = [...new Set(wanting)].filter((id) => allowed(s, id, m))
  // An answer's own offer comes with the answer the person asked for: it goes before a hint already up.
  const answer = fit.filter((id) => HINTS[id].kind === "answer").sort((a, b) => HINTS[b].prio - HINTS[a].prio)[0]
  if (answer) return answer
  if (m.current && fit.includes(m.current)) return m.current
  if (!fit.length) return null
  const order = (id: CoachHint) => HINT_IDS.indexOf(id)
  fit.sort((a, b) => HINTS[b].prio - HINTS[a].prio || Number(count(s, a).shown > 0) - Number(count(s, b).shown > 0) || order(a) - order(b))
  return fit[0]
}

// ---------------------------------------------------------------- what happened to a hint

export function afterShown(s: CoachState, id: CoachHint, now: number): CoachState {
  const spec = HINTS[id]
  const c = count(s, id)
  const next = touch(s, now)
  if (spec.kind !== "hint") return next
  return {
    ...next,
    hints: { ...next.hints, [id]: { ...c, shown: spec.untilDone ? c.shown : c.shown + 1 } },
    session: spec.untilDone ? next.session : { ...next.session, shown: id, settled: false },
    ...(spec.cap ? { capDay: dayKey(now), capId: id } : {})
  }
}

export function afterDismissed(s: CoachState, id: CoachHint, now: number): CoachState {
  const c = count(s, id)
  const next = touch(s, now)
  return {
    ...next,
    hints: { ...next.hints, [id]: { ...c, dismissed: c.dismissed + 1 } },
    session: next.session.shown === id ? { ...next.session, settled: true } : next.session
  }
}

export function afterDone(s: CoachState, id: CoachHint, now: number): CoachState {
  const c = count(s, id)
  const next = touch(s, now)
  // An answer's offer isn't retired by being taken (it's the way to the agent each time a question asks for it).
  if (HINTS[id].kind === "answer") return next
  return {
    ...next,
    hints: { ...next.hints, [id]: { ...c, done: true } },
    session: next.session.shown === id ? { ...next.session, settled: true } : next.session
  }
}

// ---------------------------------------------------------------- the facts behind the rungs

export const afterPanelOpen = (s: CoachState, now: number): CoachState => ({ ...touch(s, now), panelOpens: s.panelOpens + 1 })

export function afterAnswer(s: CoachState, now: number, own: boolean): CoachState {
  const day = dayKey(now)
  const askDays = s.askDays.includes(day) ? s.askDays : [...s.askDays, day].slice(-8)
  return { ...touch(s, now), answers: s.answers + 1, askDays, own: s.own || own }
}

export const afterLimit = (s: CoachState, now: number): CoachState => (s.limitAt ? s : { ...s, limitAt: now })
