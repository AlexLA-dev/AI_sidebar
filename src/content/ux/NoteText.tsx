// A note in the chat (2.6 (97), the owner: «то, что выделено, было оформлено как цитата, и … можно было написать свою
// заметку к ней»): a note made on a selection shows what was selected as a quote and the person's own words under it;
// any other note (and one on a selection made before) shows its text, as before. The app draws the same
// (ChatsView.swift NoteBody).

import type { VNode } from "preact"
import { useLayoutEffect, useRef, useState } from "preact/hooks"

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

/**
 * The selection a question was asked on, over the question (build 110, the owner: «нет цитаты выделенного текста, как
 * при написании заметки по нему»): a quote like a note's, folded to a few lines when it's long; a tap opens it and
 * folds it again. The app draws the same (ChatsView.swift AskedQuote).
 */
export function AskedCite({ text }: { text: string }): VNode {
  const ref = useRef<HTMLQuoteElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  // Long: more than the folded lines at the panel's width now (measured folded).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 2)
    measure()
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    watch?.observe(el)
    return () => watch?.disconnect()
  }, [text, open])
  const toggle = long ? () => setOpen((o) => !o) : undefined
  return (
    <div
      class={`cf-asked-cite ${long ? "long" : ""} ${open ? "open" : ""}`}
      role={long ? "button" : undefined}
      tabIndex={long ? 0 : undefined}
      aria-expanded={long ? open : undefined}
      onClick={toggle}
      onKeyDown={toggle && ((e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle() } })}
    >
      <blockquote ref={ref} dir="auto">{text}</blockquote>
      {long && <span class="cf-asked-cite-more" aria-hidden="true"><Icon.Chevron /></span>}
    </div>
  )
}
