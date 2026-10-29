import type { VNode } from "preact"

import { t, uiLanguage } from "../shared/i18n"
import { threadSite, threadSnippet, threadTitle, type Thread } from "../shared/threads"
import * as Icon from "./icons"

interface Props {
  threads: Thread[] // newest first
  activeId: string
  onOpen: (id: string) => void
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

/** The list of chats (threads): open one to continue it from this page, or start a new one. */
export function ThreadsView({ threads, activeId, onOpen, onDelete, onNew }: Props): VNode {
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
          <button type="button" class="cf-thread-main" onClick={() => onOpen(thread.id)}>
            <span class="cf-thread-title">{threadTitle(thread.m)}</span>
            <span class="cf-thread-snippet">{threadSnippet(thread.m)}</span>
            <span class="cf-thread-meta">{[threadSite(thread.m), when(thread.u)].filter(Boolean).join(" · ")}</span>
          </button>
          <button type="button" class="cf-icon cf-thread-delete" onClick={() => onDelete(thread.id)} aria-label={t("deleteChat")} title={t("deleteChat")}>
            <Icon.Trash />
          </button>
        </div>
      ))}
    </div>
  )
}
