// The AI's suggestion under an answer (2.7, plan section 3): a reminder or an event read out of the answer or the
// person's request («рейс 14 марта в 10:40», «напомни в пятницу забронировать отель»). The card shows what, when and
// where it goes; each can be changed, and nothing is written until Add is tapped. The device writes it (apple.ts).

import type { VNode } from "preact"
import { useState } from "preact/hooks"

import { type AppleItem, itemPast, validDate, validTime } from "../../shared/appleItems"
import { t } from "../../shared/i18n"
import { addWay, type AppleOutcome, type AppleStatus } from "./apple"
import { Bell, CalendarIcon, SheetClose } from "./MessageUx"

export type Draft = AppleItem & { list?: string; state?: "adding" | AppleOutcome }

export type CardState =
  | { step: "reading" }
  | { step: "ready"; items: Draft[] }
  | { step: "none" }
  | { step: "error"; code: string }

const zoneName = (tz: string) => tz.split("/").pop()?.replace(/_/g, " ") ?? tz

export function AddCard({ card, status, onChange, onAdd, onRetry, onClose }: {
  card: CardState
  status: AppleStatus | null
  onChange: (i: number, draft: Draft) => void
  onAdd: (i: number) => void
  onRetry: () => void
  onClose: () => void
}): VNode {
  return (
    <div class="cf-add-card" role="group" aria-label={t("appleTitle")}>
      <div class="cf-add-head">
        <CalendarIcon size={15} /> <span>{t("appleTitle")}</span>
        <SheetClose onClose={onClose} />
      </div>
      {card.step === "reading" && <div class="cf-add-note"><span class="cf-add-dots"><span /><span /><span /></span> {t("appleReading")}</div>}
      {card.step === "none" && <div class="cf-add-note">{t("appleNothing")}</div>}
      {card.step === "error" && (
        <div class="cf-add-note">
          {t("appleError")} <button type="button" class="cf-link" onClick={onRetry}>{t("appleRetry")}</button>
        </div>
      )}
      {card.step === "ready" && card.items.map((d, i) => <ItemRow key={i} draft={d} status={status} onChange={(next) => onChange(i, next)} onAdd={() => onAdd(i)} />)}
    </div>
  )
}

function ItemRow({ draft: d, status, onChange, onAdd }: { draft: Draft; status: AppleStatus | null; onChange: (d: Draft) => void; onAdd: () => void }): VNode {
  const [edited, setEdited] = useState(false)
  const way = addWay(status, d.kind)
  const done = d.state === "saved" || d.state === "app"
  const busy = d.state === "adding"
  const set = (patch: Partial<Draft>) => {
    setEdited(true)
    onChange({ ...d, ...patch, state: undefined })
  }
  const ready = d.title.trim() && (d.kind === "reminder" || validDate(d.date)) && (!d.time || validTime(d.time))
  const where = d.kind === "reminder"
    ? null
    : status?.platform === "ios" && way === "app" ? t("appleCalendarPick") : t("appleCalendarDefault")
  // Only an item still to add shows the warnings.
  const past = !done && itemPast(d)
  const guess = !done && !edited && d.confidence === "guess"
  return (
    <div class={`cf-add-item ${done ? "done" : ""}`}>
      <div class="cf-seg cf-add-kind" role="radiogroup">
        {(["reminder", "event"] as const).map((k) => (
          <button type="button" role="radio" aria-checked={d.kind === k} class={d.kind === k ? "on" : ""} disabled={done || busy} onClick={() => set({ kind: k })}>
            {k === "reminder" ? <Bell size={13} /> : <CalendarIcon size={13} />} {t(k === "reminder" ? "appleReminder" : "appleEvent")}
          </button>
        ))}
      </div>
      <input
        class="cf-add-title"
        dir="auto"
        value={d.title}
        maxLength={120}
        disabled={done || busy}
        aria-label={t("appleWhat")}
        onInput={(e) => set({ title: e.currentTarget.value })}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div class={`cf-add-when ${guess ? "guess" : ""}`}>
        <input type="date" value={d.date ?? ""} disabled={done || busy} aria-label={t("appleDate")} onInput={(e) => set({ date: e.currentTarget.value || undefined })} />
        <input type="time" value={d.time ?? ""} disabled={done || busy || !d.date} aria-label={t("appleTime")} onInput={(e) => set({ time: e.currentTarget.value || undefined })} />
        {d.tz && <span class="cf-add-zone">{zoneName(d.tz)}</span>}
      </div>
      {d.location && <div class="cf-add-meta" dir="auto">{d.location}</div>}
      {d.kind === "reminder" && status?.lists?.length ? (
        <select class="cf-add-list" value={d.list ?? status.defaultList ?? ""} disabled={done || busy} aria-label={t("appleList")} onChange={(e) => set({ list: e.currentTarget.value })}>
          {status.lists.map((l) => <option value={l.id} selected={l.id === (d.list ?? status.defaultList)}>{l.title}</option>)}
        </select>
      ) : (
        <div class="cf-add-meta">{where ?? t("appleRemindersApp")}</div>
      )}
      {guess && <p class="cf-add-warn">{t("appleGuess")}</p>}
      {past && <p class="cf-add-warn">{t("applePast")}</p>}
      {d.state === "saved" && <p class="cf-add-ok">✓ {t(d.kind === "reminder" ? "appleAdded" : "appleAddedEvent")}</p>}
      {d.state === "app" && <p class="cf-add-ok">{t("appleOpening")}</p>}
      {(d.state === "denied" || (!d.state && way === "denied")) && <p class="cf-add-warn">{t("appleDenied")}</p>}
      {(d.state === "failed" || d.state === "unavailable" || d.state === "not-asked") && <p class="cf-add-warn">{t("appleFailed")}</p>}
      {!done && (
        <button type="button" class="cf-primary cf-add-go" disabled={!ready || busy || way === "denied" || way === null} onClick={onAdd}>
          {t("appleAdd")}
        </button>
      )}
    </div>
  )
}
