// Page watch (2.5): "Notify me when it changes" in the "Come back later…" window (the window is chat UX's;
// this is its second part). The condition in the person's own words, started from the selection, an honest
// line about when the checks run, and, for a site the background can't read, the choice to check when the
// page is opened or to be reminded instead (the window's first part, ctx.remind()).

import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { TARGET } from "../../shared/config"
import { t } from "../../shared/i18n"
import { conditionLine } from "../../shared/watch/line"
import { WATCH_LIMIT, type WatchDraft, type WatchHow, type WatchPrepared } from "../../shared/watch/messages"
import { ConsentCard } from "../Consent"
import { giveConsent, loadConsent } from "../store"
import { NoteWords, SheetClose } from "../ux/MessageUx"
import { draftFor } from "./draft"
import { Eye } from "./icons"
import { detectPlatform, isTouch, openAppFromTap } from "../page"

export interface WatchSectionProps {
  url: string
  title: string
  selection: string | null
  how: WatchHow
  // Made elsewhere (an item from Find similar): this tab's page isn't the one watched.
  draft?: WatchDraft
  close(): void
  // "Remind me to look" for a site the background can't read: chat UX's part of the same window.
  remind?: () => void
  // The watch is set and nothing is left to read here: the window goes, and "Watching: …" says what's watched and on
  // what condition (2.6.1: "Watching." in the window was missed). Without it, the window says it and closes itself.
  saved?: (line: string) => void
}

type State =
  | { at: "edit" }
  | { at: "checking" }
  | { at: "unreadable"; prepared: WatchPrepared }
  // `notify`: "ok", "denied" (off in Settings) or "not-asked" (the system never asked: the window says why and asks).
  | { at: "set"; live: boolean; notify: string; line: string; asking?: boolean }
  // The owner's limit: Free 5 at once, Pro 20.
  | { at: "full"; limit: number; paid: boolean; ultra: boolean }
  | { at: "failed" }
  // The AI reads the words: without the consent, the one card here first (2.5 (81): never a silent watch whose words
  // nobody reads).
  | { at: "consent"; again: boolean }

const send = <T,>(message: unknown) => chrome.runtime.sendMessage(message) as Promise<T>

/** A field as tall as its words (a few lines at most, then it scrolls). */
export function grow(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${Math.min(el.scrollHeight + 2, 132)}px`
}

export function WatchSection(p: WatchSectionProps) {
  // Read once, when the window opens: the page may change under the person while they type.
  const draft = useMemo(() => p.draft ?? draftFor(p.url, p.title, p.selection), [p.url, p.selection, p.draft])
  const [condition, setCondition] = useState(draft.condition)
  // The person's own note (2.6 (97)), optional: Watch saves without it.
  const [note, setNote] = useState("")
  // Where the window was opened from, as it was when it opened (the window may render again meanwhile).
  const [how] = useState(p.how)
  const [state, setState] = useState<State>({ at: "edit" })
  const closing = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(closing.current), [])

  // The watch is set: the window goes, saying what's watched and on what condition.
  const done = (line: string) => {
    if (p.saved) return p.saved(line)
    closing.current = setTimeout(p.close, 1800)
  }

  // `value`: what the background read itself (the watch keeps it), else the page's own.
  const save = async (prepared: WatchPrepared & { value?: string | null }, live: boolean) => {
    const reply = await send<{ ok: boolean; full?: boolean; limit?: number; paid?: boolean; plan?: string; notify?: string }>({ type: "watchSave", draft: { ...draft, condition }, prepared, how, live, ...(note.trim() ? { note: note.trim() } : {}) }).catch(() => null)
    if (!reply?.ok) return setState(reply?.full ? { at: "full", limit: reply.limit ?? 5, paid: reply.paid === true, ultra: reply.plan === "ultra" } : { at: "failed" })
    // "Watching: when it drops below $750 · now $799.99", as the Watching list says it.
    const watched = conditionLine({ what: prepared.what, condition, value: prepared.value ?? draft.value, label: prepared.label })
    const line = t(live ? "watchRowLive" : "watchRowNew", watched)
    const notify = reply.notify ?? "ok"
    setState({ at: "set", live, notify, line })
    if (notify === "ok") done(line)
  }

  // "Turn on notifications" under a set watch: only now the system's question (never in the middle of Watch).
  const askNotify = async (set: Extract<State, { at: "set" }>) => {
    if (set.asking) return
    setState({ ...set, asking: true })
    const reply = await send<{ notify?: string }>({ type: "watchNotifyAsk" }).catch(() => null)
    if (reply?.notify === "denied") return setState({ ...set, notify: "denied", asking: false })
    done(set.line)
  }

  const start = async () => {
    const consent = await loadConsent()
    if (consent !== "ok") return setState({ at: "consent", again: consent === "old" })
    setState({ at: "checking" })
    const prepared = await send<WatchPrepared & { ok?: boolean; value?: string | null }>({ type: "watchPrepare", draft: { ...draft, condition }, how }).catch(() => null)
    if (!prepared?.ok) return setState({ at: "failed" })
    if (!prepared.readable) return setState({ at: "unreadable", prepared })
    await save(prepared, false)
  }

  return (
    <section class="cf-watch" aria-label={t("watchSection")}>
      {/* The eye beside the title, as the bell beside Remind: the same class and size. */}
      <div class="cf-sheet-title cf-watch-h"><Eye size={16} /> {t("watchSection")}<SheetClose onClose={p.close} /></div>
      {(state.at === "edit" || state.at === "checking" || state.at === "failed" || state.at === "full" || state.at === "consent") && (
        <>
          <label class="cf-watch-l" for="cf-watch-cond">{t("watchWhen")}</label>
          {/* Whole, on as many lines as it takes (the owner, build 75: a cut line hid the price set). */}
          <textarea
            id="cf-watch-cond"
            class="cf-watch-cond"
            dir="auto"
            rows={2}
            value={condition}
            maxLength={300}
            disabled={state.at === "checking"}
            ref={grow}
            onInput={(e) => {
              setCondition(e.currentTarget.value)
              grow(e.currentTarget)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing && condition.trim()) {
                e.preventDefault()
                void start()
              }
            }}
          />
          <NoteWords watch value={note} onInput={setNote} />
          <p class="cf-watch-note">{t("watchHonest")}</p>
          {state.at === "failed" && <p class="cf-watch-msg">{t("watchFailed")}</p>}
          {state.at === "full" && <p class="cf-watch-msg">{state.ultra || (state.paid && TARGET !== "safari") ? t("watchFull", state.limit) : state.paid ? t("watchFullPro", state.limit, WATCH_LIMIT.ultra) : t("watchFullFree", state.limit, WATCH_LIMIT.paid)}</p>}
          {/* The section's main button stays in view over the question field (chat UX's sheet row). With every
              watch taken, Pro is the way on (Free) or there's nothing to press (Pro). */}
          {state.at === "consent" ? (
            <ConsentCard again={state.again} onAccept={() => void giveConsent().then(start)} onDecline={() => setState({ at: "edit" })} />
          ) : state.at === "full" ? (
            !state.ultra && (!state.paid || TARGET === "safari") && (
              <div class="cf-sheet-actions">
                {/* 2.6: on Free, Pro (20 pages); on Pro or Own key, Ultra (50). */}
                <button type="button" class="cf-primary" onClick={() => openAppFromTap(isTouch(detectPlatform(TARGET)), { target: "subscribe", feature: "watch", plan: state.paid ? "ultra" : "pro" })}>{state.paid ? t("watchMoreUltra") : t("watchMore")}</button>
              </div>
            )
          ) : (
            <div class="cf-sheet-actions">
              <button type="button" class="cf-primary" disabled={state.at === "checking" || !condition.trim()} onClick={() => void start()}>
                {state.at === "checking" ? t("watchChecking") : t("watchStart")}
              </button>
            </div>
          )}
        </>
      )}
      {state.at === "unreadable" && (
        <>
          <p class="cf-watch-msg">{t("watchUnreadable")}</p>
          <div class="cf-sheet-actions">
            <button type="button" class="cf-primary" onClick={() => void save(state.prepared, true)}>{t("watchLiveOk")}</button>
            {p.remind && <button type="button" class="cf-secondary" onClick={p.remind}>{t("watchRemindInstead")}</button>}
          </div>
        </>
      )}
      {state.at === "set" && (
        <>
          <p class="cf-watch-msg cf-watch-ok">{t(state.live ? "watchSetLive" : "watchSet")}</p>
          {/* Turned off: the one text Remind shows too. */}
          {state.notify === "denied" && <p class="cf-watch-note">{t("uxRemindOff")}</p>}
          {/* Never asked: why, then the system's question on a tap (2.6.1: it came in the middle of the first Watch). */}
          {state.notify === "not-asked" && (
            <>
              <p class="cf-watch-note">{t("watchNotifyWhy")}</p>
              <div class="cf-sheet-actions">
                <button type="button" class="cf-primary cf-watch-notify" disabled={state.asking} onClick={() => void askNotify(state)}>{t("listenNotifyOn")}</button>
                <button type="button" class="cf-secondary" disabled={state.asking} onClick={() => done(state.line)}>{t("listenNotifyLater")}</button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
