// Reminders and watching (2.5, the owner's "remind or watch"): the bell is about time ("I know when"), the eye about
// a change ("I don't know when"), never mixed. 2.5 (77), the director's split: two words and two icons everywhere,
// never in one list: "Reminders" (the bell) and "Watching" (the eye), each its own list in the header's "…".
// This file is where the two meet without knowing each other: the selection bubble shows, after the bell, the
// actions added here (watching's eye); the lists ask the sources added here for their rows. Watching adds its
// eye and its rows from its own files.

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
  // The same action in the panel, on the row over its field (build 95, the owner: with the panel open on a selected
  // price, Watch and Remind were only in the pop-up): the page keeps its selection, and nothing closes.
  panel?: true
}

/** A row in the "Reminders" list (a reminder, the bell) or in "Watching" (something watched, the eye). */
export interface LaterItem {
  id: string // "remind:<chat>:<message key>" | "watch:<id>"
  kind: "remind" | "watch"
  title: string // the page or the chat
  url?: string
  status: string // ready to show, in the user's language: "Tomorrow 9:00" / "Watching: size 42 · checked an hour ago"
  sortAt: number // a reminder: when it rings; a watch: its last check
  here?: boolean // a reminder: it rings on this device
  // A reminder (2.5 (75)): when it rings, what it's about (a note's text, an answer's start) and the question
  // answered; shown in full when its row is opened, where the time can be changed.
  at?: number
  text?: string
  question?: string
}

/** Rows for a list in the panel (watching's, in "Watching"): listed, and stopped from the list. */
export interface LaterSource {
  // What its rows are: the header's "…" shows that list (watching's: only where watching works, in Safari).
  kind?: LaterItem["kind"]
  items(): Promise<LaterItem[]>
  cancel(id: string): Promise<void>
  // Opens a row itself (watching's own window for a watch): true when it did, and the list does nothing more.
  // `done`: the row changed there (new words, stopped), the list reads its rows again.
  open?(item: LaterItem, done?: () => void): boolean
}

type Section = (ctx: LaterContext) => VNode | null
type BubbleAction = (ctx: BubbleContext) => VNode | null

const sections = new Map<string, Section>()
const bubbleActionsById = new Map<string, BubbleAction>()
const sourcesById = new Map<string, LaterSource>()
let opener: ((from?: { selection: string | null; range: Range | null }) => void) | null = null
let pageWatch: ((page: { url: string; title: string }) => void) | null = null

/** A section under Remind in "Remind me about this page" (none since 2.5 (77): the window is time only). */
export function addLaterSection(id: string, render: Section): void {
  sections.set(id, render)
}

export function laterSections(): Section[] {
  return [...sections.values()]
}

/** An action in the selection bubble, after the bell (watching: the eye on a price, stock, a date or a status). */
export function addBubbleAction(id: string, render: BubbleAction): void {
  bubbleActionsById.set(id, render)
}

export function bubbleActions(): BubbleAction[] {
  return [...bubbleActionsById.values()]
}

/** Rows for the panel's lists, besides the reminders in the chats (watching's, in "Watching"). */
export function addLaterSource(id: string, source: LaterSource): void {
  sourcesById.set(id, source)
}

/**
 * "Watch this page…" in the header's "…" (2.5 (77), the director: the whole-page watch keeps a way in): watching
 * says how to open its window for the whole page; the item shows only once it has.
 */
export function setPageWatch(open: typeof pageWatch): void {
  pageWatch = open
}

export function pageWatcher(): typeof pageWatch {
  return pageWatch
}

/** Whether the panel has a list of `kind`: reminders always; watching where a source gives its rows. */
export function listsKind(kind: LaterItem["kind"]): boolean {
  return kind === "remind" || [...sourcesById.values()].some((s) => s.kind === kind)
}

export function laterSources(): LaterSource[] {
  return [...sourcesById.values()]
}

/** Opens "Remind me about this page", e.g. when a page can't be watched: over the page when the panel is closed. */
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
