import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../shared/i18n"
import { cleanTag, MAX_TAG, tagColor } from "../shared/threads"
import * as Icon from "./icons"

/** A tag as a small coloured chip; `onClick` makes it a button (a filter, or open the editor). */
export function TagChip({ tag, active, onClick }: { tag: string; active?: boolean; onClick?: (e: MouseEvent) => void }): VNode {
  const cls = `cf-tag c${tagColor(tag)} ${active ? "active" : ""}`
  return onClick
    ? <button type="button" class={cls} aria-pressed={active} onClick={onClick}>#{tag}</button>
    : <span class={cls}>#{tag}</span>
}

/**
 * Picks the tags of a chat, an answer or a note: the tags in use as chips to switch on and off, and
 * a field for a new one (Enter adds it). Closes on Done, Escape or a press outside.
 */
export function TagEditor({ tags, known, onChange, onClose }: {
  tags: string[]
  known: string[]
  onChange: (tags: string[]) => void
  onClose: () => void
}): VNode {
  const [draft, setDraft] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const has = (tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase())
  const toggle = (tag: string) => onChange(has(tag) ? tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...tags, tag])
  const add = () => {
    const tag = cleanTag(draft)
    if (tag && !has(tag)) onChange([...tags, tag])
    setDraft("")
  }

  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    const root = ref.current?.getRootNode()
    if (!root) return
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    root.addEventListener("pointerdown", close, true)
    return () => root.removeEventListener("pointerdown", close, true)
  }, [onClose])

  const all = [...tags, ...known.filter((k) => !has(k))]
  const typed = cleanTag(draft).toLowerCase()
  const shown = typed ? all.filter((tag) => tag.toLowerCase().includes(typed)) : all

  return (
    <div class="cf-tag-editor" ref={ref} role="dialog" aria-label={t("tagsTitle")} onClick={(e) => e.stopPropagation()}>
      <div class="cf-tag-editor-title">{t("tagsTitle")}</div>
      {shown.length > 0 && (
        <div class="cf-tag-list">
          {shown.map((tag) => <TagChip key={tag} tag={tag} active={has(tag)} onClick={() => toggle(tag)} />)}
        </div>
      )}
      <form
        class="cf-tag-new"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          ref={input}
          value={draft}
          maxLength={MAX_TAG + 1}
          placeholder={t("tagsNew")}
          aria-label={t("tagsNew")}
          enterkeyhint="done"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // The page must not see these keys; Escape closes the editor, not the panel.
            e.stopPropagation()
            if (e.key === "Escape") {
              e.preventDefault()
              onClose()
            }
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyPress={(e) => e.stopPropagation()}
        />
        <button type="submit" class="cf-icon" disabled={!cleanTag(draft)} aria-label={t("tagsAdd")} title={t("tagsAdd")}><Icon.Plus /></button>
      </form>
      <button type="button" class="cf-link cf-tag-done" onClick={onClose}>{t("tagsDone")}</button>
    </div>
  )
}
