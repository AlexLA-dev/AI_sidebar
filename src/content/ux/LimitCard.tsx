// The free answers' limit card, simpler (2.8, Р19: the owner «да, упрощай», from plans-28/v7-card-simpler.md): one plan
// (Pro, monthly: the owner's «monthly first»), one price, one buy button; under it «Remind me at …» (the free way through)
// and «More», which holds yearly, Ultra, a note and the own key. Nine controls became three. The −50 % offer, when this
// person has it, is folded into the box and the button and still goes through the App Store's code page (Р13 «нет»: no
// introductory offer). Retry shows up only once the answers are back.
//
// Free people only: a subscriber at their limit keeps PlanOffer (Ultra, their own period).

import type { ComponentChildren, VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { productOf, type Period } from "../../shared/plan"
import type { StatusInfo } from "../../shared/types"
import { currencyCode } from "../Plans"
import * as Icon from "../icons"
import { savingOf, useAnswersBack, usePrices, type OfferChoice } from "./PlanOffer"

/** The card's one purchase: Pro, monthly (the owner, 25.11: monthly first everywhere). */
export const LIMIT_BUY: OfferChoice = { plan: "pro", period: "monthly" }
export type LimitEvent = "shown" | "choose" | "discount" | "retry" | "more" | "note" | "own_key"

export function LimitCard({ status, title, body, offer, remind, retryAt, ownKey, onRetry, onChoose, onRedeem, onNote, onOwnKey, onEvent }: {
  status: StatusInfo | null
  title: string
  body?: ComponentChildren
  // The −50 % code for this person, when they have it (the first month, through the App Store's code page).
  offer: { code: string; discount: number } | null
  // «Remind me at …» (AnswersBack, short), when it can be set here.
  remind?: ComponentChildren
  // When the answers are back (ms); "unknown" while the server hasn't said.
  retryAt: number | null | "unknown"
  // The own key's row (Safari only, as before).
  ownKey: boolean
  onRetry?: () => void
  onChoose: (choice: OfferChoice) => void
  onRedeem: (code: string) => void
  onNote: () => void
  onOwnKey: () => void
  // `from` is "more" for what was tapped inside «More».
  onEvent: (action: LimitEvent, choice?: OfferChoice, from?: "more", state?: "full" | "discount") => void
}): VNode {
  const prices = usePrices(status)
  const facts = status?.plans
  const [more, setMore] = useState(false)
  // Which card it was: the full price (the first time at the limit), or the discount (on return; 2.8, the owner).
  useEffect(() => onEvent("shown", LIMIT_BUY, undefined, offer ? "discount" : "full"), [])
  // The whole closed card in view as it comes (the director on #263, SE in German: the panel scrolled to the chat's end
  // when it opened, before the card was back from storage and its prices in, and its last row was cut off). Only while
  // it settles, never once the person scrolls on their own.
  const ref = useRef<HTMLDivElement>(null)
  const since = useRef(Date.now())
  const back = useAnswersBack(retryAt)
  const canRetry = Boolean(onRetry) && back

  const monthly = prices[productOf("pro", "monthly")]
  const yearly = prices[productOf("pro", "yearly")]
  const ultra = prices[productOf("ultra", "monthly")]
  const saving = savingOf(prices, "pro")
  const currency = currencyCode(prices)

  useEffect(() => {
    if (Date.now() - since.current > 2_000) return
    const timer = setTimeout(() => ref.current?.scrollIntoView?.({ block: "nearest" }), 30)
    return () => clearTimeout(timer)
  }, [monthly, Boolean(facts), Boolean(offer)])

  const buy = () => {
    if (offer) {
      onEvent("discount")
      onRedeem(offer.code)
    } else {
      onEvent("choose", LIMIT_BUY)
      onChoose(LIMIT_BUY)
    }
  }
  const pick = (choice: OfferChoice) => {
    onEvent("choose", choice, "more")
    onChoose(choice)
  }
  const period = (p: Period) => ({ plan: "pro", period: p }) as OfferChoice

  return (
    <div ref={ref} class="cf-card cf-offer cf-limit-card limit" role="group" aria-label={title}>
      <div class="cf-upsell-head">
        <span class="cf-upsell-icon"><Icon.Sparkle size={18} /></span>
        <strong>{title}</strong>
      </div>
      {body && <p class="cf-offer-body">{body}</p>}
      <div class="cf-offer-plan-card">
        <div class="cf-plan-top">
          <strong>{t("planPro")}</strong>
          {monthly && <span class="cf-plan-price">{t("plansPerMonth", monthly)}</span>}
        </div>
        {/* One short line of what Pro gives: the card fits the panel as it opens on the smallest iPhone (the director on
            #263); the rest is under More and in the plans. The offer is said by the button only. */}
        {facts && <p class="cf-limit-pro-line">{t("limitProLine", String(facts.proWeekly))}</p>}
        {monthly && currency && <p class="cf-hint cf-plans-currency">{t("plansCurrency", currency)}</p>}
      </div>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary cf-limit-buy" onClick={buy}>
          <Icon.Sparkle size={14} /> {offer ? t("limitBuyOffer", offer.discount) : monthly ? t("limitBuyPrice", monthly) : t("getPro")}
        </button>
        {/* Only once the answers are back (acceptance 3). */}
        {canRetry && (
          <button type="button" class="cf-secondary" onClick={() => { onEvent("retry"); onRetry!() }}>
            <Icon.Retry /> {t("retry")}
          </button>
        )}
      </div>
      {/* One line: where the code is applied, or where it's cancelled. No promise we can't stand behind (the director:
          «Cancel anytime in two taps» isn't true). The price it renews at is the box's, right above. */}
      <p class="cf-limit-terms">
        {(offer ? t("offerByCode") : t("limitCancel")).replace(/App Store/g, "App\u00a0Store")}
      </p>
      <div class="cf-limit-row">
        {remind}
        <button type="button" class="cf-link cf-limit-more-toggle" aria-expanded={more} onClick={() => {
          if (!more) onEvent("more")
          setMore(!more)
        }}>
          {t("limitMore")} <span aria-hidden="true">{more ? "▴" : "▾"}</span>
        </button>
      </div>
      {more && (
        <ul class="cf-limit-more">
          <li>
            <span>{yearly ? (saving ? t("moreYearlySave", yearly, String(saving)) : t("moreYearly", yearly)) : t("plansYearly")}</span>
            <button type="button" class="cf-link" onClick={() => pick(period("yearly"))}>{t("moreChoose")}</button>
          </li>
          <li>
            <span>{ultra ? t("moreUltra", ultra) : t("moreUltraNoPrice")}</span>
            <button type="button" class="cf-link" onClick={() => pick({ plan: "ultra", period: "monthly" })}>{t("moreChoose")}</button>
          </li>
          <li class="cf-limit-more-note">
            <span><Icon.Pencil /> {t("moreNotes")}</span>
            <button type="button" class="cf-link" onClick={() => { onEvent("note", undefined, "more"); onNote() }}>{t("writeNote")}</button>
          </li>
          {ownKey && (
            <li>
              <span>{t("moreOwnKey")}</span>
              <button type="button" class="cf-link" onClick={() => { onEvent("own_key", undefined, "more"); onOwnKey() }}>{t("moreOwnKeyLink")}</button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
