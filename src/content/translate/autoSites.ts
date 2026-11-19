// Sites translated whole (2.7, build 109, the owner's test of 108: «Если согласился на одной странице сайта —
// спросить переводить ли все страницы этого сайта, чтобы каждый раз не показывать снова и снова поп-ап о переводе»).
// After the first translation on a site comes out, the pill asks once whether to translate every page of it. On yes
// the site goes on this list with the language picked, and its pages are translated as they open, without the offer.
// The pill's site button turns it off again. Kept like the hidden sites (hiddenSites.ts): most recent first, at most
// KEPT. The sites the question was asked on are kept apart, so it's asked once.

export const AUTO_KEY = "cf:trAuto"
export const ASKED_KEY = "cf:trAutoAsked"
/** When the answers ran out on a page translated by itself (a time): the rest of that day such pages are offered, not
 *  started, so the person is told once and not on every page. */
export const LIMIT_KEY = "cf:trAutoLimit"
export const KEPT = 300
export const KEPT_ASKED = 500

/** A site translated whole: its host, the language into, and whether only its buttons and menus are. */
export interface AutoSite {
  s: string
  to: string
  only?: "controls"
}

const asSites = (raw: unknown): AutoSite[] =>
  Array.isArray(raw)
    ? raw.filter((e): e is AutoSite => !!e && typeof e === "object" && typeof (e as AutoSite).s === "string" && typeof (e as AutoSite).to === "string")
    : []
const asList = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [])

export function autoFor(raw: unknown, site: string): AutoSite | null {
  return asSites(raw).find((e) => e.s === site) ?? null
}

export function withAuto(raw: unknown, entry: AutoSite, kept = KEPT): AutoSite[] {
  const clean: AutoSite = { s: entry.s, to: entry.to, ...(entry.only === "controls" ? { only: "controls" as const } : {}) }
  return [clean, ...asSites(raw).filter((e) => e.s !== entry.s)].slice(0, kept)
}

export function withoutAuto(raw: unknown, site: string): AutoSite[] {
  return asSites(raw).filter((e) => e.s !== site)
}

export function wasAsked(raw: unknown, site: string): boolean {
  return asList(raw).includes(site)
}

export function withAsked(raw: unknown, site: string, kept = KEPT_ASKED): string[] {
  return [site, ...asList(raw).filter((s) => s !== site)].slice(0, kept)
}

/** The same day (UTC, as the server counts a day's answers) as the time kept. */
export function limitedToday(raw: unknown, now = Date.now()): boolean {
  return typeof raw === "number" && Number.isFinite(raw) && new Date(raw).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
}

export interface AutoStore {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function autoOn(store: AutoStore, site: string): Promise<AutoSite | null> {
  return autoFor((await store.get(AUTO_KEY))[AUTO_KEY], site)
}

/** Yes to the question (or the language changed on a site translated whole): on the list, first. */
export async function setAuto(store: AutoStore, entry: AutoSite): Promise<void> {
  await store.set({ [AUTO_KEY]: withAuto((await store.get(AUTO_KEY))[AUTO_KEY], entry) })
}

export async function clearAuto(store: AutoStore, site: string): Promise<void> {
  await store.set({ [AUTO_KEY]: withoutAuto((await store.get(AUTO_KEY))[AUTO_KEY], site) })
}

/** Whether the question was asked on this site already; when not, it's marked as asked now. */
export async function askOnce(store: AutoStore, site: string): Promise<boolean> {
  const raw = (await store.get(ASKED_KEY))[ASKED_KEY]
  if (wasAsked(raw, site)) return false
  await store.set({ [ASKED_KEY]: withAsked(raw, site) })
  return true
}
