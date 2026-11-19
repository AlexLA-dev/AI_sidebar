// The count of answers left, and on a tap what they went on (2.7 (110), the owner on 109: «для пользователя может быть
// очень неочевидно, что перевод страниц расходует квоту. Поэтому <…> по тапу на счётчик в окне чата или в настройках
// раскрывалась детализация на что была потрачено квота»). In «+» by the field, and in Settings under the plan.
//
// The rows come from the server (src/shared/spent.ts): it counts the answers by kind next to the counter they're
// charged to, so Pro and Ultra see every device of the subscription, Free its own device's day. Read fresh when the
// details open. What's free is said too: translating only a page's buttons and menus takes no answer.

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { hasPro, isUltra, type Plan } from "../../shared/plan"
import { spentRows, type SpentRow } from "../../shared/spent"
import type { Usage } from "../../shared/types"

/** The count in words, the same in «+» and Settings (Ultra by its name: 2.6 said "Pro"). */
export function usageText(usage: Usage, plan: Plan): string {
  const left = Math.max(0, usage.limit - usage.used)
  return hasPro(plan) ? t(isUltra(plan) ? "usageUltra" : "usagePro", left, usage.limit) : t("usageFree", left, usage.limit)
}

/** A row's name: the chat's own words for each kind (Write's three as its buttons say them). */
export function spentLabel(kind: SpentRow["kind"]): string {
  switch (kind) {
    case "chat": return t("spentChat")
    case "google": return t("spentGoogle")
    case "translate": return t("spentTranslate")
    case "write": return [t("writeCheck"), t("writeRewrite"), t("writeCompose")].join(" · ")
    case "chats": return t("upsellHistoryName")
    case "similar": return t("actSimilar")
    default: return t("spentOther")
  }
}

const Chevron = ({ open }: { open: boolean }): VNode => (
  <svg class={`cf-spent-chev ${open ? "open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
)

interface Props {
  // The count in words ("3 of 5 free answers left today").
  text: string
  // What stands after it (Get Pro, an offer).
  after?: ComponentChildren
  // The usage, fresh from the server (null: it couldn't be read).
  load: () => Promise<Usage | null>
  // Pro or Ultra: a week, every device of the subscription; else the day on this device.
  paid: boolean
  // Opened already (the number by the field asked for it).
  startOpen?: boolean
  onOpen?: () => void
  cls: string
}

type State = { kind: "closed" } | { kind: "loading" } | { kind: "failed" } | { kind: "shown"; rows: SpentRow[] | null; period: "day" | "week" }

export function SpentCount({ text, after, load, paid, startOpen, onOpen, cls }: Props): VNode {
  const [state, setState] = useState<State>({ kind: "closed" })
  const read = async () => {
    setState({ kind: "loading" })
    const usage = await load().catch(() => null)
    setState(usage ? { kind: "shown", rows: spentRows(usage.used, usage.by), period: usage.period } : { kind: "failed" })
  }
  const toggle = () => {
    if (state.kind !== "closed") return setState({ kind: "closed" })
    onOpen?.()
    void read()
  }
  useEffect(() => {
    if (startOpen) void read()
  }, [])
  const open = state.kind !== "closed"
  const period = state.kind === "shown" ? state.period : paid ? "week" : "day"
  return (
    <div class={`${cls} cf-spent-box`}>
      <button type="button" class="cf-spent-count" aria-expanded={open} title={t("spentShow")} onClick={toggle}>
        <span class="cf-plus-left">{text}</span>
        <Chevron open={open} />
      </button>
      {!open && after}
      {open && (
        <div class="cf-spent" role="status">
          <div class="cf-spent-title">{t(period === "week" ? "spentTitleWeek" : "spentTitleDay")}</div>
          {state.kind === "loading" && <div class="cf-spent-wait" aria-busy="true">…</div>}
          {state.kind === "failed" && <button type="button" class="cf-link cf-spent-retry" onClick={() => void read()}>{t("spentError")}</button>}
          {state.kind === "shown" && state.rows && (state.rows.length > 0 ? (
            <ul class="cf-spent-rows">
              {state.rows.map((row) => (
                <li key={row.kind} class={`cf-spent-row ${row.kind}`}>
                  <span class="cf-spent-name">{spentLabel(row.kind)}</span>
                  <span class="cf-spent-n">{row.n}</span>
                </li>
              ))}
            </ul>
          ) : <div class="cf-spent-none">{t("spentNone")}</div>)}
          <p class="cf-spent-note">{t("spentFree")}</p>
          <p class="cf-spent-note">{t(paid ? "spentAllDevices" : "spentThisDevice")}</p>
        </div>
      )}
      {/* Get Pro (an offer) after the details when they're open: the count and what it went on stay together. */}
      {open && after}
    </div>
  )
}
