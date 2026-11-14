import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { LINKS, TARGET, VERSION } from "../shared/config"
import { t } from "../shared/i18n"
import { OWN_KEY_PATTERN } from "../shared/models"
import { hasPro, isUltra, periodOfProduct, productOf } from "../shared/plan"
import type { Platform, Settings, StatusInfo, Usage } from "../shared/types"
import * as Icon from "./icons"
import { deleteAllChats, hideYearly, yearlyHiddenNow } from "./store"
import { InsertSettingsGroup } from "./insert/InsertSettings"

interface Props {
  settings: Settings
  status: StatusInfo | null
  usage: Usage | null
  platform: Platform
  site: string
  onChange: (patch: Partial<Settings>) => void
  onUpgrade: () => void
  // 2.6: the plans sheet (Own key, Pro, Ultra; monthly or yearly).
  onPlans?: () => void
  // Build 90: a monthly Pro or Ultra subscriber switches to the yearly plan (the app takes the payment).
  onYearly?: (plan: "pro" | "ultra") => void
  // The Own key plan's button: "Upgrade to Pro", at the discount when there is one.
  upgradeLabel?: string
  onManage: () => void
  onStatusChange: () => void
  onOpenUrl: (url: string) => void
  onChatsDeleted: () => void
  onShowTour: () => void
  onOpenTemplates: () => void
  // A link to ContextFlow's X or Threads (counted, no text).
  onSocial: (network: "x" | "threads") => void
  // Organizing (2.5) without Pro: what it does opens the Pro screen.
  onOrganizePro: () => void
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }): VNode {
  return (
    <div class="cf-seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button type="button" key={v} role="radio" aria-checked={v === value} class={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

export function SettingsView(props: Props): VNode {
  const { settings, status, usage, site, onChange } = props
  const plan = status?.plan ?? "free"
  const ownKeyAllowed = TARGET === "chrome" || plan !== "free" || Boolean(status?.store?.active)
  const [keyDraft, setKeyDraft] = useState("")
  const [keySaved, setKeySaved] = useState(false)
  const [about, setAbout] = useState(settings.aboutMe)
  const [chatsDeleted, setChatsDeleted] = useState(false)

  useEffect(() => setAbout(settings.aboutMe), [settings.aboutMe])

  const saveKey = (key: string) => {
    chrome.runtime.sendMessage({ type: "setOwnKey", key }, () => {
      void chrome.runtime.lastError
      setKeyDraft("")
      setKeySaved(true)
      setTimeout(() => setKeySaved(false), 1500)
      props.onStatusChange()
    })
  }

  const hidden = settings.fabHiddenSites.includes(site)
  const renews = status?.store?.expiresAt ? new Date(status.store.expiresAt).toLocaleDateString() : null
  const planName = plan === "ultra" ? t("planUltra") : plan === "pro" ? t("planPro") : plan === "byok" ? t("planByok") : t("planFree")
  // Ultra: this week's listening, in minutes.
  const speak = isUltra(plan) ? status?.ultra?.speak ?? null : null
  // A monthly Pro or Ultra subscriber, with the yearly plan's saving known (the app shares it): one quiet line here,
  // never a prompt; "Hide" puts it away for 60 days.
  const [yearlyHidden, setYearlyHidden] = useState<boolean | null>(null)
  useEffect(() => void yearlyHiddenNow().then(setYearlyHidden), [])
  const storeProduct = status?.store?.active ? status.store.productId ?? null : null
  const monthlyPaid = (plan === "pro" || plan === "ultra") && periodOfProduct(storeProduct) === "monthly" ? plan : null
  const yearlyId = monthlyPaid ? productOf(monthlyPaid, "yearly") : null
  const yearlySave = yearlyId ? status?.store?.prices?.[`${yearlyId}#save`] : undefined
  const yearlyPercent = yearlyId ? status?.store?.prices?.[`${yearlyId}#percent`] : undefined

  // The plan comes first until there is Pro; with Pro it's managed at the very bottom.
  const planGroup = (
    <section class="cf-group">
      <div class="cf-row">
        <span class="cf-label">{t("setPlan")}</span>
        <span class={`cf-plan ${plan}`}>{planName}</span>
      </div>
      {usage && plan !== "byok" && (
        <div class="cf-meter" aria-hidden="true">
          <div style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)}%` }} />
        </div>
      )}
      {speak && (
        <p class="cf-hint">{t("listenLeft", String(Math.max(0, Math.floor((speak.limit - speak.used) / 60))), String(Math.round(speak.limit / 60)))}</p>
      )}
      {renews && plan !== "free" && <p class="cf-hint">{status?.store?.autoRenew === false ? t("planEnds", renews) : t("planRenews", renews)}</p>}
      {TARGET === "safari" && (
        <div class="cf-row buttons">
          {plan === "free" ? (
            <button type="button" class="cf-primary" onClick={props.onUpgrade}><Icon.Sparkle size={14} /> {t("getPro")}</button>
          ) : (
            <>
              {plan === "byok" && <button type="button" class="cf-primary" onClick={props.onUpgrade}><Icon.Sparkle size={14} /> {props.upgradeLabel ?? t("upgradePro")}</button>}
              <button type="button" class="cf-secondary" onClick={props.onManage}>{t("manageSubscription")}</button>
            </>
          )}
          {plan === "free" && <button type="button" class="cf-link" onClick={props.onManage}>{t("restorePurchases")}</button>}
          {props.onPlans && <button type="button" class={isUltra(plan) ? "cf-link" : "cf-secondary"} onClick={props.onPlans}>{isUltra(plan) ? t("plansCompare") : plan === "free" ? t("plansCompare") : t("seeUltra")}</button>}
        </div>
      )}
      {TARGET === "safari" && monthlyPaid && yearlySave && yearlyPercent && yearlyHidden === false && props.onYearly && (
        <div class="cf-yearly" role="note">
          <span>{t("yearlyNudge", monthlyPaid === "ultra" ? t("planUltra") : t("planPro"), yearlySave, yearlyPercent)}</span>
          <small>{t("yearlyNudgeNote")}</small>
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" onClick={() => props.onYearly?.(monthlyPaid)}>{t("yearlyNudgeButton")}</button>
            <button type="button" class="cf-link" onClick={() => {
              setYearlyHidden(true)
              void hideYearly()
            }}>{t("yearlyNudgeHide")}</button>
          </div>
        </div>
      )}
    </section>
  )

  return (
    <div class="cf-settings">
      {!hasPro(plan) && planGroup}

      <section class="cf-group">
        <div class="cf-row">
          <span class="cf-label">{t("setAppearance")}</span>
          <Segmented value={settings.theme} options={[["auto", t("themeAuto")], ["light", t("themeLight")], ["dark", t("themeDark")]]} onChange={(theme) => onChange({ theme })} />
        </div>
        <div class="cf-row">
          <span class="cf-label">{t("setTextSize")}</span>
          <Segmented value={settings.textSize} options={[["normal", t("sizeNormal")], ["large", t("sizeLarge")]]} onChange={(textSize) => onChange({ textSize })} />
        </div>
      </section>

      <section class="cf-group">
        <div class="cf-row">
          <span class="cf-label">{t("setFab")}</span>
          <Segmented value={settings.fab === "off" ? "off" : "on"} options={[["on", t("fabOn")], ["off", t("fabOff")]]} onChange={(fab) => onChange({ fab })} />
        </div>
        <p class="cf-hint">{t("setFabHint")}</p>
        <div class="cf-row">
          <button
            type="button"
            class="cf-link"
            onClick={() => onChange({ fabHiddenSites: hidden ? settings.fabHiddenSites.filter((s) => s !== site) : [...settings.fabHiddenSites, site].slice(-200) })}
          >
            {hidden ? t("showOnSite", site) : t("hideOnSite", site)}
          </button>
        </div>
        <label class="cf-row toggle">
          <span class="cf-label">{t("setSelectionButton")}</span>
          <input type="checkbox" checked={settings.selectionButton} onChange={(e) => onChange({ selectionButton: e.currentTarget.checked })} />
        </label>
      </section>

      {/* Share and copy (2.5 rules): highlights as bold, apart from the floating button. */}
      {typeof navigator.share === "function" && (
        <section class="cf-group">
          <div class="cf-row">
            <span class="cf-label">{t("setShareGroup")}</span>
          </div>
          <label class="cf-row toggle">
            <span class="cf-label">{t("uxShareMarks")}</span>
            <input type="checkbox" checked={settings.shareMarks} onChange={(e) => onChange({ shareMarks: e.currentTarget.checked })} />
          </label>
          <p class="cf-hint">{t("uxShareMarksHint")}</p>
        </section>
      )}

      <InsertSettingsGroup site={site} touch={props.platform === "ios" || props.platform === "ipados"} onOpenTemplates={props.onOpenTemplates} />

      <section class="cf-group">
        <span class="cf-label">{t("setAbout")}</span>
        <textarea
          class="cf-textarea"
          dir="auto"
          rows={3}
          maxLength={1000}
          value={about}
          onInput={(e) => setAbout(e.currentTarget.value)}
          onBlur={() => about !== settings.aboutMe && onChange({ aboutMe: about.trim() })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <p class="cf-hint">{t("setAboutHint")}</p>
      </section>

      <section class="cf-group">
        <div class="cf-row">
          <span class="cf-label">{t("setOwnKey")}</span>
          {!ownKeyAllowed && <span class="cf-hint inline"><Icon.Lock /> {t("setOwnKeyLocked")}</span>}
        </div>
        {status?.hasOwnKey ? (
          <div class="cf-row buttons">
            <span class="cf-key">{status.ownKeyProvider === "anthropic" ? "Claude · sk-ant-••••" : "OpenAI · sk-••••"}</span>
            <button type="button" class="cf-secondary" onClick={() => saveKey("")}>{t("remove")}</button>
          </div>
        ) : (
          <div class="cf-row buttons">
            <input
              class="cf-text"
              type="password"
              placeholder="sk-… / sk-ant-…"
              autoComplete="off"
              spellcheck={false}
              value={keyDraft}
              disabled={!ownKeyAllowed}
              onInput={(e) => setKeyDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button type="button" class="cf-secondary" disabled={!ownKeyAllowed || !OWN_KEY_PATTERN.test(keyDraft.trim())} onClick={() => saveKey(keyDraft)}>
              {keySaved ? t("saved") : t("save")}
            </button>
          </div>
        )}
        <p class="cf-hint">
          {t("setOwnKeyHint")} {t("getKey")}:{" "}
          <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.openAiKeys)}>OpenAI</button>
          {" · "}
          <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.anthropicKeys)}>Claude</button>
        </p>
        {(ownKeyAllowed || status?.hasOwnKey) && (
          <>
            <div class="cf-row">
              <span class="cf-label">{t("setOwnKeyModel")}</span>
              <Segmented value={settings.ownKeyModel} options={[["fast", t("modelFast")], ["smart", t("modelSmart")]]} onChange={(ownKeyModel) => onChange({ ownKeyModel })} />
            </div>
            <p class="cf-hint">{t("setOwnKeyModelHint")}</p>
          </>
        )}
      </section>

      <section class="cf-group">
        {TARGET === "safari" && (hasPro(plan) ? (
          <>
            <label class="cf-row toggle">
              <span class="cf-label">{t("setOrganize")}</span>
              <input type="checkbox" checked={settings.organize} onChange={(e) => onChange({ organize: e.currentTarget.checked })} />
            </label>
            <p class="cf-hint">{t("setOrganizeHint")}</p>
          </>
        ) : (
          <div class="cf-row cf-org-setting-pro">
            <span class="cf-label">{t("setOrganize")} <span class="cf-pro-badge">Pro</span></span>
            <button type="button" class="cf-link" onClick={props.onOrganizePro}>{t("getPro")}</button>
          </div>
        ))}
        {TARGET === "safari" && !hasPro(plan) && <p class="cf-hint">{t("setOrganizePro")}</p>}
        {/* 2.7: Spaces, on by default (nothing shows while there's one). Off: one list again, nothing lost. */}
        <label class="cf-row toggle">
          <span class="cf-label">{t("setSpaces")}</span>
          <input type="checkbox" checked={settings.spaces !== false} onChange={(e) => onChange({ spaces: e.currentTarget.checked })} />
        </label>
        <p class="cf-hint">{t("setSpacesHint")}</p>
        {TARGET === "safari" && (
          <>
            <label class="cf-row toggle">
              <span class="cf-label">{t("setSyncChats")}</span>
              <input type="checkbox" checked={settings.syncChats} onChange={(e) => onChange({ syncChats: e.currentTarget.checked })} />
            </label>
            <p class="cf-hint">{t("setSyncChatsHint")}</p>
          </>
        )}
        <button
          type="button"
          class="cf-link danger"
          onClick={async () => {
            await deleteAllChats()
            props.onChatsDeleted()
            setChatsDeleted(true)
          }}
        >
          {chatsDeleted ? t("chatsDeleted") : t("deleteChats")}
        </button>
      </section>

      {hasPro(plan) && planGroup}

      <footer class="cf-links">
        <button type="button" class="cf-link" onClick={props.onShowTour}>{t("tourShow")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.review)}>{t("rateApp")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.support)}>{t("support")}</button>
        <button type="button" class="cf-link" onClick={() => props.onSocial("x")}>X</button>
        <button type="button" class="cf-link" onClick={() => props.onSocial("threads")}>Threads</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.privacy)}>{t("privacyPolicy")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.terms)}>{t("terms")}</button>
        <span class="cf-version">{t("version", VERSION)}</span>
      </footer>
    </div>
  )
}
