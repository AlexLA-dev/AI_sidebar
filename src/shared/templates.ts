// Quick insert templates: the model, blanks, search and order in the list, and how copies from the
// user's devices merge. Shared by the panel, the background and the tests; the app (Swift) keeps the
// same JSON per template (TemplateStore.swift).
//
// Sync is per template, not per file: each template is its own record, the newest `updatedAt` wins,
// and a deleted template stays as a tombstone so an older copy on another device can't bring it back.
// How often a template was used on a site stays on the device (counts would be lost by newest-wins).

export interface Template {
  id: string
  title: string
  // The text, with blanks written as {label}.
  text: string
  // Words it is found by (AI suggests a few when it is saved; the user can change them).
  keywords: string[]
  // The site it was made on: listed first there.
  site?: string
  createdAt: number
  // When it last changed (ms): the newest copy wins.
  updatedAt: number
  // A tombstone: deleted on one device, so older copies elsewhere go too.
  deleted?: true
}

export type Templates = Record<string, Template>

/** How often each template was inserted on each site, and when last (this device only). */
export type TemplateUse = Record<string, { at: number; sites: Record<string, number> }>

export const MAX_TEMPLATES = 300
export const MAX_TEMPLATE_CHARS = 8000
export const MAX_TITLE_CHARS = 80
export const MAX_KEYWORDS = 6
// Tombstones older than this are forgotten (every device has long since synced by then).
const TOMBSTONE_MS = 180 * 24 * 3600_000

// ------------------------------------------------------------ blanks

const BLANK = /\{([^{}\n]{1,40})\}/g

/** The blanks' labels, each once, in the order they first appear. */
export function blanks(text: string): string[] {
  const seen: string[] = []
  for (const m of text.matchAll(BLANK)) {
    const label = m[1].trim()
    if (label && !seen.includes(label)) seen.push(label)
  }
  return seen
}

/** The text in parts: plain text and blanks, for the preview where blanks are filled in. */
export function textParts(text: string): Array<{ text: string } | { blank: string }> {
  const parts: Array<{ text: string } | { blank: string }> = []
  let at = 0
  for (const m of text.matchAll(BLANK)) {
    const label = m[1].trim()
    if (!label) continue
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) })
    parts.push({ blank: label })
    at = m.index! + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** The text with its blanks filled in (an unfilled blank becomes empty). */
export function fillBlanks(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(BLANK, (whole, raw: string) => {
    const label = raw.trim()
    return label ? (values[label] ?? "").trim() : whole
  })
}

/**
 * Marks blanks in `text` at the values the AI found ("Anna" → "{Name}"): every occurrence of a value,
 * longest values first, so the text itself stays exactly as the user wrote it.
 */
export function markBlanks(text: string, found: Array<{ label: string; value: string }>): string {
  const usable = found
    .map((b) => ({ label: cleanLabel(b.label), value: b.value }))
    .filter((b) => b.label && b.value && b.value.trim().length > 0 && text.includes(b.value))
    .sort((a, b) => b.value.length - a.value.length)
  let out = text
  for (const b of usable) {
    // Skip values inside a blank already marked (a shorter value within a longer one).
    const parts = out.split(BLANK_SPLIT)
    out = parts.map((part) => (part.startsWith("{") && part.endsWith("}") ? part : part.split(b.value).join(`{${b.label}}`))).join("")
  }
  return out
}

const BLANK_SPLIT = /(\{[^{}\n]{1,40}\})/

export function cleanLabel(label: string): string {
  return label.replace(/[{}\n\r]/g, "").replace(/\s+/g, " ").trim().slice(0, 40)
}

// ------------------------------------------------------------ titles and search

/** A title from the first words of the text (blanks shown by their labels). */
export function titleFrom(text: string): string {
  const plain = text.replace(BLANK, (_w, l: string) => l.trim()).replace(/\s+/g, " ").trim()
  const first = plain.split(" ").slice(0, 6)
  // Not ending on a preposition or a conjunction ("…о встрече в").
  while (first.length > 1 && first[first.length - 1].length <= 2) first.pop()
  const words = first.join(" ")
  return (words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words) || "…"
}

/**
 * Lower case, without accents, no punctuation: what search compares ("cafe" finds "Café", "e" finds "ё", "tai" finds
 * "tải"). Build 95: the same for every language (it folded only «ё»): the accents that go on letters (Latin, Cyrillic,
 * Greek, Vietnamese tones, Arabic short vowels) come off; a script whose marks are part of its letters keeps them
 * (Korean syllables, Japanese voicing, Thai and Hindi vowels).
 */
export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "").normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, " ").replace(/\s+/g, " ").trim()
}

function words(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean)
}

export interface RankContext {
  host: string
  use: TemplateUse
  now: number
}

function siteScore(t: Template, ctx: RankContext): number {
  const used = ctx.use[t.id]
  const here = used?.sites[ctx.host] ?? 0
  const recent = used ? Math.max(0, 1 - (ctx.now - used.at) / (30 * 24 * 3600_000)) : 0
  return (t.site && t.site === ctx.host ? 4 : 0) + Math.min(here, 20) * 0.5 + recent
}

/**
 * Templates matching what's typed, best first. Every word of the query must start a word of the
 * title, the keywords or the text ("перен встр" finds "Перенос встречи"); with `names`, only the title and
 * the keywords ("/phrase" typed in a field: a word of the text is too easy a match). An empty query lists
 * them in the order for this site: made here, used here most, used lately.
 */
export function searchTemplates(list: Template[], query: string, ctx: RankContext, limit = 20, names = false): Template[] {
  const live = list.filter((t) => !t.deleted)
  const q = words(query)
  const scored: Array<{ t: Template; score: number }> = []
  for (const t of live) {
    let score = siteScore(t, ctx)
    if (q.length) {
      const title = words(t.title)
      const keys = t.keywords.flatMap(words)
      const body = words(t.text)
      let ok = true
      for (const w of q) {
        if (title.some((x) => x.startsWith(w))) score += title[0]?.startsWith(w) ? 12 : 10
        else if (keys.some((x) => x.startsWith(w))) score += 8
        else if (!names && body.some((x) => x.startsWith(w))) score += 3
        else {
          ok = false
          break
        }
      }
      if (!ok) continue
    }
    scored.push({ t, score })
  }
  scored.sort((a, b) => b.score - a.score || b.t.updatedAt - a.t.updatedAt)
  return scored.slice(0, limit).map((s) => s.t)
}

/** One more insert of `id` on `host`. */
export function noteUse(use: TemplateUse, id: string, host: string, now: number): TemplateUse {
  const prev = use[id] ?? { at: 0, sites: {} }
  const next: TemplateUse = { ...use, [id]: { at: now, sites: { ...prev.sites, [host]: (prev.sites[host] ?? 0) + 1 } } }
  // Only templates that still exist are worth remembering; the list is small.
  const ids = Object.keys(next)
  if (ids.length > MAX_TEMPLATES) for (const old of ids.sort((a, b) => next[a].at - next[b].at).slice(0, ids.length - MAX_TEMPLATES)) delete next[old]
  return next
}

// ------------------------------------------------------------ editing

export function newTemplateId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function makeTemplate(input: { text: string; title?: string; keywords?: string[]; site?: string }, now: number, id = newTemplateId()): Template {
  const text = input.text.replace(/\r\n?/g, "\n").slice(0, MAX_TEMPLATE_CHARS)
  return {
    id,
    title: (input.title?.trim() || titleFrom(text)).slice(0, MAX_TITLE_CHARS),
    text,
    keywords: cleanKeywords(input.keywords ?? []),
    ...(input.site ? { site: input.site } : {}),
    createdAt: now,
    updatedAt: now
  }
}

export function cleanKeywords(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const k of list) {
    const w = typeof k === "string" ? k.replace(/\s+/g, " ").trim().slice(0, 30) : ""
    if (w && !out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w)
  }
  return out.slice(0, MAX_KEYWORDS)
}

/** The template changed here now (its time moves on, so this copy wins everywhere). */
export function editTemplate(t: Template, patch: Partial<Pick<Template, "title" | "text" | "keywords">>, now: number): Template {
  const next: Template = { ...t, ...patch, updatedAt: Math.max(now, t.updatedAt + 1) }
  next.text = next.text.slice(0, MAX_TEMPLATE_CHARS)
  next.title = (next.title.trim() || titleFrom(next.text)).slice(0, MAX_TITLE_CHARS)
  next.keywords = cleanKeywords(next.keywords)
  return next
}

/** Deleted here: a tombstone with no text left. */
export function tombstone(t: Template, now: number): Template {
  return { id: t.id, title: "", text: "", keywords: [], createdAt: t.createdAt, updatedAt: Math.max(now, t.updatedAt + 1), deleted: true }
}

// ------------------------------------------------------------ sync

/** A template from storage, the app or iCloud, checked field by field (null when unusable). */
export function cleanTemplate(raw: unknown): Template | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === "string" && /^[\w-]{1,64}$/.test(r.id) ? r.id : null
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : null
  if (!id || updatedAt === null) return null
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : updatedAt
  if (r.deleted === true) return { id, title: "", text: "", keywords: [], createdAt, updatedAt, deleted: true }
  const text = typeof r.text === "string" ? r.text.slice(0, MAX_TEMPLATE_CHARS) : ""
  if (!text.trim()) return null
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, MAX_TITLE_CHARS) : titleFrom(text)
  const site = typeof r.site === "string" && r.site.length <= 120 ? r.site : undefined
  return { id, title, text, keywords: cleanKeywords(r.keywords), ...(site ? { site } : {}), createdAt, updatedAt }
}

/** The copy that wins: the newer one; on a tie the tombstone (a delete never loses to the same instant). */
export function newer(a: Template | undefined, b: Template | undefined): Template | undefined {
  if (!a) return b
  if (!b) return a
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  return b.deleted ? b : a
}

/** Templates changed here since the app (and iCloud) last confirmed them. */
export function pendingTemplates(local: Templates, synced: Record<string, number>): Template[] {
  return Object.values(local).filter((t) => (synced[t.id] ?? 0) < t.updatedAt)
}

/**
 * Takes the merged set the app returned (it has the other devices' changes too). A template changed
 * here while the app answered keeps the local copy and stays pending.
 */
export function applyTemplates(local: Templates, synced: Record<string, number>, remote: unknown[], now: number): { templates: Templates; synced: Record<string, number>; changed: boolean } {
  const templates: Templates = { ...local }
  const nextSynced = { ...synced }
  let changed = false
  for (const raw of remote) {
    const t = cleanTemplate(raw)
    if (!t) continue
    const win = newer(templates[t.id], t)!
    if (win !== templates[t.id]) {
      templates[t.id] = win
      changed = true
    }
    nextSynced[t.id] = Math.max(nextSynced[t.id] ?? 0, t.updatedAt)
  }
  for (const [id, t] of Object.entries(templates)) {
    if (t.deleted && now - t.updatedAt > TOMBSTONE_MS && (nextSynced[id] ?? 0) >= t.updatedAt) {
      delete templates[id]
      delete nextSynced[id]
      changed = true
    }
  }
  return { templates, synced: nextSynced, changed }
}

/** The templates to show, newest change first. */
export function liveTemplates(all: Templates): Template[] {
  return Object.values(all).filter((t) => !t.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Every word of the query starts a word of the template's title, in order of the title's words ("/ear" for
 * "Early check-in"): a match strong enough to stand chosen in the list, so Tab takes it. */
export function titleStarts(t: Template, query: string): boolean {
  const q = words(query)
  const title = words(t.title)
  return q.length > 0 && q.every((w, i) => title[i]?.startsWith(w))
}

