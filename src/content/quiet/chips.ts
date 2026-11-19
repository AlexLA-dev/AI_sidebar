// The quick actions' order in the panel (2.7 after build 107, the owner: «чипы… меняются после открытия сайдбара + как-то
// странно не всегда в тему. например в Gmail не было чипов типо переписать и т.п. (при открытом черновике ответа)»).
// One ranker decides it from what the page is: a field being written in, a page in another language, a product, an
// article, a video or a PDF. The signals are the ones the page hints (pagehints/detect.ts), the translate pill
// (translate/TranslatePill.tsx) and quick insert (insert/target.ts) already work out; nothing is detected twice.
// The order is read once, as the panel opens (signals.ts), and stays until it opens again: no chip moves while it's
// looked at. Pure, for tests (tests/quiet-chips.test.mts).

import { worthWriting } from "../../shared/writing"
import type { PageKind } from "../pagehints/detect"

/** The page's quick actions. "check", "rewrite" and "templates" work on the page's field; "translate_page" translates
 *  the page in place; "watch" watches the page; the rest ask the chat. */
export type ChipId = "check" | "rewrite" | "compose" | "templates" | "translate_page" | "similar" | "watch" | "summarize" | "key_points" | "explain" | "translate" | "google"

export interface ChipSignals {
  // A field or a draft open on the page: none, one with nothing to work on yet ("blank": nothing written at all, so
  // Compose can write it, 2.7 (108)), one with text.
  field: "none" | "blank" | "empty" | "text"
  // The page's main text is in another language than the person's (the translate pill's own judgment).
  foreign: boolean
  // What the page is (the page hints' kind), or null.
  kind: PageKind | null
  // What the panel reads here: the page, its video, a PDF.
  media: "page" | "video" | "pdf"
}

/**
 * The field signal. `field`: quick insert's field (the one last written in), whether «Проверить» и «Переписать» work
 * in it, and its text; null when the page has none. A page with a place to write that hasn't been touched yet (the
 * hints' "form") counts as an empty one: Templates are offered there too.
 */
export function fieldState(field: { usable: boolean; text: string } | null, kind: PageKind | null): ChipSignals["field"] {
  if (field?.usable) return worthWriting(field.text) ? "text" : field.text.trim() ? "empty" : "blank"
  return kind === "form" ? "empty" : "none"
}

/** What this panel can do here at all (a chip that can't run is never shown). */
export interface ChipAbilities {
  // «Проверить» и «Переписать» are on (Settings), and quick insert runs on this page.
  write: boolean
  // In-page translation can start (the tab's own page, not a PDF's popup).
  translatePage: boolean
  // Watching is here (Safari, the lists on).
  watch: boolean
  // Find similar's chip belongs here (not in "Ask your chats", not for a PDF).
  similar: boolean
}

/** Every page's chips, in the order they had before the ranker: what's left after the page's own come first. */
export const BASE_ORDER: ChipId[] = ["summarize", "key_points", "explain", "translate", "google", "similar"]

/** The rest for this page: as they were on a page in another language; on a page in the person's own «Translate»
 *  (the chat's translation of the page) goes behind everything likelier there. */
function rest(foreign: boolean): ChipId[] {
  return foreign ? BASE_ORDER : [...BASE_ORDER.filter((id) => id !== "translate"), "translate"]
}

/**
 * The page's chips, the likeliest first.
 * - A field with text: Check, Rewrite, Templates. An empty one: Templates.
 * - Main text in another language: Translate page.
 * - A video or a PDF: its summaries. A product: Find similar, Watch the price. An article: Summarize, Key takeaways.
 * - Then everything else, as before; «Translate» last of all unless the page is in another language (2.7 after 107,
 *   the director on the chips under an answer: on an English article for an English reader it was third).
 * A field comes before the page's language (someone writing is busy with the draft), and both before the page's kind.
 * The chips under an answer are this same list, less what was already asked about the page (App.tsx).
 */
export function rankChips(s: ChipSignals, can: ChipAbilities): ChipId[] {
  const out: ChipId[] = []
  const add = (...ids: ChipId[]) => {
    for (const id of ids) if (!out.includes(id) && allowed(id, s, can)) out.push(id)
  }
  if (s.field === "text") add("check", "rewrite", "templates")
  else if (s.field === "blank") add("compose", "templates")
  else if (s.field === "empty") add("templates")
  if (s.foreign) add("translate_page")
  if (s.media !== "page") add("summarize", "key_points")
  else if (s.kind === "product") add("similar", "watch")
  else if (s.kind === "article") add("summarize", "key_points")
  add(...rest(s.foreign))
  return out
}

function allowed(id: ChipId, s: ChipSignals, can: ChipAbilities): boolean {
  switch (id) {
    case "check":
    case "rewrite":
      return can.write && s.field === "text"
    case "compose":
      return can.write && s.field === "blank"
    case "templates":
      return can.write && s.field !== "none"
    case "translate_page":
      return can.translatePage && s.foreign && s.media === "page"
    case "watch":
      return can.watch && s.media === "page" && s.kind === "product"
    case "similar":
      return can.similar
    default:
      return true
  }
}

/** A selection's chips (the panel opened on selected text): as they were, but for text selected in the person's own
 *  draft, where improving it and replying come first. */
export function rankSelectionChips<T extends { id: string }>(actions: T[], inField: boolean): T[] {
  if (!inField) return actions
  const first = ["sel_improve", "sel_reply"]
  return [...first.flatMap((id) => actions.filter((a) => a.id === id)), ...actions.filter((a) => !first.includes(a.id))]
}

/** Which edges have chips behind them, by where the first and the last chip are: "", "left", "right" or "both". */
export function moreAt(box: { left: number; right: number }, chips: Array<{ left: number; right: number }>): "" | "left" | "right" | "both" {
  if (!chips.length) return ""
  const left = Math.min(...chips.map((c) => c.left)) < box.left - 1
  const right = Math.max(...chips.map((c) => c.right)) > box.right + 1
  return left && right ? "both" : left ? "left" : right ? "right" : ""
}
