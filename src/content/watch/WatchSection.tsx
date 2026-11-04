// Page watch (2.5): "Notify me when it changes" in the "Come back later…" window (the window is chat UX's;
// this is its second part). The condition in the person's own words, started from the selection, an honest
// line about when the checks run, and, for a site the background can't read, the choice to check when the
// page is opened or to be reminded instead.

import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import type { WatchHow, WatchPrepared } from "../../shared/watch/messages"
import { WATCH_MAX } from "../../shared/watch/types"
import { draftFor } from "./draft"

export interface WatchSectionProps {
  url: string
  title: string
  selection: string | null
  how: WatchHow
  close(): void
  // "Remind me to look" for a site the background can't read: chat UX's part of the same window.
  remind?: () => void
}

type State =
  | { at: "edit" }
  | { at: "checking" }
  | { at: "unreadable"; prepared: WatchPrepared }
  | { at: "set"; live: boolean; notify: string }
  | { at: "full" }
  | { at: "failed" }

const send = <T,>(message: unknown) => chrome.runtime.sendMessage(message) as Promise<T>

export function WatchSection(p: WatchSectionProps) {
  // Read once, when the window opens: the page may change under the person while they type.
  const draft = useMemo(() => draftFor(p.url, p.title, p.selection), [p.url, p.selection])
  const [condition, setCondition] = useState(draft.condition)
  const [state, setState] = useState<State>({ at: "edit" })
  const closing = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(closing.current), [])

  const save = async (prepared: WatchPrepared, live: boolean) => {
    const reply = await send<{ ok: boolean; full?: boolean; notify?: string }>({ type: "watchSave", draft: { ...draft, condition }, prepared, how: p.how, live }).catch(() => null)
    if (!reply?.ok) return setState(reply?.full ? { at: "full" } : { at: "failed" })
    setState({ at: "set", live, notify: reply.notify ?? "ok" })
    if ((reply.notify ?? "ok") === "ok") closing.current = setTimeout(p.close, 1800)
  }

  const start = async () => {
    setState({ at: "checking" })
    const prepared = await send<WatchPrepared & { ok?: boolean }>({ type: "watchPrepare", draft: { ...draft, condition } }).catch(() => null)
    if (!prepared?.ok) return setState({ at: "failed" })
    if (!prepared.readable) return setState({ at: "unreadable", prepared })
    await save(prepared, false)
  }

  return (
    <section class="cf-watch" aria-label={t("watchSection")}>
      <h3 class="cf-watch-h">{t("watchSection")}</h3>
      {(state.at === "edit" || state.at === "checking" || state.at === "failed" || state.at === "full") && (
        <>
          <label class="cf-watch-l" for="cf-watch-cond">{t("watchWhen")}</label>
          <input
            id="cf-watch-cond"
            class="cf-watch-cond"
            value={condition}
            maxLength={300}
            disabled={state.at === "checking"}
            onInput={(e) => setCondition(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing && condition.trim()) void start()
            }}
          />
          <p class="cf-watch-note">{t("watchHonest")}</p>
          {state.at === "failed" && <p class="cf-watch-msg">{t("watchFailed")}</p>}
          {state.at === "full" && <p class="cf-watch-msg">{t("watchFull", WATCH_MAX)}</p>}
          <button type="button" class="cf-watch-go" disabled={state.at === "checking" || !condition.trim()} onClick={() => void start()}>
            {state.at === "checking" ? t("watchChecking") : t("watchStart")}
          </button>
        </>
      )}
      {state.at === "unreadable" && (
        <>
          <p class="cf-watch-msg">{t("watchUnreadable")}</p>
          <div class="cf-watch-row">
            <button type="button" class="cf-watch-go" onClick={() => void save(state.prepared, true)}>{t("watchLiveOk")}</button>
            {p.remind && <button type="button" class="cf-watch-alt" onClick={p.remind}>{t("watchRemindInstead")}</button>}
          </div>
        </>
      )}
      {state.at === "set" && (
        <>
          <p class="cf-watch-msg cf-watch-ok">{t(state.live ? "watchSetLive" : "watchSet")}</p>
          {state.notify === "denied" && <p class="cf-watch-note">{t("watchNotifyOff")}</p>}
          {state.notify === "not-asked" && <p class="cf-watch-note">{t("watchNotifyAsk")}</p>}
        </>
      )}
    </section>
  )
}
