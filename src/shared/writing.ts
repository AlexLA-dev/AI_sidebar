// «Проверить» и «Переписать» (2.7, plan section 13): the text being written in a field on a site, checked or rewritten
// with the page in mind (the email being answered, the post under a comment, the job under an application) and in the
// person's own style («О себе», their templates, how they wrote on this site before). Shared by the panel's quick
// insert, the background, the server (/api/v2/write) and the tests.
// - The style samples stay on the device (chrome.storage.local): only the few that go with a request leave it, as the
//   field's text does, and the server keeps nothing.
// - A check comes back as the whole corrected text; the device works out the changes itself (diffWords), so each fix
//   lands on its own words and the rest of the field (links, bold, a signature) stays as it is.
// - A tap is one answer (Free's 5 a day, the Pro and Ultra week). Live underlines (Pro and Ultra) aren't counted.

import { blanks, type Template, type TemplateUse } from "./templates.ts"

export type WriteAction = "check" | "rewrite"
export const TONES = ["short", "warm", "formal", "confident"] as const
export type Tone = (typeof TONES)[number]

export const WRITE_LIMITS = {
  // The field's text (or the part selected in it): longer ones ask for a part to be selected.
  text: 4_000,
  // The page or the conversation around the field.
  page: 6_000,
  field: 200,
  about: 600,
  samples: 3,
  sampleChars: 600,
  templates: 3,
  templateChars: 400
} as const

/** A text worth checking: two words at least (the circle shows from then on). */
export function worthWriting(text: string): boolean {
  return /\S+\s+\S+/.test(text.trim())
}

// ------------------------------------------------------------ what goes to the server

export interface WriteStyle {
  // «О себе» from Settings.
  about?: string
  // How they wrote on this site before (newest first).
  samples: string[]
  // Their templates' texts (most used here first).
  templates: string[]
}

export interface WritePage {
  title: string
  url: string
  text: string
  // `text` is the conversation around the field (a mail, a chat), not the whole page.
  conversation: boolean
}

export interface WriteAsk {
  action: WriteAction
  tone?: Tone
  text: string
  page: WritePage
  field: string
  style: WriteStyle
}

export type WriteFailureCode = "LIMIT_REACHED" | "TOO_LONG" | "BUSY" | "UPSTREAM" | "NETWORK" | "UNAVAILABLE" | "BAD_REQUEST" | "CONSENT"

export type WriteReply =
  | { ok: true; text: string; usage?: { used: number; limit: number; period: "day" | "week"; resetsAt: string } | null }
  | { ok: false; code: WriteFailureCode; usage?: { used: number; limit: number; period: "day" | "week"; resetsAt: string } | null; offer?: { code: string; discount: number } | null }

/** The request as the server takes it: everything clipped to its limits, empty parts left out. */
export function clipAsk(ask: WriteAsk): WriteAsk {
  const style: WriteStyle = {
    samples: ask.style.samples.map((s) => s.trim().slice(0, WRITE_LIMITS.sampleChars)).filter(Boolean).slice(0, WRITE_LIMITS.samples),
    templates: ask.style.templates.map((s) => s.trim().slice(0, WRITE_LIMITS.templateChars)).filter(Boolean).slice(0, WRITE_LIMITS.templates)
  }
  const about = ask.style.about?.trim().slice(0, WRITE_LIMITS.about)
  if (about) style.about = about
  return {
    action: ask.action,
    ...(ask.action === "rewrite" && ask.tone ? { tone: ask.tone } : {}),
    text: ask.text,
    page: { title: ask.page.title.slice(0, 300), url: ask.page.url.slice(0, 2000), text: ask.page.text.slice(0, WRITE_LIMITS.page), conversation: ask.page.conversation },
    field: ask.field.slice(0, WRITE_LIMITS.field),
    style
  }
}

// ------------------------------------------------------------ the person's style, on this device

export interface Sample {
  t: string
  at: number
}

/** Earlier texts by site (siteKey): what the person wrote in fields there, newest first. */
export type Samples = Record<string, Sample[]>

export const SAMPLES = {
  min: 40,
  perSite: 5,
  sites: 60,
  ttl: 60 * 24 * 3600_000
} as const

/** A text clipped at a word near `max` characters. */
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}

/**
 * Keeps what the person wrote on a site (sent, or left when the field lost the focus). A newer version of the same text
 * (its start unchanged: a draft written on) replaces the older one; at most SAMPLES.perSite a site, old ones go.
 */
export function keepSample(all: Samples, site: string, text: string, now: number): Samples {
  const t = clipAtWord(text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(), WRITE_LIMITS.sampleChars)
  if (!site || t.length < SAMPLES.min || !worthWriting(t)) return all
  const head = t.slice(0, 30)
  const fresh = (list: Sample[]) => list.filter((s) => now - s.at < SAMPLES.ttl)
  const mine = fresh(all[site] ?? []).filter((s) => s.t.slice(0, 30) !== head && !t.startsWith(s.t) && !s.t.startsWith(t))
  const next: Samples = {}
  for (const [k, list] of Object.entries(all)) {
    if (k === site) continue
    const kept = fresh(list)
    if (kept.length) next[k] = kept
  }
  next[site] = [{ t, at: now }, ...mine].slice(0, SAMPLES.perSite)
  const sites = Object.keys(next)
  if (sites.length > SAMPLES.sites) {
    const newest = (k: string) => Math.max(...next[k].map((s) => s.at))
    for (const old of sites.sort((a, b) => newest(a) - newest(b)).slice(0, sites.length - SAMPLES.sites)) delete next[old]
  }
  return next
}

/** The samples that go with a request: this site's newest, never the text being checked itself. */
export function samplesFor(all: Samples, site: string, now: number, current = ""): string[] {
  const head = current.trim().slice(0, 30)
  return (all[site] ?? [])
    .filter((s) => now - s.at < SAMPLES.ttl && (!head || s.t.slice(0, 30) !== head))
    .slice(0, WRITE_LIMITS.samples)
    .map((s) => s.t)
}

/** Their templates as samples of their style: the most used on this site first, then the most used anywhere. */
export function styleTemplates(templates: Template[], use: TemplateUse, site: string): string[] {
  const score = (tpl: Template) => {
    const u = use[tpl.id]
    return [u?.sites[site] ?? 0, u ? Object.values(u.sites).reduce((a, b) => a + b, 0) : 0, tpl.updatedAt] as const
  }
  return templates
    .filter((tpl) => !tpl.deleted && tpl.text.trim().length >= 20 && blanks(tpl.text).length <= 4)
    .sort((a, b) => {
      const [x, y] = [score(a), score(b)]
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
    })
    .slice(0, WRITE_LIMITS.templates)
    .map((tpl) => clipAtWord(tpl.text.trim(), WRITE_LIMITS.templateChars))
}

// ------------------------------------------------------------ the changes a check made

/** One change: the characters [from, to) of the original become `text`. */
export interface Edit {
  from: number
  to: number
  text: string
}

/** Words (letters, digits, apostrophes and hyphens inside), runs of spaces, and single other characters. */
export function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*|[^\S\n]+|\n|[\s\S]/gu) ?? []
}

// Above this many cells the table isn't worth it: one change for the middle.
const MAX_CELLS = 4_000_000

/**
 * The changes from `a` to `b`, word by word (a longest common sequence of tokens), adjacent ones joined; a change
 * between two others with only a space between them joins them too ("teh  quik" → "the quick" is one change).
 */
export function diffWords(a: string, b: string): Edit[] {
  if (a === b) return []
  const A = tokens(a)
  const B = tokens(b)
  // The same start and end stay out of the table.
  let pre = 0
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const a2 = A.slice(pre, A.length - suf)
  const b2 = B.slice(pre, B.length - suf)
  const offset = A.slice(0, pre).join("").length
  const n = a2.length
  const m = b2.length
  type Op = { same: boolean; a: string; b: string }
  const ops: Op[] = []
  if (n * m > MAX_CELLS || n === 0 || m === 0) {
    ops.push({ same: false, a: a2.join(""), b: b2.join("") })
  } else {
    const w = m + 1
    const table = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] = a2[i] === b2[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        ops.push({ same: true, a: a2[i], b: b2[j] })
        i++
        j++
      } else if (j < m && (i === n || table[i * w + j + 1] >= table[(i + 1) * w + j])) {
        ops.push({ same: false, a: "", b: b2[j++] })
      } else {
        ops.push({ same: false, a: a2[i++], b: "" })
      }
    }
  }
  // Runs of changes become edits; a lone space between two changes (and not a line break) joins them.
  const edits: Edit[] = []
  let at = offset
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.same) {
      at += op.a.length
      continue
    }
    const last = edits[edits.length - 1]
    if (last && last.to === at) {
      last.to += op.a.length
      last.text += op.b
    } else if (last && edits.length && k >= 2 && ops[k - 1].same && /^[^\S\n]+$/.test(ops[k - 1].a) && last.to === at - ops[k - 1].a.length) {
      last.to = at + op.a.length
      last.text += ops[k - 1].b + op.b
    } else {
      edits.push({ from: at, to: at + op.a.length, text: op.b })
    }
    at += op.a.length
  }
  return edits.filter((e) => e.to > e.from || e.text)
}

/** `text` with the edits made (they're in order and don't overlap). */
export function applyEdits(text: string, edits: Edit[]): string {
  let out = ""
  let at = 0
  for (const e of edits) {
    out += text.slice(at, e.from) + e.text
    at = e.to
  }
  return out + text.slice(at)
}

/** The text in parts for showing a check: unchanged stretches, and each change with what goes and what comes. */
export function diffParts(text: string, edits: Edit[]): Array<{ same: string } | { was: string; now: string }> {
  const parts: Array<{ same: string } | { was: string; now: string }> = []
  let at = 0
  for (const e of edits) {
    if (e.from > at) parts.push({ same: text.slice(at, e.from) })
    parts.push({ was: text.slice(e.from, e.to), now: e.text })
    at = e.to
  }
  if (at < text.length) parts.push({ same: text.slice(at) })
  return parts
}

/** The text's leading and trailing white space: kept out of what's sent, so the field's own ends never change. */
export function trimmedSpan(text: string): { from: number; to: number } {
  const from = text.length - text.trimStart().length
  const to = text.trimEnd().length
  return { from: Math.min(from, to), to }
}
