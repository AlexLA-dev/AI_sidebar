// 2.8 (В4.1, В6.2): ready questions about the page, by its kind (pagehints/detect.ts, decided on the device), one tap
// each: the panel is never an empty field. A product, an article, a video, a form, an event, a stay or a recipe, and any
// other readable page. Their texts are in every locale; the questions are general, never for one site.

import type { PageKind } from "../pagehints/detect"
import type { MessageKey } from "../../shared/i18n"

export type ReadyKind = PageKind | "any"

export const READY: Record<ReadyKind, readonly MessageKey[]> = {
  product: ["rqProductWorth", "rqProductCons", "rqProductCheck"],
  article: ["rqArticleMain", "rqArticleArgue", "rqArticleMe"],
  video: ["rqVideoAbout", "rqVideoKey"],
  form: ["rqFormNeed", "rqFormWatch"],
  event: ["rqEventWhen", "rqEventWorth"],
  stay: ["rqStayKey", "rqStayWatch"],
  any: ["rqAnyMain", "rqAnyWorth"]
}

/** The questions for a page: its kind's, or the general ones. A video the plan can't read (Free) gets the general ones:
 *  its questions are about what's said in it. */
export function readyFor(kind: PageKind | null, videoRead: boolean): readonly MessageKey[] {
  if (!kind || (kind === "video" && !videoRead)) return READY.any
  return READY[kind]
}
