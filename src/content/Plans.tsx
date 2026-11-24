// The plans sheet (2.6): Pro and Ultra side by side with a monthly/yearly switch, what each one adds in plain
// words, and the App Store's price on this device (the app shares the prices it last loaded; none until it has).
// Choosing a plan opens the ContextFlow app on it, where the App Store sheet takes the payment.
// Own key (109, the owner: «Ок, давай под ссылку») is not in the row of plans: it is under the link "I have my own
// API key", the same card with one sentence saying it needs the person's own key, paid to that provider. Someone
// who has the Own key plan sees it in the row as before.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t } from "../shared/i18n"
import { DEFAULT_PLAN_FACTS, PLAN_RANK, periodOfProduct, planOfProduct, productOf, startPeriod, type PaidPlan, type Period } from "../shared/plan"
import type { PlanFacts, StatusInfo } from "../shared/types"
import { Gallery } from "./Gallery"
import { lastPrices } from "./store"
import * as Icon from "./icons"

const ORDER: PaidPlan[] = ["byok", "pro", "ultra"]

/** The plans in the row: Pro and Ultra; Own key too for its subscriber, or once its link is opened (then last). */
export function plansShown(current: string, ownOpen: boolean): PaidPlan[] {
  if (current === "byok") return ORDER
  return ownOpen ? ["pro", "ultra", "byok"] : ["pro", "ultra"]
}

/** A display price as a number ("$12.99", "12,99 €", "¥1,900"), for the yearly saving; null when it can't tell. */
export function priceValue(display: string | undefined): number | null {
  if (!display) return null
  const digits = display.replace(/[^\d.,]/g, "")
  if (!digits) return null
  const m = /^(.*?)[.,](\d{1,2})$/.exec(digits)
  const value = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(digits.replace(/[.,]/g, ""))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** The App Store's currency, when its prices don't say it themselves (build 95, the owner's App Store of Canada: CAD
 *  reads "$12.99", the same as dollars of the US): a currency other than USD written with a bare "$". Null otherwise. */
export function currencyCode(prices: Record<string, string>): string | null {
  const code = (prices["#currency"] ?? "").toUpperCase()
  if (!/^[A-Z]{3}$/.test(code) || code === "USD") return null
  const shown = Object.entries(prices).filter(([key, value]) => !key.includes("#") && value).map(([, value]) => value)
  return shown.some((price) => price.includes("$") && !/\p{L}/u.test(price)) ? code : null
}

/** Percent saved by paying yearly instead of 12 months, when both prices are known (at least 5%). */
export function yearlySaving(monthly: string | undefined, yearly: string | undefined): number | null {
  const m = priceValue(monthly)
  const y = priceValue(yearly)
  if (!m || !y) return null
  const percent = Math.round((1 - y / (m * 12)) * 100)
  return percent >= 5 ? percent : null
}

/** An Ultra feature the sheet opens on (2.8, В7.4: Pro's taste of it is used): its line first, its slide first. */
export type PlansFeature = "listen" | "similar"

export function tierLines(plan: PaidPlan, facts: PlanFacts, feature?: PlansFeature): string[] {
  if (plan === "byok") return [t("tierByok1"), t("tierByok2")]
  if (plan === "pro") return [t("tierPro1", String(facts.proWeekly)), t("tierPro2"), t("tierPro3", String(facts.watch.pro))]
  const listen = t("tierUltra1", String(Math.round(facts.speakWeeklySeconds / 60)))
  const similar = t("tierUltra2", String(facts.similarWeekly))
  const lines = [t("tierUltra0"), listen, similar, t("tierUltra3", String(facts.watch.ultra))]
  if (!feature) return lines
  const first = feature === "listen" ? listen : similar
  return [first, ...lines.filter((line) => line !== first)]
}

export function PlansSheet({ status, focus, feature, lead, onChoose, onClose }: {
  status: StatusInfo | null
  // The plan to show first (highlighted): Ultra from Listen, Pro from a Pro feature.
  focus: PaidPlan
  // 2.8 (В7.4): the Ultra feature to put first, and a line on top saying why the sheet opened (a taste used up).
  feature?: PlansFeature
  lead?: string
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
  const [period, setPeriod] = useState<Period>(startPeriod(currentProduct))
  // Own key's card, behind its link until asked for (the sheet opened on Own key shows it at once).
  const [ownOpen, setOwnOpen] = useState(focus === "byok")
  const shown = plansShown(currentPlan, ownOpen)
  const facts = status?.plans ?? DEFAULT_PLAN_FACTS
  // The best yearly saving on offer, for the switch (the app's own figure when it shared one).
  const best = Math.max(0, ...shown.map((plan) => Number(prices[`${productOf(plan, "yearly")}#percent`]) || yearlySaving(prices[productOf(plan, "monthly")], prices[productOf(plan, "yearly")]) || 0))

  return (
    <div class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div class="cf-sheet cf-plans" role="dialog" aria-label={t("plansTitle")}>
      <div class="cf-plans-head">
        <strong>{t("plansTitle")}</strong>
        <button type="button" class="cf-icon-btn" onClick={onClose} aria-label={t("close")}>×</button>
      </div>
      {lead && <p class="cf-plans-lead">{lead}</p>}
      <div class="cf-seg cf-plans-period" role="radiogroup">
        {(["monthly", "yearly"] as const).map((p) => (
          <button type="button" key={p} role="radio" aria-checked={p === period} class={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
            {p === "monthly" ? t("plansMonthly") : best ? t("plansYearlySave", String(best)) : t("plansYearly")}
          </button>
        ))}
      </div>
      <div class="cf-plans-list">
        {shown.map((plan) => {
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
          // Twelve months of the monthly plan, struck through (build 95: promised on 90, the app's cards had it).
          const twelve = shownPeriod === "yearly" ? prices[`${yearlyId}#twelve`] : undefined
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
              {plan === "byok" && currentPlan !== "byok" && <p class="cf-plan-needs">{t("plansOwnKeyNeeds")}</p>}
              {perMonth && <div class="cf-plan-year"><span>{t("plansPerMonthYearly", perMonth)}</span>{twelve && <s aria-hidden="true">{twelve}</s>}</div>}
              {plan === "ultra" && currentPlan === "ultra" && status?.ultra?.speak && (
                <p class="cf-plan-left">{t("listenLeft", String(Math.max(0, Math.floor((status.ultra.speak.limit - status.ultra.speak.used) / 60))), String(Math.round(status.ultra.speak.limit / 60)))}</p>
              )}
              {saved && <p class="cf-plan-saved">{t("plansSaveMoney", saved)}</p>}
              {facts && (
                <ul class="cf-plan-lines">
                  {tierLines(plan, facts, feature).map((line, i) => <li key={i} class={plan === "ultra" && i === 0 ? "lead" : ""}>{line}</li>)}
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
      {currentPlan !== "byok" && !ownOpen && (
        <p class="cf-plans-own"><button type="button" class="cf-link" onClick={() => setOwnOpen(true)}>{t("plansOwnKeyLink")}</button></p>
      )}
      {currencyCode(prices) && <p class="cf-hint cf-plans-currency">{t("plansCurrency", currencyCode(prices)!)}</p>}
      <Gallery facts={facts} ultra={focus === "ultra"} start={feature} />
      <p class="cf-hint">{t("plansNote")}</p>
    </div>
    </div>
  )
}
