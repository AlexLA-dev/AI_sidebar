// What the chips' ranker (chips.ts) goes by, read from the page as the panel opens. Each signal is one the product
// already works out for something else; this only gathers them:
// - the field: quick insert's own (insert/target.ts: the field last written in), judged as its circle and its list
//   judge it (a field «Проверить» и «Переписать» work in, with text worth it);
// - the language: the translate pill's offer (translate/TranslatePill.tsx);
// - the kind: the page hints' (pagehints/detect.ts).
// Nothing leaves the device, and nothing is watched: a signal that comes later counts at the next opening.

import { noButtonField } from "../insert/spot"
import { loadInsertSettings, onInsertSettings } from "../insert/store"
import { rememberedField } from "../insert/target"
import { draftText, writableField } from "../insert/Write"
import { pageFree, pageKind, type PageKind } from "../pagehints/detect"
import { pageForeignOffer, pageTranslatedNow } from "../translate/TranslatePill"
import { fieldState, type ChipSignals } from "./chips"

/** Quick insert's field, if there is one: whether «Проверить» и «Переписать» would work in it, and what's written. */
function openField(): { usable: boolean; text: string } | null {
  const f = rememberedField()
  if (!f) return null
  try {
    // What's written there, without Gmail's signature or a quoted mail (an empty reply box is Compose's, 2.7 (108)).
    return { usable: !noButtonField(f.el) && writableField(f.el), text: draftText(f.el) }
  } catch {
    return null
  }
}

/** The page's kind as the hints tell it, read anew at each opening (a reply box opens and closes on the same address). */
function kindOf(doc: Document, url: string): PageKind | null {
  try {
    return pageKind(doc, url)
  } catch {
    return null
  }
}

/** Everything the page offers is free (no «Watch the price» there); a page that can't be read counts as priced. */
function freeOf(doc: Document): boolean {
  try {
    return pageFree(doc)
  } catch {
    return false
  }
}

/** The page as the ranker sees it, now. */
export function readSignals(media: ChipSignals["media"], doc: Document = document, url: string = location.href): ChipSignals {
  const kind = kindOf(doc, url)
  // A page already translated (or under way) isn't offered again: no «Translate page» chip first (2.7, 108).
  return { field: fieldState(openField(), kind), foreign: pageForeignOffer() !== null && !pageTranslatedNow(), kind, media, free: kind === "product" && freeOf(doc) }
}

/** The selection the panel opened on is inside the person's own draft. */
export function selectionInField(range: Range | null): boolean {
  const f = rememberedField()
  return Boolean(f && range && f.el.contains(range.commonAncestorContainer))
}

// «Проверить» и «Переписать» can be turned off in quick insert's settings: then their chips aren't offered. Kept here
// as it changes, so the ranker reads it without waiting.
let writing = true

/** Follows the setting; returns the function that stops it. */
export function watchWriting(): () => void {
  void loadInsertSettings().then((s) => {
    writing = s.writing
  })
  return onInsertSettings((s) => {
    writing = s.writing
  })
}

export function writingOn(): boolean {
  return writing
}
