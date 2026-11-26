// The panel's openings kept on the device until their `panel.close` is sent (2.8.1, events-2.8 §2). A page that goes
// away with the panel open often can't send it, so the opening is kept and its close goes from a later page.
//
// F2/F3 (the director's review): one opening, one close, and only the time it was seen.
// - Each opening has its own key (`cf:opening:<id>`) and an index of ids (`cf:openings`), so two tabs writing different
//   openings never undo each other's write.
// - A close is sent once: the page that sends it leaves a tombstone (`closed`) that no later write turns back into a
//   live opening (the tab that had it, waking up or restored by Back/Forward, sees the tombstone and says nothing more).
// - Pages closing what others left claim the record first and send only if their claim is still there a moment later
//   (two tabs flushing one record: one close).
// - The time counted (`seen`) is the time the panel was on screen: a tab put away and woken days later adds nothing, and
//   a panel not seen for SAME_OPENING_MS is an opening that ended at its last sight.

/** What one opening of the panel came to (events-2.8 §2, `panel.close` did). */
export type PanelDid = "none" | "chip" | "ask" | "tour" | "settings" | "other"

export interface OpeningRecord {
  at: number
  // Last seen on screen (ms).
  last: number
  // How long it was on screen up to `last` (ms).
  seen: number
  did: PanelDid
  // The page went away for good (pagehide not kept for Back/Forward): any page may close it now.
  gone?: 1
  // A page closing it (its token, when).
  claim?: string
  claimAt?: number
  // Its close was sent (ms): never written again.
  closed?: number
}

export const INDEX_KEY = "cf:openings"
export const recordKey = (id: string): string => `cf:opening:${id}`
/** An opening not seen for this long has ended (its close goes with the time seen up to then). */
export const SAME_OPENING_MS = 30 * 60_000
/** How long a claim waits before it is checked. */
export const CLAIM_WAIT_MS = 400
/** A claim older than this was left by a page that went away mid-claim: claimed again. */
const CLAIM_FRESH_MS = 10_000
/** Tombstones are kept this long, then forgotten. */
const TOMBSTONE_MS = 24 * 3_600_000

export interface OpeningStore {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
}

// The extension's storage, read where it is (the tests have no extension types).
type LocalArea = { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> }
const local = (): LocalArea => (globalThis as unknown as { chrome: { storage: { local: LocalArea } } }).chrome.storage.local

export const chromeOpenings: OpeningStore = {
  get: (keys) => local().get(keys),
  set: (items) => local().set(items),
  remove: (keys) => local().remove(keys)
}

type Wait = (ms: number) => Promise<void>
const pause: Wait = (ms) => new Promise((done) => setTimeout(done, ms))

const valid = (v: unknown): v is OpeningRecord => !!v && typeof v === "object" && typeof (v as OpeningRecord).at === "number"
const claimedByOther = (r: OpeningRecord, token: string, now: number) => !!r.claim && r.claim !== token && now - (r.claimAt ?? 0) < CLAIM_FRESH_MS

/** The seconds a close reports for a record. */
export const openSeconds = (r: OpeningRecord): number => Math.min(9999, Math.max(0, Math.round((typeof r.seen === "number" ? r.seen : r.last - r.at) / 1000)))

// This tab's reads and writes, one after another.
let lane: Promise<unknown> = Promise.resolve()
function inTurn<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run)
  lane = next.catch(() => undefined)
  return next
}

async function readRecord(store: OpeningStore, id: string): Promise<OpeningRecord | null> {
  const v = (await store.get([recordKey(id)]))[recordKey(id)]
  return valid(v) ? v : null
}

/**
 * Claims `records` (ids of this store) for this page, waits, and closes those whose claim held and which nobody wrote
 * since: their tombstones are written, and they're returned (the caller sends their closes).
 */
async function claimAndClose(store: OpeningStore, records: Array<[string, OpeningRecord]>, token: string, now: () => number, wait: Wait): Promise<OpeningRecord[]> {
  if (!records.length) return []
  const at = now()
  await store.set(Object.fromEntries(records.map(([id, r]) => [recordKey(id), { ...r, claim: token, claimAt: at }])))
  await wait(CLAIM_WAIT_MS)
  const after = await store.get(records.map(([id]) => recordKey(id)))
  const won = records.filter(([id, r]) => {
    const v = after[recordKey(id)]
    return valid(v) && v.claim === token && !v.closed && v.last === r.last
  })
  if (won.length) await store.set(Object.fromEntries(won.map(([id, r]) => [recordKey(id), { at: r.at, last: r.last, seen: r.seen, did: r.did, closed: now() }])))
  return won.map(([, r]) => r)
}

export type Kept = { state: "kept" } | { state: "closed" } | { state: "ended"; record: OpeningRecord }

/**
 * The tab that has the opening says it's still there (`rec`: up to now). "closed": its close was sent (or is being sent)
 * elsewhere, nothing more is said for it; "ended": it wasn't seen for SAME_OPENING_MS, so this tab closed it at its last
 * sight (`record`: send its close); "kept": written.
 */
export function keepOpening(id: string, rec: Omit<OpeningRecord, "claim" | "claimAt" | "closed">, token: string, store: OpeningStore = chromeOpenings, now: () => number = Date.now, wait: Wait = pause): Promise<Kept> {
  return inTurn(async (): Promise<Kept> => {
    const cur = await readRecord(store, id)
    if (cur?.closed || (cur && claimedByOther(cur, token, now()))) return { state: "closed" }
    if (cur && rec.last - cur.last > SAME_OPENING_MS) {
      const [won] = await claimAndClose(store, [[id, cur]], token, now, wait)
      return won ? { state: "ended", record: won } : { state: "closed" }
    }
    await store.set({ [recordKey(id)]: rec })
    if (!cur) {
      const index = (await store.get([INDEX_KEY]))[INDEX_KEY]
      const ids = index && typeof index === "object" ? (index as Record<string, unknown>) : {}
      if (typeof ids[id] !== "number") await store.set({ [INDEX_KEY]: { ...ids, [id]: rec.at } })
    }
    return { state: "kept" }
  })
}

/** The tab that has the opening closes it: true when this tab is the one to send its close (once). */
export function endOpening(id: string, rec: Omit<OpeningRecord, "claim" | "claimAt" | "closed">, token: string, store: OpeningStore = chromeOpenings, now: () => number = Date.now): Promise<boolean> {
  return inTurn(async () => {
    const cur = await readRecord(store, id)
    if (cur?.closed || (cur && claimedByOther(cur, token, now()))) return false
    await store.set({ [recordKey(id)]: { ...rec, closed: now() } })
    return true
  })
}

/**
 * Openings other pages left: gone for good, or not seen for SAME_OPENING_MS. Those this page closes are returned (the
 * caller sends their closes, `cut`). Old tombstones are forgotten.
 */
export function flushOpenings(ownId: string | null, token: string, store: OpeningStore = chromeOpenings, now: () => number = Date.now, wait: Wait = pause): Promise<OpeningRecord[]> {
  return inTurn(async () => {
    const index = (await store.get([INDEX_KEY]))[INDEX_KEY]
    const ids = index && typeof index === "object" ? Object.keys(index as Record<string, unknown>) : []
    if (!ids.length) return []
    const got = await store.get(ids.map(recordKey))
    const t = now()
    const due: Array<[string, OpeningRecord]> = []
    const forget: string[] = []
    for (const id of ids) {
      const r = got[recordKey(id)]
      // (2.8.1 builds before F2 kept whole records in the index: dropped, never closed twice.)
      if (!valid(r)) {
        if (typeof (index as Record<string, unknown>)[id] !== "number" || t - Number((index as Record<string, unknown>)[id]) > TOMBSTONE_MS) forget.push(id)
        continue
      }
      if (r.closed) {
        if (t - r.closed > TOMBSTONE_MS) forget.push(id)
        continue
      }
      if (id === ownId || claimedByOther(r, token, t)) continue
      if (r.gone || t - r.last > SAME_OPENING_MS) due.push([id, r])
    }
    const closed = await claimAndClose(store, due, token, now, wait)
    if (forget.length) {
      await store.remove(forget.map(recordKey))
      const fresh = (await store.get([INDEX_KEY]))[INDEX_KEY]
      const left = { ...((fresh && typeof fresh === "object" ? fresh : {}) as Record<string, unknown>) }
      for (const id of forget) delete left[id]
      await store.set({ [INDEX_KEY]: left })
    }
    return closed
  })
}
