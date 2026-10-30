import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t, uiLanguage } from "../shared/i18n"
import { activity, MAX_TITLE, threadName, threadNotes, threadPages, threadSnippet, threadTitle, type Thread } from "../shared/threads"
import * as Icon from "./icons"

interface Props {
  threads: Thread[] // pinned first, then the newest
  activeId: string
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onPin: (id: string, pinned: boolean) => void
  onMove: (id: string, index: number) => void // to `index` among the pinned chats
  onOpenPage: (url: string) => void
}

/** "3 pages", in the UI language's plural form. */
function pagesLabel(count: number): string {
  const rule = new Intl.PluralRules(uiLanguage()).select(count)
  return t(rule === "one" || rule === "few" || rule === "many" ? `pages_${rule}` : "pages_other", count)
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** "5 min ago", "yesterday", or a date for older chats. */
function when(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(uiLanguage(), { numeric: "auto" })
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute")
  if (minutes < 24 * 60) return rtf.format(-Math.round(minutes / 60), "hour")
  if (minutes < 7 * 24 * 60) return rtf.format(-Math.round(minutes / (24 * 60)), "day")
  return new Date(at).toLocaleDateString(uiLanguage(), { day: "numeric", month: "short" })
}

/** The chat's name in place, being edited: Enter (or leaving the field) keeps it, Escape doesn't. */
function NameField({ thread, onDone }: { thread: Thread; onDone: (name: string | null) => void }): VNode {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(threadName(thread))
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <form class="cf-thread-main editing" onSubmit={(e) => { e.preventDefault(); finish(value) }}>
      <input
        ref={ref}
        class="cf-thread-name"
        value={value}
        maxLength={MAX_TITLE}
        placeholder={threadTitle(thread.m)}
        aria-label={t("chatName")}
        enterkeyhint="done"
        onInput={(e) => setValue(e.currentTarget.value)}
        onBlur={() => finish(value)}
        onKeyDown={(e) => {
          // The page must not see these keys; Escape cancels the edit, not the panel.
          e.stopPropagation()
          if (e.key === "Escape") {
            e.preventDefault()
            finish(null)
          }
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
      />
      <span class="cf-thread-meta">{t("chatNameHint")}</span>
    </form>
  )
}

interface Drag {
  id: string
  from: number
  to: number
  dy: number
  startY: number
  rows: Array<{ top: number; height: number }> // the pinned rows when the drag began
}

/**
 * The list of chats (threads): open one to continue it from this page, rename, pin or delete it, or
 * start a new one. Pinned chats come first and are reordered by dragging their handle; a chat that
 * was on several pages lists them (each opens its page).
 */
export function ThreadsView({ threads, activeId, onOpen, onRename, onDelete, onNew, onPin, onMove, onOpenPage }: Props): VNode {
  const [editing, setEditing] = useState<string | null>(null)
  const [pagesOf, setPagesOf] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  // The page list closes on any press outside it (its own chip toggles it).
  useEffect(() => {
    const root = pop.current?.getRootNode()
    if (!pagesOf || !root) return
    const close = (e: Event) => {
      const target = e.target as Element
      if (!pop.current?.contains(target) && !target.closest?.(".cf-pages-chip")) setPagesOf(null)
    }
    root.addEventListener("pointerdown", close, true)
    return () => root.removeEventListener("pointerdown", close, true)
  }, [pagesOf])

  if (threads.length === 0) {
    return (
      <div class="cf-threads">
        <div class="cf-empty">
          <div class="cf-empty-icon"><Icon.Chats /></div>
          <p>{t("chatsEmpty")}</p>
          <button type="button" class="cf-primary" onClick={onNew}><Icon.Plus /> {t("newChat")}</button>
        </div>
      </div>
    )
  }

  const pinned = threads.filter((th) => th.pin !== undefined)
  const startDrag = (e: PointerEvent, id: string, from: number) => {
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const measured = pinned.map((th) => rows.current.get(th.id)?.getBoundingClientRect() ?? { top: 0, height: 0 })
    setDrag({ id, from, to: from, dy: 0, startY: e.clientY, rows: measured.map((r) => ({ top: r.top, height: r.height })) })
  }
  const moveDrag = (e: PointerEvent) => {
    if (!drag) return
    const dy = e.clientY - drag.startY
    const own = drag.rows[drag.from]
    const center = own.top + own.height / 2 + dy
    const to = drag.rows.filter((r, i) => i !== drag.from && r.top + r.height / 2 < center).length
    setDrag({ ...drag, dy, to })
  }
  const endDrag = () => {
    if (drag && drag.to !== drag.from) onMove(drag.id, drag.to)
    setDrag(null)
  }
  // While dragging: the dragged row follows the finger, the rows it passes make room.
  const shift = (index: number): number => {
    if (!drag || index >= pinned.length) return 0
    if (index === drag.from) return drag.dy
    const h = drag.rows[drag.from].height
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -h
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return h
    return 0
  }

  return (
    <div class="cf-threads" role="list">
      {threads.map((thread, index) => {
        const pages = threadPages(thread.m)
        const notes = threadNotes(thread.m)
        const isPinned = thread.pin !== undefined
        const dy = shift(index)
        return (
          <div
            key={thread.id}
            ref={(el) => { if (el) rows.current.set(thread.id, el); else rows.current.delete(thread.id) }}
            role="listitem"
            class={`cf-thread ${thread.id === activeId ? "current" : ""} ${drag?.id === thread.id ? "dragging" : ""} ${drag && drag.id !== thread.id ? "making-room" : ""}`}
            style={dy ? { transform: `translateY(${dy}px)` } : undefined}
          >
            {editing === thread.id ? (
              <NameField
                thread={thread}
                onDone={(name) => {
                  setEditing(null)
                  if (name !== null) onRename(thread.id, name)
                }}
              />
            ) : (
              <>
                {isPinned && (
                  <span
                    class="cf-thread-grip"
                    role="button"
                    tabIndex={0}
                    aria-label={t("reorderChat")}
                    title={t("reorderChat")}
                    onPointerDown={(e) => startDrag(e, thread.id, index)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" && index > 0) onMove(thread.id, index - 1)
                      else if (e.key === "ArrowDown" && index < pinned.length - 1) onMove(thread.id, index + 1)
                      else return
                      e.preventDefault()
                    }}
                  >
                    <Icon.Grip />
                  </span>
                )}
                <div
                  class="cf-thread-main"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(thread.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
                    e.preventDefault()
                    onOpen(thread.id)
                  }}
                >
                  <span class="cf-thread-title">{threadName(thread)}</span>
                  <span class="cf-thread-snippet">{threadSnippet(thread.m)}</span>
                  <span class="cf-thread-meta">
                    {notes > 0 && (
                      <span class="cf-thread-notes" title={t("chatNotes")} aria-label={t("chatNotes")}><Icon.Pencil />{notes}</span>
                    )}
                    {pages.length > 1 ? (
                      <button
                        type="button"
                        class="cf-pages-chip"
                        aria-expanded={pagesOf === thread.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPagesOf(pagesOf === thread.id ? null : thread.id)
                        }}
                      >
                        {pagesLabel(pages.length)}
                      </button>
                    ) : (
                      pages.length === 1 && <span class="cf-thread-site">{host(pages[0].url)}</span>
                    )}
                    <span class="cf-thread-when">{when(activity(thread))}</span>
                  </span>
                </div>
                <button type="button" class={`cf-icon cf-thread-tool ${isPinned ? "on" : ""}`} onClick={() => onPin(thread.id, !isPinned)} aria-pressed={isPinned} aria-label={t(isPinned ? "unpinChat" : "pinChat")} title={t(isPinned ? "unpinChat" : "pinChat")}>
                  <Icon.Pin filled={isPinned} />
                </button>
                <button type="button" class="cf-icon cf-thread-tool" onClick={() => setEditing(thread.id)} aria-label={t("renameChat")} title={t("renameChat")}>
                  <Icon.Pencil />
                </button>
                <button type="button" class="cf-icon cf-thread-tool cf-thread-delete" onClick={() => onDelete(thread.id)} aria-label={t("deleteChat")} title={t("deleteChat")}>
                  <Icon.Trash />
                </button>
              </>
            )}
            {pagesOf === thread.id && (
              <div class="cf-pages-pop" ref={pop} role="menu" aria-label={t("chatPages")}>
                <div class="cf-pages-pop-title">{t("chatPages")}</div>
                {pages.map((page) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={page.url}
                    class="cf-pages-item"
                    title={t("openPage")}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPagesOf(null)
                      onOpenPage(page.url)
                    }}
                  >
                    <span class="cf-pages-item-title">{page.title || host(page.url)}</span>
                    <span class="cf-pages-item-host">{host(page.url)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
