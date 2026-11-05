// Page watch (2.5, the owner's notes on build 75): watching's own windows, drawn over the page in the panel's root,
// in the same look as chat UX's sheets, so App and the "Come back later…" window stay as they are.
// - The eye opens watching alone. The eye is "tell me when it changes", the bell "bring me back at a time": the eye's
//   window shows no Remind (that stays in the panel's "…" and with the bell).
// - A watch from the list: what it waits for, whole, the value now; the words can be changed, the watch stopped.

import { render, type ComponentChildren, type VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { ConsentCard } from "../Consent"
import { giveConsent, loadConsent } from "../store"
import { conditionLine, shown } from "../../shared/watch/line"
import type { WatchHow } from "../../shared/watch/messages"
import type { Watch } from "../../shared/watch/types"
import { panelRoot } from "../root"
import { Eye } from "./icons"
import { ago } from "./list"
import { grow, WatchSection } from "./WatchSection"

export interface WatchSheetProps {
  url: string
  title: string
  // The value to watch: the selection, or the price around a selected number ("USD 40"); null: the whole page.
  selection: string | null
  how: WatchHow
  // A page the background can't read: "Remind me to look" (the whole page's window, from the header's "…").
  remind?: () => void
}

let layer: HTMLDivElement | null = null

/** Draws a window in the panel's root, with the panel's theme (light or dark, text size, touch). */
function show(make: (close: () => void) => VNode): void {
  const root = panelRoot()
  if (!root) return
  if (!layer || !layer.isConnected) {
    layer = document.createElement("div")
    root.appendChild(layer)
  }
  const panel = root.querySelector(".cf")
  layer.className = "cf"
  for (const name of ["data-theme", "data-size", "data-touch"]) {
    const value = panel?.getAttribute(name)
    if (value) layer.setAttribute(name, value)
    else layer.removeAttribute(name)
  }
  const target = layer
  const close = () => render(null, target)
  render(make(close), target)
}

/**
 * Watching alone: the eye's window (a value), or the whole page's ("Watch this page…" in the header's "…"). The eye
 * passes no `remind`: a site the background can't read offers checking when the page is open, not a reminder; the
 * whole page offers "Remind me to look" too, as its section did in "Come back later".
 */
export function openWatchSheet(p: WatchSheetProps): void {
  show((close) => (
    <Sheet label={t("watchSection")} close={close}>
      <WatchSection url={p.url} title={p.title} selection={p.selection} how={p.how} close={close} remind={p.remind && (() => {
        close()
        p.remind?.()
      })} />
    </Sheet>
  ))
}

/** A watch from the list: its words in full, the value now, change the words or stop it. */
export function openWatchEdit(w: Watch, changed: () => void): void {
  show((close) => <WatchEdit watch={w} close={close} changed={changed} />)
}

function Sheet({ label, close, children }: { label: string; close(): void; children: ComponentChildren }): VNode {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close()
    document.addEventListener("keydown", esc, true)
    return () => document.removeEventListener("keydown", esc, true)
  }, [])
  return (
    <div class="cf-sheet-back page" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="cf-sheet cf-watch-sheet" role="dialog" aria-label={label}>{children}</div>
    </div>
  )
}

/** Where it stands: checked when, checked when the page opens, or changed. */
function status(w: Watch): string {
  if (w.metAt) return w.metValue && w.what !== "page" ? t("watchRowMetNow", w.label, shown(w.metValue), ago(w.metAt)) : t("watchRowMet", w.label, ago(w.metAt))
  if (w.mode === "live") return t("watchRowLive", w.label)
  return w.checks > 0 ? t("watchRow", w.label, ago(w.checkedAt)) : t("watchRowNew", w.label)
}

const send = <T,>(message: unknown) => chrome.runtime.sendMessage(message) as Promise<T>

function WatchEdit({ watch, close, changed }: { watch: Watch; close(): void; changed(): void }): VNode {
  const [w, setW] = useState(watch)
  const [words, setWords] = useState(watch.condition)
  const [state, setState] = useState<"edit" | "saving" | "failed" | "consent" | "consent-again">("edit")
  const save = async () => {
    // New words go to the AI: without the consent, the one card here first.
    const consent = await loadConsent()
    if (consent !== "ok") return setState(consent === "old" ? "consent-again" : "consent")
    setState("saving")
    const reply = await send<{ ok: boolean; watch?: Watch }>({ type: "watchEdit", id: w.id, condition: words }).catch(() => null)
    if (!reply?.ok || !reply.watch) return setState("failed")
    setW(reply.watch)
    setState("edit")
    changed()
    close()
  }
  // One stop, however many times the button is pressed while it goes.
  const stopping = useRef(false)
  const stop = async () => {
    if (stopping.current) return
    stopping.current = true
    await send({ type: "watchCancel", id: w.id, via: "list" }).catch(() => undefined)
    changed()
    close()
  }
  const dirty = words.trim() && words.trim() !== w.condition.trim()
  return (
    <Sheet label={t("watchSection")} close={close}>
      <section class="cf-watch cf-watch-edit">
        <div class="cf-sheet-title cf-watch-h"><Eye size={16} /> {w.title || w.host}</div>
        <p class="cf-watch-msg">{conditionLine(w)}</p>
        <p class="cf-watch-note">{status(w)}</p>
        <label class="cf-watch-l" for="cf-watch-edit">{t("watchWhen")}</label>
        <textarea id="cf-watch-edit" class="cf-watch-cond" rows={2} maxLength={300} value={words} disabled={state === "saving"} ref={grow} onInput={(e) => {
          setWords(e.currentTarget.value)
          grow(e.currentTarget)
        }} />
        {state === "failed" && <p class="cf-watch-msg">{t("watchFailed")}</p>}
        {(state === "consent" || state === "consent-again") && (
          <ConsentCard again={state === "consent-again"} onAccept={() => void giveConsent().then(save)} onDecline={() => setState("edit")} />
        )}
        <div class="cf-sheet-actions">
          <button type="button" class="cf-primary" disabled={!dirty || state === "saving"} onClick={() => void save()}>
            {state === "saving" ? t("watchChecking") : t("watchSave")}
          </button>
          <button type="button" class="cf-secondary cf-watch-stop" onClick={() => void stop()}>{t("watchStop")}</button>
        </div>
      </section>
    </Sheet>
  )
}
