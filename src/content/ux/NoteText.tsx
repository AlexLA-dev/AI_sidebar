// A note in the chat (2.6 (97), the owner: «то, что выделено, было оформлено как цитата, и … можно было написать свою
// заметку к ней»): a note made on a selection shows what was selected as a quote and the person's own words under it;
// any other note (and one on a selection made before) shows its text, as before. The app draws the same
// (ChatsView.swift NoteBody).

import type { VNode } from "preact"

import { citedNote, type Entry } from "../../shared/conversation"
import { t } from "../../shared/i18n"
import * as Icon from "../icons"

export function NoteText({ entry }: { entry: Entry }): VNode {
  const cited = citedNote(entry)
  const mark = <span class="cf-note-mark" aria-label={t("shareNote")}><Icon.Pencil /></span>
  if (!cited) return <>{mark}{entry.content}</>
  return (
    <>
      <blockquote class="cf-note-cite" dir="auto">{!cited.note && mark}{cited.cite}</blockquote>
      {cited.note && <>{mark}{cited.note}</>}
    </>
  )
}
