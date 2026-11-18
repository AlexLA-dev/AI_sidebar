// The list of fixes (2.7 (107)). The owner, on an iPhone and an iPad mini: a tap on an underlined word showed its card
// one time in ten, selected the word too (so the system's menu and our selection buttons lay over the card), and on the
// iPad mini the card came up behind the keyboard. So by touch nothing opens on the word. The field's button carries the
// number of mistakes and opens this list instead:
// - each fix with its sentence, «Исправить» and «Пропустить»; «Исправить все»; the last one made can be undone here;
// - it sits where a thumb reaches and the keyboard doesn't: at the bottom of what's visible (right above the keyboard
//   when it's up), or above the field when the field itself is there (a chat's box sits on the keyboard);
// - the field keeps the focus it had (the keyboard neither comes nor goes), and a selection in it is let go first, so
//   the system's menu is never over the list.
// With a pointer the same list opens from the circle's menu, beside the field.

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import { snippetOf, type Issue } from "../../shared/writing"
import { listenAround } from "../around"
import * as Icon from "../icons"
import type { Field } from "./field"
import * as QIcon from "./icons"
import { follow, placeBeside, placeByCaret, placeFixes } from "./place"
import { viewport } from "./watch"

interface Props {
  field: Field
  touch: boolean
  issues: Issue[]
  // The fix the list was opened at (a tap on its word), brought into view and lit.
  at: string | null
  // The last fix made here: «Исправлено · Отменить» at the list's foot.
  made: string | null
  onFix: (issue: Issue) => void
  onFixAll: () => void
  onSkip: (issue: Issue) => void
  onUndo: () => void
  // A row touched: its underline is lit in the field.
  onLit: (key: string | null) => void
  // Where a fix's words are on screen (fixed coordinates), when they're in sight.
  where: (issue: Issue) => DOMRect | null
  onClose: () => void
  // Quick insert's own list (the button opens the fixes while there are any): by touch only.
  onList: (() => void) | null
}

export function FixList(p: Props): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return follow(el, () => {
      if (p.touch) return placeFixes(el, p.field)
      if (placeBeside(el, p.field, p.touch, 360, 420)) return
      el.style.maxHeight = `${Math.min(420, viewport(p.touch).height - 16)}px`
      placeByCaret(el, p.field, p.touch, 360)
    })
  })

  // Opened at a fix, or a row touched: its row in view, and its words in the field out from under the list.
  useEffect(() => {
    const issue = p.at ? p.issues.find((i) => i.key === p.at) : null
    if (!issue) return
    const row = Array.from(body.current?.children ?? []).find((c) => (c as HTMLElement).dataset.key === p.at) as HTMLElement | undefined
    row?.scrollIntoView?.({ block: "nearest" })
    const box = ref.current?.getBoundingClientRect()
    const words = p.where(issue)
    if (!box || !words || !p.touch) return
    const vp = viewport(true)
    // Under the list (it's at the bottom, over a tall field's lower part): the page moves up; cut off at the top: down.
    if (ref.current?.dataset.at === "bottom" && words.bottom > box.top - 10) window.scrollBy({ top: words.bottom - box.top + 28, behavior: "smooth" })
    else if (words.top < vp.dy + 8) window.scrollBy({ top: words.top - vp.dy - 28, behavior: "smooth" })
  }, [p.at])

  // A press outside closes it; one in the field doesn't (the caret may be put in another underlined word).
  useEffect(() => {
    let stop = () => {}
    const timer = setTimeout(() => {
      const box = ref.current
      if (box) stop = listenAround(box, "pointerdown", (_, path) => !path.includes(box) && !path.includes(p.field.el) && p.onClose())
    }, 50)
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [p.onClose, p.field.el])

  return (
    <div
      ref={ref}
      class={`cf-qi cf-fx ${p.touch ? "" : "suggest"}`}
      role="dialog"
      aria-label={t("writeFixes", p.issues.length)}
      // The field keeps its focus and its caret.
      onPointerDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") p.onClose()
      }}
    >
      <div class="cf-fx-head">
        <span class="cf-fx-count"><Icon.Sparkle size={14} /> {t("writeFixes", p.issues.length)}</span>
        {p.issues.length > 1 && <button type="button" class="cf-fx-all" onClick={p.onFixAll}>{t("writeFixAll")}</button>}
        {p.onList && (
          <button type="button" class="cf-qi-x cf-fx-list" aria-label={t("qiTitle")} title={t("qiTitle")} onClick={p.onList}><QIcon.Insert size={18} /></button>
        )}
        <button type="button" class="cf-qi-x" aria-label={t("close")} title={t("close")} onClick={p.onClose}><Icon.Close /></button>
      </div>
      <div ref={body} class="cf-fx-body" role="list">
        {p.issues.map((issue) => {
          const s = snippetOf(issue.para, issue.rel)
          return (
            <div key={issue.key} data-key={issue.key} class={`cf-fx-row ${p.at === issue.key ? "on" : ""}`} role="listitem">
              {/* The sentence: a touch lights its underline in the field. */}
              <div class="cf-fx-text" dir="auto" onPointerDown={() => p.onLit(issue.key)}>
                {s.cutBefore && "…"}{s.before}
                {s.was && <del>{s.was}</del>}
                {s.now && <ins>{s.now}</ins>}
                {s.after}{s.cutAfter && "…"}
              </div>
              <div class="cf-fx-acts">
                <button type="button" class="cf-primary" onClick={() => p.onFix(issue)}>{t("writeFix")}</button>
                <button type="button" class="cf-fx-skip" onClick={() => p.onSkip(issue)}>{t("writeSkip")}</button>
              </div>
            </div>
          )
        })}
      </div>
      {p.made && (
        <div class="cf-fx-foot" role="status">
          <span><Icon.Check /> {p.made}</span>
          <button type="button" onClick={p.onUndo}>{t("writeUndo")}</button>
        </div>
      )}
    </div>
  )
}
