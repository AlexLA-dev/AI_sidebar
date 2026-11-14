// Spaces (2.7, «Пространства, как в Arc»): "Work", "Personal", "Shopping", each with its own chats and colour. Pure
// helpers shared by the panel, the background and tests; the app has the same in Swift (ChatMirror.swift `SpaceRecord`,
// Spaces.swift).
//
// The owner (14 Nov): «задумка хорошая, главное её реализовать не громоздко и понятно для пользователя»; «Давай сделаем
// Пространства выключаемой опцией в настройках». So: while there is one space nothing shows; a space is a name and a
// colour; a chat says which space it's in (`Thread.sp`), and a chat that doesn't (every chat before 2.7) is in the first
// space, so nothing is migrated. The list is one record, kept on the device and in iCloud next to the chats (record
// `SPACES_RECORD` in the chats' zone, the chats' record type and fields: no CloudKit schema change). Design note:
// ~/ContextFlow-work/spaces-27/design.md.

import { chatForPage, type ActiveThread, type Threads } from "./threads.ts"

/** The first space: always there, never deleted; every chat without a space of its own is in it. */
export const FIRST_SPACE = "first"

/** The list's record among the chats (iCloud, the app's copy). Not a chat id: those are UUIDs. */
export const SPACES_RECORD = "cf-spaces"

/** Spaces in Free, the first one included (the owner hasn't decided: the proposal is two, no limit in Pro). */
export const FREE_SPACES = 2

export const MAX_SPACE_NAME = 32

/** The colours to pick from, [light, base] for the gradient (the first is the ✦ circle's colour before 2.7). */
export const SPACE_COLORS = {
  blue: ["#38bdf8", "#2563eb"],
  green: ["#4ade80", "#16a34a"],
  orange: ["#fdba74", "#ea580c"],
  pink: ["#f9a8d4", "#db2777"],
  violet: ["#c4b5fd", "#7c3aed"],
  graphite: ["#94a3b8", "#475569"]
} as const

export type SpaceColor = keyof typeof SPACE_COLORS
export const COLOR_NAMES = Object.keys(SPACE_COLORS) as SpaceColor[]
const FIRST_COLOR: SpaceColor = "blue"

/** A space as stored: name, colour, place in the list, last change; `d`: deleted (kept so no copy brings it back). */
export interface StoredSpace {
  id: string
  n?: string
  c?: SpaceColor
  o?: number
  u: number
  d?: true
}

/** "Open this site here": the space a site opens in, or null once unbound (kept for the same reason). */
export interface SiteBinding {
  s: string | null
  u: number
}

export interface SpaceList {
  s: StoredSpace[]
  b: Record<string, SiteBinding>
}

/** The list as this device keeps it (`cf:spaces`): `u`, its last change, decides which copy is newer. */
export interface StoredSpaces {
  u: number
  list: SpaceList
}

/** A space as the panel shows it. */
export interface Space {
  id: string
  name: string
  color: SpaceColor
  order: number
}

export function emptySpaces(): SpaceList {
  return { s: [], b: {} }
}

function isColor(value: unknown): value is SpaceColor {
  return typeof value === "string" && value in SPACE_COLORS
}

export function cleanSpaceName(name: string): string {
  const line = name.replace(/\s+/g, " ").trim()
  return line.length > MAX_SPACE_NAME ? line.slice(0, MAX_SPACE_NAME).trimEnd() : line
}

/** A list as read back from storage, iCloud or the app, or null if it isn't one. Parts that don't make sense go. */
export function cleanSpaceList(raw: unknown): SpaceList | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.s)) return null
  const s: StoredSpace[] = []
  const seen = new Set<string>()
  for (const x of o.s) {
    if (!x || typeof x !== "object") continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== "string" || !r.id || r.id.length > 64 || typeof r.u !== "number" || !Number.isFinite(r.u) || seen.has(r.id)) continue
    seen.add(r.id)
    if (r.d === true && r.id !== FIRST_SPACE) {
      s.push({ id: r.id, u: r.u, d: true })
      continue
    }
    const n = typeof r.n === "string" ? cleanSpaceName(r.n) : ""
    s.push({
      id: r.id, u: r.u,
      ...(n ? { n } : {}),
      ...(isColor(r.c) ? { c: r.c } : {}),
      ...(typeof r.o === "number" && Number.isFinite(r.o) ? { o: r.o } : {})
    })
  }
  const b: Record<string, SiteBinding> = {}
  if (o.b && typeof o.b === "object" && !Array.isArray(o.b)) {
    for (const [host, v] of Object.entries(o.b as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null
      if (!host || host.length > 253 || !r || typeof r.u !== "number" || !Number.isFinite(r.u)) continue
      if (typeof r.s === "string" && r.s) b[host] = { s: r.s, u: r.u }
      else if (r.s === null) b[host] = { s: null, u: r.u }
    }
  }
  return { s, b }
}

/**
 * The spaces there are, in their order: the first one always (with the name and colour it was given, else
 * `firstName` in blue), then the others. Deleted ones are left out.
 */
export function liveSpaces(list: SpaceList, firstName: string): Space[] {
  const first = list.s.find((x) => x.id === FIRST_SPACE)
  const out: Space[] = [{ id: FIRST_SPACE, name: first?.n || firstName, color: first?.c ?? FIRST_COLOR, order: first?.o ?? 0 }]
  const others = list.s
    .filter((x) => x.id !== FIRST_SPACE && !x.d)
    .map((x, i) => ({ id: x.id, name: x.n || firstName, color: x.c ?? FIRST_COLOR, order: x.o ?? i + 1 }))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return [out[0], ...others]
}

/** How many spaces there are (the first one counts). */
export function spaceCount(list: SpaceList): number {
  return 1 + list.s.filter((x) => x.id !== FIRST_SPACE && !x.d).length
}

/** More than one space: only then do the switcher, the colours and moving chats show. */
export function hasSpaces(list: SpaceList): boolean {
  return spaceCount(list) > 1
}

/** The space `id` is, if it's one there is; else the first one (a deleted space's chats are in the first). */
export function resolveSpace(list: SpaceList, id: string | undefined | null): string {
  if (!id || id === FIRST_SPACE) return FIRST_SPACE
  const space = list.s.find((x) => x.id === id)
  return space && !space.d ? id : FIRST_SPACE
}

/** The space a chat is in. */
export function spaceOfChat(list: SpaceList, chat: { sp?: string } | undefined): string {
  return resolveSpace(list, chat?.sp)
}

/** Whether another space can be made: Free has FREE_SPACES, Pro and Ultra no limit. */
export function canAddSpace(list: SpaceList, pro: boolean): boolean {
  return pro || spaceCount(list) < FREE_SPACES
}

/** The colour the next space starts with: the first one no space has yet. */
export function nextColor(list: SpaceList, firstName = ""): SpaceColor {
  const used = new Set(liveSpaces(list, firstName).map((x) => x.color))
  return COLOR_NAMES.find((c) => !used.has(c)) ?? COLOR_NAMES[spaceCount(list) % COLOR_NAMES.length]
}

/** A change's time: now, and always later than what it replaces. */
function later(u: number | undefined, now: number): number {
  return Math.max(now, (u ?? 0) + 1)
}

/** A new space at the end of the list. */
export function addSpace(list: SpaceList, id: string, name: string, color: SpaceColor, now = Date.now()): SpaceList {
  const live = liveSpaces(list, "")
  const order = Math.max(...live.map((x) => x.order)) + 1
  const n = cleanSpaceName(name)
  return { ...list, s: [...list.s.filter((x) => x.id !== id), { id, ...(n ? { n } : {}), c: color, o: order, u: later(undefined, now) }] }
}

/** A space renamed or recoloured (the first one too). */
export function editSpace(list: SpaceList, id: string, name: string, color: SpaceColor, now = Date.now()): SpaceList {
  const stored = list.s.find((x) => x.id === id)
  if (stored?.d || (!stored && id !== FIRST_SPACE)) return list
  const n = cleanSpaceName(name)
  const next: StoredSpace = { id, ...(n ? { n } : {}), c: color, ...(stored?.o !== undefined ? { o: stored.o } : {}), u: later(stored?.u, now) }
  return { ...list, s: [...list.s.filter((x) => x.id !== id), next] }
}

/** A space deleted: its chats are in the first space from now on, the sites bound to it open as any other. */
export function deleteSpace(list: SpaceList, id: string, now = Date.now()): SpaceList {
  const stored = list.s.find((x) => x.id === id)
  if (id === FIRST_SPACE || !stored || stored.d) return list
  const b = { ...list.b }
  for (const [host, v] of Object.entries(b)) if (v.s === id) b[host] = { s: null, u: later(v.u, now) }
  return { s: [...list.s.filter((x) => x.id !== id), { id, u: later(stored.u, now), d: true }], b }
}

/** A page's host as bindings are kept: no "www.", lower case ("" for an address that isn't one). */
export function siteKey(href: string): string {
  try {
    const url = new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    return url.hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

/** The space a site opens in, if it's bound to one there is. */
export function boundSpace(list: SpaceList, site: string): string | null {
  const id = site ? list.b[site]?.s : null
  return id && resolveSpace(list, id) === id ? id : null
}

/** "Open this site here": `space`, or null to unbind it. */
export function bindSite(list: SpaceList, site: string, space: string | null, now = Date.now()): SpaceList {
  if (!site) return list
  return { ...list, b: { ...list.b, [site]: { s: space, u: later(list.b[site]?.u, now) } } }
}

/**
 * Two copies of the list as one: each space and each site's binding as its newest copy says (a deletion or an unbinding
 * too: never brought back by an older copy). The same time on both: the one that sorts first as JSON, so every device
 * picks the same (ChatMirror.swift `SpaceRecord.merge`).
 */
export function mergeSpaces(a: SpaceList, b: SpaceList): SpaceList {
  const pick = <T extends { u: number }>(x: T | undefined, y: T | undefined): T | undefined => {
    if (!x) return y
    if (!y) return x
    if (x.u !== y.u) return x.u > y.u ? x : y
    return JSON.stringify(sortedKeys(x)) <= JSON.stringify(sortedKeys(y)) ? x : y
  }
  const ids = new Set([...a.s.map((x) => x.id), ...b.s.map((x) => x.id)])
  const s = [...ids].sort().map((id) => pick(a.s.find((x) => x.id === id), b.s.find((x) => x.id === id))!)
  const hosts = new Set([...Object.keys(a.b), ...Object.keys(b.b)])
  const bind: Record<string, SiteBinding> = {}
  for (const host of [...hosts].sort()) bind[host] = pick(a.b[host], b.b[host])!
  return { s, b: bind }
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, sortedKeys(v)]))
  return value
}

/** The list in one form whatever order it was built in: for iCloud, and to tell whether two copies say the same. */
export function spacesForCloud(list: SpaceList): string {
  const s = [...list.s].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const b = Object.fromEntries(Object.entries(list.b).sort(([x], [y]) => (x < y ? -1 : 1)))
  return JSON.stringify(sortedKeys({ v: 1, s, b }))
}

export function spacesFromCloud(data: string): SpaceList | null {
  try {
    return cleanSpaceList(JSON.parse(data))
  } catch {
    return null
  }
}

export function sameSpaces(a: SpaceList, b: SpaceList): boolean {
  return spacesForCloud(a) === spacesForCloud(b)
}

/** The list changed here: newer than the copy it replaces. */
export function changedSpaces(stored: StoredSpaces | undefined, list: SpaceList, now = Date.now()): StoredSpaces {
  return { u: later(stored?.u, now), list }
}

/**
 * Another copy of the list (iCloud's, or the app's) taken in: merged with this device's. When the merge is that copy,
 * it's kept with its time (nothing to send back); otherwise the merge is newer than both and goes up with the next sync.
 * Null when the copy isn't a list or says nothing new here.
 */
export function takeSpaces(stored: StoredSpaces | undefined, theirs: { updatedAt: number; data: string }): StoredSpaces | null {
  const list = spacesFromCloud(theirs.data)
  if (!list) return null
  if (!stored) return { u: theirs.updatedAt, list }
  const merged = mergeSpaces(stored.list, list)
  if (sameSpaces(merged, stored.list) && stored.u >= theirs.updatedAt) return null
  // Their copy has it all. The time never goes back: what the app was last given is told apart by it.
  if (sameSpaces(merged, list)) return { u: Math.max(theirs.updatedAt, stored.u), list: merged }
  return { u: Math.max(stored.u, theirs.updatedAt) + 1, list: merged }
}

/** The list as a change for iCloud or the app (CloudChange's shape), when `stored` is newer than what they have. */
export function spacesChange(stored: StoredSpaces | undefined, theirs: number | undefined): { id: string; updatedAt: number; data: string } | null {
  if (!stored || stored.u <= (theirs ?? 0)) return null
  return { id: SPACES_RECORD, updatedAt: stored.u, data: spacesForCloud(stored.list) }
}

// ------------------------------------------------------------ chats in spaces

/** The chats of one space (with Spaces off, or one space, every chat). */
export function chatsInSpace<T extends { sp?: string }>(chats: T[], list: SpaceList, space: string, on: boolean): T[] {
  if (!on || !hasSpaces(list)) return chats
  return chats.filter((t) => spaceOfChat(list, t) === space)
}

/**
 * The space this device is in: the space of the chat it shows, or, for a new chat not stored yet, the space it was
 * started in. With Spaces off, the first.
 */
export function currentSpace(list: SpaceList, shown: { sp?: string } | undefined, active: { sp?: string }, on: boolean): string {
  if (!on) return FIRST_SPACE
  return shown ? spaceOfChat(list, shown) : resolveSpace(list, active.sp)
}

/** Where the panel opens on a page: the chat (null: a new one) and the space; `bound`: it switched to the site's space. */
export interface PagePlace {
  chat: string | null
  space: string
  bound: boolean
}

/**
 * Where the panel opens on a page from the ✦ circle or Safari's toolbar button (2.6 (98) `chatForPage`, inside a space
 * since 2.7): in the space the site is bound to («Открывать этот сайт здесь»), else in the space it's in; there, the
 * latest chat on this page, else on this site. A bound site with neither: a new chat in its space. Otherwise null: the
 * panel stays on the chat it had.
 */
export function pageChatPlace(threads: Threads, active: ActiveThread, href: string, list: SpaceList, on: boolean): PagePlace | null {
  const shown = threads[active.id] && !threads[active.id].deleted && threads[active.id].trashed === undefined ? threads[active.id] : undefined
  const here = currentSpace(list, shown, active, on)
  const spaced = on && hasSpaces(list)
  const bound = spaced ? boundSpace(list, siteKey(href)) : null
  const space = bound ?? here
  const chat = chatForPage(threads, href, spaced ? (t) => spaceOfChat(list, t) === space : undefined)
  if (chat) return { chat, space, bound: space !== here }
  return space !== here ? { chat: null, space, bound: true } : null
}
