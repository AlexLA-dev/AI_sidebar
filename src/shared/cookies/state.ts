// The cookie closer's state on this device (2.7.1): the switch, the sites it stays off on, how many times its
// confirmation has shown, and today's counts. Counts only: no page address and no site name is counted or sent; the
// sites of «Не закрывать на этом сайте» stay here, like the ✦ button's hidden sites.

export const COOKIE_KEY = "cf:cookies"

// The small confirmation by the ✦ button the first times only; after that it stays quiet.
export const TOLD_TIMES = 3
// At most this many sites in the exception list (the oldest go first).
const MAX_SITES = 200

/** Who answered a banner: a consent platform's rule, the generic closer, or a platform's frame. */
export type CookieVia = string

/** Why a banner was left to the person. */
export type LeftWhy = "only_accept" | "none" | "stuck" | "wall"

export interface CookieState {
  // Off in Settings («Закрывать окна cookie»). On by default, for new and existing users alike.
  off?: boolean
  // «Если отказаться нельзя — принимать» (the owner on 121): a banner with no way to refuse gets its «Accept». Off by
  // default.
  accept?: boolean
  // How many times «Принял cookie: другого выбора не было» showed (its own first few times).
  toldAccept?: number
  // «Не закрывать на этом сайте»: the sites it never answers on (a host without www.).
  sites?: string[]
  // How many times the confirmation showed.
  told?: number
  // The day of the counts (UTC, YYYY-MM-DD) and the counts: answered by each platform (or "generic"), left and why.
  day?: string
  done?: Record<string, number>
  // Banners accepted because there was no way to refuse (by platform), with the switch on.
  accepted?: Record<string, number>
  left?: Partial<Record<LeftWhy, number>>
}

export function readState(raw: unknown): CookieState {
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const counts = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (v && typeof v === "object") for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number" && n > 0) out[k] = Math.floor(n)
    return out
  }
  return {
    ...(r.off === true ? { off: true } : {}),
    ...(r.accept === true ? { accept: true } : {}),
    ...(typeof r.toldAccept === "number" ? { toldAccept: Math.max(0, Math.floor(r.toldAccept)) } : {}),
    ...(r.accepted ? { accepted: counts(r.accepted) } : {}),
    ...(Array.isArray(r.sites) ? { sites: r.sites.filter((s): s is string => typeof s === "string").slice(-MAX_SITES) } : {}),
    ...(typeof r.told === "number" ? { told: Math.max(0, Math.floor(r.told)) } : {}),
    ...(typeof r.day === "string" ? { day: r.day } : {}),
    ...(r.done ? { done: counts(r.done) } : {}),
    ...(r.left ? { left: counts(r.left) as CookieState["left"] } : {})
  }
}

/** A page's site as the exception list keeps it. */
export function siteKey(host: string): string {
  return (host ?? "").toLowerCase().replace(/^www\./, "")
}

/** The closer answers banners on this site: on, and the site not excepted. */
export function closesOn(state: CookieState, host: string): boolean {
  return !state.off && !(state.sites ?? []).includes(siteKey(host))
}

export function withSite(state: CookieState, host: string, closes: boolean): CookieState {
  const site = siteKey(host)
  const rest = (state.sites ?? []).filter((s) => s !== site)
  return { ...state, sites: closes ? rest : [...rest, site].slice(-MAX_SITES) }
}

export function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The counts of a day gone by, to report once (null: nothing to report), and the state with today's counts. */
export interface DayReport {
  day: string
  done: Record<string, number>
  accepted: Record<string, number>
  left: Partial<Record<LeftWhy, number>>
}

export function rollDay(state: CookieState, now: number): { report: DayReport | null; state: CookieState } {
  const day = today(now)
  if (state.day === day) return { report: null, state }
  const had = state.day && (Object.keys(state.done ?? {}).length || Object.keys(state.left ?? {}).length || Object.keys(state.accepted ?? {}).length)
  const { done: _done, left: _left, accepted: _accepted, ...rest } = state
  return {
    report: had ? { day: state.day!, done: state.done ?? {}, accepted: state.accepted ?? {}, left: state.left ?? {} } : null,
    state: { ...rest, day }
  }
}

/** A banner answered (by `via`) or left (and why), counted for today. */
export function counted(state: CookieState, now: number, outcome: { via: CookieVia } | { accepted: CookieVia } | { left: LeftWhy }): CookieState {
  const s = rollDay(state, now).state
  if ("accepted" in outcome) {
    const accepted = { ...(s.accepted ?? {}) }
    accepted[outcome.accepted] = Math.min(9999, (accepted[outcome.accepted] ?? 0) + 1)
    return { ...s, accepted }
  }
  if ("via" in outcome) {
    const done = { ...(s.done ?? {}) }
    done[outcome.via] = Math.min(9999, (done[outcome.via] ?? 0) + 1)
    return { ...s, done }
  }
  const left = { ...(s.left ?? {}) }
  left[outcome.left] = Math.min(9999, (left[outcome.left] ?? 0) + 1)
  return { ...s, left }
}

/** Whether the confirmation shows for this banner (the first few times only), and the state after it. */
export function tell(state: CookieState, accepted = false): { show: boolean; state: CookieState } {
  const told = (accepted ? state.toldAccept : state.told) ?? 0
  if (told >= TOLD_TIMES) return { show: false, state }
  return { show: true, state: accepted ? { ...state, toldAccept: told + 1 } : { ...state, told: told + 1 } }
}
