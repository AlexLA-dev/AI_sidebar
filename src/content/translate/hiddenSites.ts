// The sites the translate offer was dismissed on (2.7, build 108, the owner's decision of 18 November): × puts the
// site on the list and the offer no longer comes by itself on its pages; a translation the person starts by hand there
// (the small entry, the panel's «Translate page» chip, the pill opened by holding the circle) takes it off again, so
// the offer comes by itself again; × once more puts it back on. Most recent first, at most KEPT sites.

export const HIDDEN_KEY = "cf:trHidden"
/** How many × of an install were told where the offer went (the line before it folds into the entry). */
export const TOLD_KEY = "cf:trHideTold"
/** The line shows on this many first dismissals of an install; after them, only the fold into the entry. */
export const TOLD_TIMES = 3
export const KEPT = 500

const asList = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [])

export function isHidden(raw: unknown, site: string): boolean {
  return asList(raw).includes(site)
}

/** × on this site: first on the list. */
export function withHidden(raw: unknown, site: string, kept = KEPT): string[] {
  return [site, ...asList(raw).filter((s) => s !== site)].slice(0, kept)
}

/** A translation started by hand on this site: off the list. */
export function withShown(raw: unknown, site: string): string[] {
  return asList(raw).filter((s) => s !== site)
}

/** Whether this × tells where the offer went, from the count kept so far. */
export function tellsAt(raw: unknown): boolean {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0
  return n < TOLD_TIMES
}

export interface SiteStore {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function hiddenOn(store: SiteStore, site: string): Promise<boolean> {
  return isHidden((await store.get(HIDDEN_KEY))[HIDDEN_KEY], site)
}

/** × on this site; true when this × gets the line (one of the install's first TOLD_TIMES). */
export async function hideOn(store: SiteStore, site: string): Promise<boolean> {
  const got = { ...(await store.get(HIDDEN_KEY)), ...(await store.get(TOLD_KEY)) }
  const told = typeof got[TOLD_KEY] === "number" ? (got[TOLD_KEY] as number) : 0
  const tell = tellsAt(told)
  await store.set({ [HIDDEN_KEY]: withHidden(got[HIDDEN_KEY], site), ...(tell ? { [TOLD_KEY]: told + 1 } : {}) })
  return tell
}

/** A translation started by hand came out on this site; true when the site was on the list. */
export async function showOn(store: SiteStore, site: string): Promise<boolean> {
  const raw = (await store.get(HIDDEN_KEY))[HIDDEN_KEY]
  if (!isHidden(raw, site)) return false
  await store.set({ [HIDDEN_KEY]: withShown(raw, site) })
  return true
}
