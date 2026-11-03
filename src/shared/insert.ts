// Quick insert: its settings, storage keys and the messages between the panel and the background.
// Kept apart from the panel's own settings: they stay on this device (Copied, the sign, the sites).

import { COPIED_DEFAULT_ON } from "./copied.ts"
import type { ErrorCode, ProOffer, Usage } from "./types.ts"

export const INSERT_STORAGE = {
  settings: "cf:insert",
  copied: "cf:copied",
  // Templates by id (tombstones too), the time of each one the app last confirmed, uses per site.
  templates: "cf:templates",
  syncedTemplates: "cf:syncedTemplates",
  templateUse: "cf:templateUse",
  // The first-touch tip by a field was shown (after the update).
  tipSeen: "cf:insertTipSeen"
} as const

export interface InsertSettings {
  // The button by a field (iPhone and iPad; Mac uses the sign and the shortcut).
  button: boolean
  // Keep what's copied on pages for the list.
  copied: boolean
  // What opens the list when typed in a field ("/" by default; "//" on sites with their own "/" menu).
  sign: string
  // Sites where nothing copied is kept ("Don't keep on this site").
  copiedOffSites: string[]
  // Sites where the button by fields doesn't show.
  buttonOffSites: string[]
}

export const DEFAULT_INSERT_SETTINGS: InsertSettings = {
  button: true,
  copied: COPIED_DEFAULT_ON,
  sign: "/",
  copiedOffSites: [],
  buttonOffSites: []
}

/** How a list was opened, and where an insert came from: for the counters (no text). */
export type InsertVia = "button" | "slash" | "shortcut" | "panel"

/** The counters (no text, no sites): what was inserted and how, templates made, AI fills. */
export type InsertEvent =
  | { kind: "insert_copied"; via: InsertVia }
  | { kind: "insert_template"; via: InsertVia; blanks: number; filled: "ai" | "manual" | "none" }
  | { kind: "insert_answer"; what: "answer" | "note" }
  | { kind: "template_created"; from: "selection" | "plus" | "pin"; blanks: number; ai: boolean }
  | { kind: "insert_fill"; blanks: number; found: number }
  | { kind: "insert_fill_edit"; blanks: number }
  | { kind: "insert_manual"; field: "control" | "editor" }
  | { kind: "social_open"; network: "x" | "threads" }

/** What the AI found in a selected text for a new template: its blanks, a title, words to find it by. */
export interface MarkResult {
  ok: true
  title: string
  keywords: string[]
  blanks: Array<{ label: string; value: string }>
}

/** The blanks the AI filled from the page (null: not sure, the blank stays empty). */
export interface FillResult {
  ok: true
  values: Record<string, string | null>
  // AI fills left today on Free (null: no limit).
  left: number | null
}

export interface FindResult {
  ok: true
  ids: string[]
}

export type AiFailure = { ok: false; code: ErrorCode | "FILL_LIMIT"; usage?: Usage | null; offer?: ProOffer | null; left?: number | null }

export type InsertRequest =
  // Pull the app's and iCloud's template changes now (the list or the Templates view opened).
  | { type: "qiSync" }
  | { type: "qiEvent"; event: InsertEvent }
  | { type: "qiMark"; text: string }
  | { type: "qiFill"; text: string; blanks: string[]; page: { title: string; url: string; text: string }; field: string }
  | { type: "qiFind"; query: string; templates: Array<{ id: string; title: string; keywords: string[] }> }

export type InsertContentMessage = { type: "quickInsert" }
