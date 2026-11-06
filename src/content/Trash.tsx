import type { VNode } from "preact"
import { useState } from "preact/hooks"

import { t, uiLanguage } from "../shared/i18n"
import { threadName, trashDaysLeft, type Thread } from "../shared/threads"

interface Props {
  threads: Thread[] // in Recently Deleted, the last one deleted first
  onRestore: (id: string) => void
  onDelete: (id: string) => void
  onDeleteAll: () => void
}

/** "29 days", in the UI language's plural form: how long until the chat is deleted for good. */
function daysLabel(count: number): string {
  const rule = new Intl.PluralRules(uiLanguage()).select(count)
  return t(rule === "one" || rule === "few" || rule === "many" ? `trashDays_${rule}` : "trashDays_other", count)
}

/**
 * Recently Deleted (2.5 (83), the owner: «надо сделать … Trash, где до 30 дней пусть хранятся удаленные чаты»): the
 * chats deleted from the list, kept 30 days. Each can be restored (to its old place in the list) or deleted now;
 * Delete All asks first. The chats aren't opened from here, as in Apple's Recently Deleted.
 */
export function TrashView({ threads, onRestore, onDelete, onDeleteAll }: Props): VNode {
  const [asking, setAsking] = useState(false)
  const now = Date.now()
  return (
    <div class="cf-threads cf-trash">
      <div class="cf-trash-head">
        <p class="cf-trash-note">{t("trashNote")}</p>
        {!asking && threads.length > 0 && (
          <button type="button" class="cf-link danger" onClick={() => setAsking(true)}>{t("trashDeleteAll")}</button>
        )}
      </div>
      {asking && (
        <div class="cf-trash-confirm" role="alertdialog" aria-label={t("trashDeleteAll")}>
          <p>{t("trashDeleteAllAsk")}</p>
          <div class="cf-card-actions">
            <button type="button" class="cf-secondary danger" onClick={() => { setAsking(false); onDeleteAll() }}>{t("trashDeleteAll")}</button>
            <button type="button" class="cf-secondary" onClick={() => setAsking(false)}>{t("cancel")}</button>
          </div>
        </div>
      )}
      <div role="list" aria-label={t("trashTitle")}>
        {threads.map((thread) => (
          <div key={thread.id} role="listitem" class="cf-thread cf-trash-item">
            <div class="cf-thread-main">
              <span class="cf-thread-title">{threadName(thread)}</span>
              <span class="cf-thread-meta"><span class="cf-thread-when">{daysLabel(trashDaysLeft(thread, now))}</span></span>
            </div>
            <div class="cf-trash-actions">
              <button type="button" class="cf-secondary" onClick={() => onRestore(thread.id)}>{t("trashRestore")}</button>
              <button type="button" class="cf-secondary danger" onClick={() => onDelete(thread.id)}>{t("trashDeleteNow")}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
