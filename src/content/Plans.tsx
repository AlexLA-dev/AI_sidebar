// The plans sheet (2.6): Own key, Pro and Ultra side by side with a monthly/yearly switch, what each one adds in plain
// words, and the App Store's price on this device (the app shares the prices it last loaded; none until it has).
// Choosing a plan opens the ContextFlow app on it, where the App Store sheet takes the payment.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t } from "../shared/i18n"
import { DEFAULT_PLAN_FACTS, PLAN_RANK, periodOfProduct, planOfProduct, productOf, type PaidPlan, type Period } from "../shared/plan"
import type { PlanFacts, StatusInfo } from "../shared/types"
import { Gallery } from "./Gallery"
import { lastPrices } from "./store"
import * as Icon from "./icons"

const ORDER: PaidPlan[] = ["byok", "pro", "ultra"]

/** A display price as a number ("$12.99", "12,99 €", "¥1,900"), for the yearly saving; null when it can't tell. */
export function priceValue(display: string | undefined): number | null {
  if (!display) return null
  const digits = display.replace(/[^\d.,]/g, "")
  if (!digits) return null
  const m = /^(.*?)[.,](\d{1,2})$/.exec(digits)
  const value = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(digits.replace(/[.,]/g, ""))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Percent saved by paying yearly instead of 12 months, when both prices are known (at least 5%). */
export function yearlySaving(monthly: string | undefined, yearly: string | undefined): number | null {
  const m = priceValue(monthly)
  const y = priceValue(yearly)
  if (!m || !y) return null
  const percent = Math.round((1 - y / (m * 12)) * 100)
  return percent >= 5 ? percent : null
}

export function tierLines(plan: PaidPlan, facts: PlanFacts): string[] {
  if (plan === "byok") return [t("tierByok1"), t("tierByok2")]
  if (plan === "pro") return [t("tierPro1", String(facts.proWeekly)), t("tierPro2"), t("tierPro3", String(facts.watch.pro))]
  return [
    t("tierUltra0"),
    t("tierUltra1", String(Math.round(facts.speakWeeklySeconds / 60))),
    t("tierUltra2", String(facts.similarWeekly)),
    t("tierUltra3", String(facts.watch.ultra))
  ]
}

export function PlansSheet({ status, focus, onChoose, onClose }: {
  status: StatusInfo | null
  // The plan to show first (highlighted): Ultra from Listen, Pro from a Pro feature.
  focus: PaidPlan
  onChoose: (plan: PaidPlan, period: Period) => void
  onClose: () => void
}): VNode {
  // The App Store's prices, or the last ones this device had (build 92: none at all when the status didn't come).
  const [keptPrices, setKeptPrices] = useState<Record<string, string>>({})
  useEffect(() => void lastPrices().then(setKeptPrices), [])
  const given = status?.store?.prices ?? {}
  const prices = Object.keys(given).length ? given : keptPrices
  const currentProduct = status?.store?.active ? status.store.productId : null
  const currentPlan = planOfProduct(currentProduct)
  const [period, setPeriod] = useState<Period>(periodOfProduct(currentProduct) ?? "yearly")
  const facts = status?.plans ?? DEFAULT_PLAN_FACTS
  // The best yearly saving on offer, for the switch (the app's own figure when it shared one).
  const best = Math.max(0, ...ORDER.map((plan) => Number(prices[`${productOf(plan, "yearly")}#percent`]) || yearlySaving(prices[productOf(plan, "monthly")], prices[productOf(plan, "yearly")]) || 0))

  return (
    <div class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div class="cf-sheet cf-plans" role="dialog" aria-label={t("plansTitle")}>
      <div class="cf-plans-head">
        <strong>{t("plansTitle")}</strong>
        <button type="button" class="cf-icon-btn" onClick={onClose} aria-label={t("close")}>×</button>
      </div>
      <div class="cf-seg cf-plans-period" role="radiogroup">
        {(["monthly", "yearly"] as const).map((p) => (
          <button type="button" key={p} role="radio" aria-checked={p === period} class={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
            {p === "monthly" ? t("plansMonthly") : best ? t("plansYearlySave", String(best)) : t("plansYearly")}
          </button>
        ))}
      </div>
      <div class="cf-plans-list">
        {ORDER.map((plan) => {
          const monthly = prices[productOf(plan, "monthly")]
          const yearly = prices[productOf(plan, "yearly")]
          // Own key yearly may not be on sale yet: its monthly price then.
          const shownPeriod: Period = period === "yearly" && (yearly || !monthly) ? "yearly" : "monthly"
          const price = shownPeriod === "yearly" ? yearly : monthly
          const yearlyId = productOf(plan, "yearly")
          const saving = shownPeriod === "yearly" ? (Number(prices[`${yearlyId}#percent`]) || yearlySaving(monthly, yearly)) : null
          // A month of the yearly plan and the money it saves, as the App Store writes them (shared by the app).
          const perMonth = shownPeriod === "yearly" ? prices[`${yearlyId}#perMonth`] : undefined
          const saved = shownPeriod === "yearly" ? prices[`${yearlyId}#save`] : undefined
          const current = currentPlan === plan && (periodOfProduct(currentProduct) ?? "monthly") === shownPeriod
          // A lower plan than the current one is still a choice (it starts at the next renewal), just not pushed.
          const lower = PLAN_RANK[plan] < PLAN_RANK[currentPlan]
          // Every move up is an upgrade (build 91, the owner): a higher plan, or the same plan from monthly to yearly.
          const paid = currentPlan !== "free"
          const upgrade: "plan" | "yearly" | null = paid && PLAN_RANK[plan] > PLAN_RANK[currentPlan] ? "plan"
            : paid && plan === currentPlan && periodOfProduct(currentProduct) === "monthly" && shownPeriod === "yearly" ? "yearly" : null
          const name = plan === "ultra" ? t("planUltra") : plan === "pro" ? t("planPro") : t("planByok")
          return (
            <section key={plan} class={`cf-plan-card ${plan} ${plan === focus ? "focus" : ""} ${current ? "current" : ""}`}>
              <div class="cf-plan-top">
                <strong>{name}</strong>
                {saving !== null && <span class="cf-plan-save">{t("plansSave", String(saving))}</span>}
                {price && <span class="cf-plan-price">{shownPeriod === "yearly" ? t("plansPerYear", price) : t("plansPerMonth", price)}</span>}
              </div>
              {perMonth && <div class="cf-plan-year"><span>{t("plansPerMonthYearly", perMonth)}</span></div>}
              {plan === "ultra" && currentPlan === "ultra" && status?.ultra?.speak && (
                <p class="cf-plan-left">{t("listenLeft", String(Math.max(0, Math.floor((status.ultra.speak.limit - status.ultra.speak.used) / 60))), String(Math.round(status.ultra.speak.limit / 60)))}</p>
              )}
              {saved && <p class="cf-plan-saved">{t("plansSaveMoney", saved)}</p>}
              {facts && (
                <ul class="cf-plan-lines">
                  {tierLines(plan, facts).map((line, i) => <li key={i} class={plan === "ultra" && i === 0 ? "lead" : ""}>{line}</li>)}
                </ul>
              )}
              {current ? (
                <span class="cf-plan-current"><Icon.Check /> {t("plansCurrent")}</span>
              ) : (
                <button type="button" class={(plan === focus && !lower) || upgrade ? "cf-primary" : "cf-secondary"} onClick={() => onChoose(plan, shownPeriod)}>
                  {((plan === focus && !lower) || upgrade) && <Icon.Sparkle size={14} />} {upgrade === "yearly" ? t("plansUpgradeYearly") : upgrade === "plan" ? t("plansUpgrade", name) : t("plansChoose", name)}
                </button>
              )}
            </section>
          )
        })}
      </div>
      <Gallery facts={facts} ultra={focus === "ultra"} />
      <p class="cf-hint">{t("plansNote")}</p>
    </div>
    </div>
  )
}
