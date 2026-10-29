import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t, uiLanguage } from "../shared/i18n"
import { activity, MAX_TITLE, threadName, threadSite, threadSnippet, threadTitle, type Thread } from "../shared/threads"
import * as Icon from "./icons"

interface Props {
  threads: Thread[] // newest first
  activeId: string
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onNew: () => void
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

/** The list of chats (threads): open one to continue it from this page, rename it, or start a new one. */
export function ThreadsView({ threads, activeId, onOpen, onRename, onDelete, onNew }: Props): VNode {
  const [editing, setEditing] = useState<string | null>(null)
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
  return (
    <div class="cf-threads" role="list">
      {threads.map((thread) => (
        <div key={thread.id} role="listitem" class={`cf-thread ${thread.id === activeId ? "current" : ""}`}>
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
              <button type="button" class="cf-thread-main" onClick={() => onOpen(thread.id)}>
                <span class="cf-thread-title">{threadName(thread)}</span>
                <span class="cf-thread-snippet">{threadSnippet(thread.m)}</span>
                <span class="cf-thread-meta">{[threadSite(thread.m), when(activity(thread))].filter(Boolean).join(" · ")}</span>
              </button>
              <button type="button" class="cf-icon cf-thread-tool" onClick={() => setEditing(thread.id)} aria-label={t("renameChat")} title={t("renameChat")}>
                <Icon.Pencil />
              </button>
              <button type="button" class="cf-icon cf-thread-tool cf-thread-delete" onClick={() => onDelete(thread.id)} aria-label={t("deleteChat")} title={t("deleteChat")}>
                <Icon.Trash />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
