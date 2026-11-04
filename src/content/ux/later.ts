// "Come back later" (2.5, the owner's "remind or watch"): the bell is about time ("I know when"), the eye about a
// change ("I don't know when"), never mixed. This file is where the two meet without knowing each other: the window
// "Come back later…" (the header's "…") shows Remind (LaterSheet) and, under it, the sections added here; the
// selection bubble shows, after Template, the actions added here. Watching (its own branch on top of this one)
// adds its section and its eye from its own files; nothing here or in App.tsx changes for it.

import type { VNode } from "preact"

/** What the window is about: the page, and what was selected on it when the window opened (if anything). */
export interface LaterContext {
  url: string
  key: string
  title: string
  selection: string | null
  // The selection's range on the page, taken when the window opened (before the focus went to the window).
  range: Range | null
  close(): void
  // Brings Remind (at the window's top) into view and flashes it: a page that can't be watched offers it instead.
  remind(): void
}

/** A selection on the page, for the bubble's actions. */
export interface BubbleContext {
  url: string
  key: string
  title: string
  selection: string
  range: Range | null
  close(): void
}

/** A row in the "Reminders" list: a reminder (the bell) or something watched (the eye). */
export interface LaterItem {
  id: string // "remind:<chat>:<message key>" | "watch:<id>"
  kind: "remind" | "watch"
  title: string // the page or the chat
  url?: string
  status: string // ready to show, in the user's language: "Tomorrow 9:00" / "Watching: size 42 · checked an hour ago"
  sortAt: number // a reminder: when it rings; a watch: its last check
  here?: boolean // a reminder: it rings on this device
}

/** Rows for a "Reminders" list in the panel (watching's): listed, and stopped from the list. */
export interface LaterSource {
  items(): Promise<LaterItem[]>
  cancel(id: string): Promise<void>
}

type Section = (ctx: LaterContext) => VNode | null
type BubbleAction = (ctx: BubbleContext) => VNode | null

const sections = new Map<string, Section>()
const bubbleActionsById = new Map<string, BubbleAction>()
const sourcesById = new Map<string, LaterSource>()
let opener: ((from?: { selection: string | null; range: Range | null }) => void) | null = null

/** A section under Remind in the window (watching: "Tell me when it changes"); null renders nothing. */
export function addLaterSection(id: string, render: Section): void {
  sections.set(id, render)
}

export function laterSections(): Section[] {
  return [...sections.values()]
}

/** An action in the selection bubble, after Template (watching: the eye on a price, stock, a date or a status). */
export function addBubbleAction(id: string, render: BubbleAction): void {
  bubbleActionsById.set(id, render)
}

export function bubbleActions(): BubbleAction[] {
  return [...bubbleActionsById.values()]
}

/** Rows for the panel's "Reminders" list, besides the reminders in the chats (watching's). */
export function addLaterSource(id: string, source: LaterSource): void {
  sourcesById.set(id, source)
}

export function laterSources(): LaterSource[] {
  return [...sourcesById.values()]
}

/** Opens the window (Remind first), e.g. when a page can't be watched: over the page when the panel is closed. */
export function openLater(from?: { selection: string | null; range: Range | null }): void {
  opener?.(from)
}

/** The panel says how to open the window (App). */
export function setLaterOpener(open: typeof opener): void {
  opener = open
}

/** The page's selection as a range, outside the panel (null when there's none). */
export function pageRange(host: string): Range | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const node = range.commonAncestorContainer
  const el = node instanceof Element ? node : node.parentElement
  return el?.closest(host) ? null : range.cloneRange()
}
