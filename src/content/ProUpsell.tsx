import type { VNode } from "preact"

import { t } from "../shared/i18n"
import * as Icon from "./icons"
import { OrganizeAnimation } from "./Organize"

/**
 * What AI search and "Ask your chats" do, for someone without Pro: shown when they reach for one
 * (the ✦ in the chat search, the "Ask your chats" row, or a refused request). Organizing the chats (2.5) comes
 * first, with its short loop. Get Pro opens the ContextFlow app's Pro screen on these features.
 */
export function ProUpsell({ feature, offer, byok, onPro, onOffer, onClose }: {
  feature: "find" | "history"
  offer: { code: string; discount: number } | null
  // An Own key subscriber: says it isn't in their plan, and upgrades (at the discount, when they have one).
  byok?: { discount: number | null }
  onPro: () => void
  onOffer: (code: string) => void
  onClose: () => void
}): VNode {
  const items = feature === "find" ? (["find", "history"] as const) : (["history", "find"] as const)
  return (
    <div class="cf-card cf-upsell" role="dialog" aria-label={t("upsellTitle")}>
      <div class="cf-upsell-head">
        <span class="cf-upsell-icon"><Icon.Sparkle size={18} /></span>
        <strong>{t(feature === "find" ? "upsellFindTitle" : "upsellHistoryTitle")}</strong>
        <span class="cf-pro-badge">Pro</span>
      </div>
      <div class="cf-upsell-organize">
        <OrganizeAnimation />
        <div>
          <strong>{t("upsellOrganizeName")}</strong>
          <span>{t("upsellOrganizeText")}</span>
        </div>
      </div>
      <ul class="cf-upsell-list">
        {items.map((item) => (
          <li key={item}>
            <strong>{t(item === "find" ? "upsellFindName" : "upsellHistoryName")}</strong>
            <span>{t(item === "find" ? "upsellFindText" : "upsellHistoryText")}</span>
          </li>
        ))}
        <li><span>{t("upsellMore")}</span></li>
      </ul>
      {byok && <p class="cf-upsell-byok">{t("byokProOnly")}</p>}
      <div class="cf-card-actions">
        {byok ? (
          <button type="button" class="cf-primary" onClick={onPro}><Icon.Sparkle size={14} /> {byok.discount !== null ? t("upgradeProOff", byok.discount) : t("upgradePro")}</button>
        ) : offer ? (
          <button type="button" class="cf-primary" onClick={() => onOffer(offer.code)}><Icon.Sparkle size={14} /> {t("offerButton", offer.discount)}</button>
        ) : (
          <button type="button" class="cf-primary" onClick={onPro}><Icon.Sparkle size={14} /> {t("getPro")}</button>
        )}
        <button type="button" class="cf-secondary" onClick={onClose}>{t("offerLater")}</button>
      </div>
    </div>
  )
}
