// The plans message in the chat (build 91, the owner: «сообщение в чате с предложением подписаться (месяц vs год, pro vs
// ultra)»): where an answer would have been — out of answers, the chat's memory (Pro), a Pro or an Ultra feature — what
// the plan adds, Pro or Ultra, monthly or yearly with the App Store's price on this device and the yearly saving (the
// plans sheet's data, shared by the app), and a button that opens the app on that plan and period. One component for
// all of them; each place adds its own (the discount, a note, the own key, Retry).

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t, uiLanguage } from "../../shared/i18n"
import { productOf, type PaidPlan, type Period } from "../../shared/plan"
import type { StatusInfo } from "../../shared/types"
import { tierLines, yearlySaving } from "../Plans"
import * as Icon from "../icons"

export type OfferPlace = "limit" | "memory" | "pro_only" | "ultra_only"

export interface OfferChoice {
  plan: Exclude<PaidPlan, "byok">
  period: Period
}

/** The yearly saving for `plan`, as the app figured it or from the two prices (null: unknown or under 5%). */
export function savingOf(prices: Record<string, string>, plan: PaidPlan): number | null {
  const yearly = productOf(plan, "yearly")
  return Number(prices[`${yearly}#percent`]) || yearlySaving(prices[productOf(plan, "monthly")], prices[yearly])
}

export function PlanOffer({ place, status, title, body, lines, plans = ["pro", "ultra"], focus, extra, retryAt, onRetry, onChoose, onEvent, onClose }: {
  place: OfferPlace
  status: StatusInfo | null
  title: string
  body?: ComponentChildren
  // What the feature itself does (Find similar, Ask your chats), above the choice.
  lines?: string[]
  // The plans to choose from (Ultra alone for an Ultra feature, or for someone who has Pro), the first one picked.
  plans?: Array<OfferChoice["plan"]>
  focus?: OfferChoice["plan"]
  // The place's own actions under the button (the discount, a note, the own key).
  extra?: ComponentChildren
  // Retry the question: possible from `retryAt` (ms) on (when the answers are back); null when it is now.
  retryAt?: number | null
  onRetry?: () => void
  onChoose: (choice: OfferChoice) => void
  onEvent: (action: "shown" | "choose" | "retry" | "close", choice?: OfferChoice) => void
  onClose?: () => void
}): VNode {
  const prices = status?.store?.prices ?? {}
  const facts = status?.plans
  const [plan, setPlan] = useState<OfferChoice["plan"]>(focus && plans.includes(focus) ? focus : plans[0])
  const [period, setPeriod] = useState<Period>("yearly")
  // Shown once per message.
  useEffect(() => onEvent("shown", { plan, period }), [])
  // Retry comes alive when the answers are back.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!retryAt || retryAt <= now) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(retryAt - now + 500, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [retryAt, now])
  const canRetry = Boolean(onRetry) && (!retryAt || retryAt <= now)

  const monthly = prices[productOf(plan, "monthly")]
  const yearly = prices[productOf(plan, "yearly")]
  const price = period === "yearly" ? yearly : monthly
  const perMonth = period === "yearly" ? prices[`${productOf(plan, "yearly")}#perMonth`] : undefined
  const best = Math.max(0, ...plans.map((p) => savingOf(prices, p) ?? 0))
  const saving = period === "yearly" ? savingOf(prices, plan) : null
  const name = (p: OfferChoice["plan"]) => (p === "ultra" ? t("planUltra") : t("planPro"))
  const choose = () => {
    onEvent("choose", { plan, period })
    onChoose({ plan, period })
  }

  return (
    <div class={`cf-card cf-offer ${place}`} role="group" aria-label={title}>
      <div class="cf-upsell-head">
        <span class="cf-upsell-icon"><Icon.Sparkle size={18} /></span>
        <strong>{title}</strong>
        {onClose && <button type="button" class="cf-icon-btn cf-offer-close" onClick={() => { onEvent("close"); onClose() }} aria-label={t("close")}>×</button>}
      </div>
      {body && <p class="cf-offer-body">{body}</p>}
      {lines && lines.length > 0 && (
        <ul class="cf-upsell-list">{lines.map((line, i) => <li key={i}><span>{line}</span></li>)}</ul>
      )}
      {plans.length > 1 && (
        <div class="cf-seg cf-offer-plan" role="radiogroup" aria-label={t("plansTitle")}>
          {plans.map((p) => (
            <button type="button" key={p} role="radio" aria-checked={p === plan} class={p === plan ? "on" : ""} onClick={() => setPlan(p)}>{name(p)}</button>
          ))}
        </div>
      )}
      <div class="cf-seg cf-offer-period" role="radiogroup">
        {(["monthly", "yearly"] as const).map((p) => (
          <button type="button" key={p} role="radio" aria-checked={p === period} class={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
            {p === "monthly" ? t("plansMonthly") : best ? t("plansYearlySave", String(best)) : t("plansYearly")}
          </button>
        ))}
      </div>
      {(price || facts) && (
        <div class="cf-offer-plan-card">
          {price && (
            <div class="cf-plan-top">
              <strong>{name(plan)}</strong>
              {saving !== null && <span class="cf-plan-save">{t("plansSave", String(saving))}</span>}
              <span class="cf-plan-price">{period === "yearly" ? t("plansPerYear", price) : t("plansPerMonth", price)}</span>
            </div>
          )}
          {perMonth && <div class="cf-plan-year"><span>{t("plansPerMonthYearly", perMonth)}</span></div>}
          {facts && <ul class="cf-plan-lines">{tierLines(plan, facts).map((line, i) => <li key={i}>{line}</li>)}</ul>}
        </div>
      )}
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={choose}><Icon.Sparkle size={14} /> {t("plansChoose", name(plan))}</button>
        {onRetry && (
          <button type="button" class="cf-secondary" disabled={!canRetry} onClick={() => { onEvent("retry"); onRetry() }} title={canRetry ? t("retry") : undefined}>
            <Icon.Retry /> {t("retry")}
          </button>
        )}
      </div>
      {onRetry && !canRetry && retryAt && <p class="cf-offer-retry-at">{t("offerRetryAt", new Intl.DateTimeFormat(uiLanguage(), { hour: "numeric", minute: "2-digit" }).format(retryAt))}</p>}
      {extra}
    </div>
  )
}
