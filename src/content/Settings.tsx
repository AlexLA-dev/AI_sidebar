import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { LINKS, TARGET, VERSION } from "../shared/config"
import { t } from "../shared/i18n"
import type { Platform, Settings, StatusInfo, Usage } from "../shared/types"
import * as Icon from "./icons"
import { deleteAllChats } from "./store"

interface Props {
  settings: Settings
  status: StatusInfo | null
  usage: Usage | null
  platform: Platform
  site: string
  onChange: (patch: Partial<Settings>) => void
  onUpgrade: () => void
  onManage: () => void
  onStatusChange: () => void
  onOpenUrl: (url: string) => void
  onChatsDeleted: () => void
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
  const planName = plan === "pro" ? t("planPro") : plan === "byok" ? t("planByok") : t("planFree")

  return (
    <div class="cf-settings">
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
        {renews && plan !== "free" && <p class="cf-hint">{t("planRenews", renews)}</p>}
        {TARGET === "safari" && (
          <div class="cf-row buttons">
            {plan === "free" ? (
              <button type="button" class="cf-primary" onClick={props.onUpgrade}><Icon.Sparkle size={14} /> {t("getPro")}</button>
            ) : (
              <button type="button" class="cf-secondary" onClick={props.onManage}>{t("manageSubscription")}</button>
            )}
            {plan === "free" && <button type="button" class="cf-link" onClick={props.onManage}>{t("restorePurchases")}</button>}
          </div>
        )}
      </section>

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
          <Segmented value={settings.fab} options={[["auto", t("fabAuto")], ["on", t("fabOn")], ["off", t("fabOff")]]} onChange={(fab) => onChange({ fab })} />
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
        {props.platform !== "ios" && props.platform !== "ipados" && (
          <label class="cf-row toggle">
            <span class="cf-label">{t("setSelectionButton")}</span>
            <input type="checkbox" checked={settings.selectionButton} onChange={(e) => onChange({ selectionButton: e.currentTarget.checked })} />
          </label>
        )}
      </section>

      <section class="cf-group">
        <span class="cf-label">{t("setAbout")}</span>
        <textarea
          class="cf-textarea"
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
            <span class="cf-key">sk-••••••••</span>
            <button type="button" class="cf-secondary" onClick={() => saveKey("")}>{t("remove")}</button>
          </div>
        ) : (
          <div class="cf-row buttons">
            <input
              class="cf-text"
              type="password"
              placeholder="sk-…"
              autoComplete="off"
              spellcheck={false}
              value={keyDraft}
              disabled={!ownKeyAllowed}
              onInput={(e) => setKeyDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button type="button" class="cf-secondary" disabled={!ownKeyAllowed || !/^sk-[\w-]{20,}$/.test(keyDraft.trim())} onClick={() => saveKey(keyDraft)}>
              {keySaved ? t("saved") : t("save")}
            </button>
          </div>
        )}
        <p class="cf-hint">
          {t("setOwnKeyHint")}{" "}
          <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.openAiKeys)}>{t("getKey")}</button>
        </p>
      </section>

      <section class="cf-group">
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

      <footer class="cf-links">
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.review)}>{t("rateApp")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.support)}>{t("support")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.privacy)}>{t("privacyPolicy")}</button>
        <button type="button" class="cf-link" onClick={() => props.onOpenUrl(LINKS.terms)}>{t("terms")}</button>
        <span class="cf-version">{t("version", VERSION)}</span>
      </footer>
    </div>
  )
}
