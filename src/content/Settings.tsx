import type { ComponentChildren, VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { LINKS, TARGET, VERSION } from "../shared/config"
import { t, uiDirection, uiLang } from "../shared/i18n"
import { OWN_KEY_PATTERN } from "../shared/models"
import { hasPro, isUltra, periodOfProduct, productOf } from "../shared/plan"
import type { Platform, Settings, StatusInfo, Usage } from "../shared/types"
import * as Icon from "./icons"
import { deleteAllChats, hideYearly, yearlyHiddenNow } from "./store"
import { InsertSettingsGroup } from "./insert/InsertSettings"
import { sendBackground } from "./insert/store"
import { hintsOn, setHintsOn } from "./pagehints/store"
import { resolveSide } from "./side/snap"
import { InviteGroup } from "./invite/Invite"
import { AccessGroup } from "./agent/AppleAccess"
import { MyDetailsGroup } from "./agent/MyDetails"
import { CookieGroup } from "./cookies/CookieSettings"
import { cookieSettings } from "./cookies/auto"
import { keptOpen, OPEN_FIRST, OPEN_KEY, SECTIONS, type SettingsAt, type SettingsSection, toggled } from "./settingsFold"
import { SpentCount, usageText } from "./quiet/Spent"

interface Props {
  settings: Settings
  status: StatusInfo | null
  usage: Usage | null
  // 110: the usage read fresh, for what the answers went on.
  loadSpent?: () => Promise<Usage | null>
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
  // 2.7, invite a friend: an App Store offer code (the inviter's reward) to the App Store's redeem sheet.
  onRedeem: (code: string) => void
  // 2.7.1: Settings opened at one setting (a link elsewhere in the panel): its section unfolds and it comes into view.
  at?: SettingsAt | null
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
  // In the interface's language, like the sentence it goes into (2.7, the director's audit).
  const renews = status?.store?.expiresAt ? new Date(status.store.expiresAt).toLocaleDateString(uiLang()) : null
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
      {/* 110: the count in words; a tap shows what the answers went on (quiet/Spent.tsx). */}
      {usage && plan !== "byok" && props.loadSpent && (
        <SpentCount
          cls="cf-set-spent"
          text={usageText(usage, plan)}
          load={props.loadSpent}
          paid={hasPro(plan)}
          onOpen={() => void sendBackground({ type: "useEvent", f: "quiet", a: "spent", via: "settings" })}
        />
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

  const buttonGroup = (
    <>
      <section class="cf-group">
        <div class="cf-row">
          <span class="cf-label">{t("setFab")}</span>
          <Segmented value={settings.fab === "off" ? "off" : "on"} options={[["on", t("fabOn")], ["off", t("fabOff")]]} onChange={(fab) => onChange({ fab })} />
        </div>
        <p class="cf-hint">{t("setFabHint")}</p>
        {/* 2.7: the side of the screen for the circle and, on iPad and Mac, the panel (they can be dragged there too). */}
        <div class="cf-row">
          <span class="cf-label">{t("setSide")}</span>
          <Segmented value={resolveSide(settings, uiDirection())} options={[["right", t("sideRight")], ["left", t("sideLeft")]]} onChange={(fabSide) => onChange({ fabSide, fabSideChosen: true })} />
        </div>
        <div class="cf-row">
          <button
            type="button"
            class="cf-link"
            onClick={() => onChange({ fabHiddenSites: hidden ? settings.fabHiddenSites.filter((s) => s !== site) : [...settings.fabHiddenSites, site].slice(-200) })}
          >
            {hidden ? t("showOnSite", site) : t("hideOnSite", site)}
          </button>
        </div>
        {/* 2.7 (plan section 6): the page hints by the circle, the first days (off: also by two ✕ in a row). */}
        <PageHintsSwitch />
        <label class="cf-row toggle">
          <span class="cf-label">{t("setSelectionButton")}</span>
          <input type="checkbox" checked={settings.selectionButton} onChange={(e) => onChange({ selectionButton: e.currentTarget.checked })} />
        </label>
      </section>
    </>
  )
  const aboutGroup = (
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
  )
  const ownKeyGroup = (
    <section class="cf-group" data-set-at="ownKey">
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
          {/* Not a password field (109): Safari took the key for a password and asked «Save Password?», with a
              user name to enter, right after Save. The text is hidden the same way by the style. */}
          <input
            class="cf-text cf-secret"
            type="text"
            placeholder="sk-… / sk-ant-…"
            autoComplete="off"
            autocorrect="off"
            autocapitalize="off"
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
  )
  const chatsGroup = (
    <>
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
    </>
  )
  const dataGroup = (
    <section class="cf-group">
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
  )

  // 2.7.1 (the owner on build 121: «настроек стало очень много, их бы группировать по функционалу и сворачивать, как
  // в Tips»): the groups go in sections by feature, each folding like a Tips block, which are open kept on this
  // device (settingsFold.ts). A folded one says in a line what's in it. Every setting and what it does is as before.
  const [open, setOpen] = useState<SettingsSection[] | null>(null)
  useEffect(() => void foldedOpen().then((kept) => setOpen(props.at ? toggled(kept, SECTIONS[props.at], true) : kept)), [])
  const toggle = (id: SettingsSection) => {
    const next = toggled(open ?? [], id)
    setOpen(next)
    keepOpen(next)
  }
  const isOpen = (id: SettingsSection) => open?.includes(id) ?? false
  // The cookie switch's state, for its section's line (read again whenever a section folds or unfolds).
  const [cookiesOn, setCookiesOn] = useState<boolean | null>(null)
  useEffect(() => void cookieSettings().then((c) => setCookiesOn(!c.off)), [open?.join()])
  // Opened at a setting: it's scrolled to within Settings' own list (scrollIntoView would move the panel's fixed frame).
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!props.at || !open) return
    const place = () => {
      const list = box.current
      const el = list?.querySelector<HTMLElement>(`[data-set-at="${props.at}"]`)
      if (list && el) list.scrollTop = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 8
    }
    place()
    // Again once the groups that read their state first (My details, the access rows) have their height.
    const later = window.setTimeout(place, 300)
    return () => window.clearTimeout(later)
  }, [open !== null])

  const onOff = (on: boolean) => (on ? t("fabOn") : t("fabOff"))
  const themeName = settings.theme === "dark" ? t("themeDark") : settings.theme === "light" ? t("themeLight") : t("themeAuto")
  const fold = (id: SettingsSection, title: string, summary: string, children: ComponentChildren) => (
    <Fold id={id} title={title} summary={summary} open={isOpen(id)} onToggle={() => toggle(id)}>{children}</Fold>
  )

  const planSection = fold("plan", t("setSecPlan"), status?.hasOwnKey && plan !== "byok" ? `${planName} · ${t("planByok")}` : planName, (
    <>
      {planGroup}
      {ownKeyGroup}
      {/* 2.7 (plan section 5): invite a friend, optional; a new install enters a friend's code here too. */}
      {TARGET === "safari" && <InviteGroup onRedeem={props.onRedeem} onStatusChange={props.onStatusChange} />}
    </>
  ))

  return (
    <div ref={box} class="cf-settings">
      {open && (
        <>
          {/* The plan comes first until there is Pro; with Pro it's managed near the bottom. */}
          {!hasPro(plan) && planSection}

          {fold("general", t("setSecGeneral"), `${themeName} · ${settings.textSize === "large" ? t("sizeLarge") : t("sizeNormal")}`, (
            <>
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
              {aboutGroup}
            </>
          ))}

          {fold("button", t("setSecButton"), `${onOff(settings.fab !== "off")} · ${resolveSide(settings, uiDirection()) === "left" ? t("sideLeft") : t("sideRight")}`, buttonGroup)}

          {fold("writing", t("setSecWriting"), `${t("qiTitle")} · ${t("writeSetting")}`, (
            <InsertSettingsGroup site={site} touch={props.platform === "ios" || props.platform === "ipados"} onOpenTemplates={props.onOpenTemplates} />
          ))}

          {fold("agent", t("setSecAgent"), `${t("fdTitle")} · ${t("accessGroup")}`, (
            <>
              {/* 2.7.1: «Мои данные» for the agent's forms (Pro and Ultra have the agent; the details are kept anyway). */}
              <MyDetailsGroup />
              {/* 2.7.1: Calendar and Reminders, seen and allowed here (the app asks the system). */}
              <div data-set-at="access"><AccessGroup /></div>
            </>
          ))}

          {/* 2.7.1: cookie banners answered with «only necessary», and the site to leave them on. */}
          {fold("cookies", t("setSecCookies"), cookiesOn === null ? "" : onOff(cookiesOn), <CookieGroup site={site} />)}

          {fold("chats", t("setSecChats"), [
            TARGET === "safari" && hasPro(plan) ? `${t("setOrganize")}: ${onOff(settings.organize)}` : "",
            `${t("setSpaces")}: ${onOff(settings.spaces !== false)}`
          ].filter(Boolean).join(" · "), chatsGroup)}

          {fold("data", t("setSecData"), TARGET === "safari" ? `iCloud: ${onOff(settings.syncChats)}` : t("deleteChats"), dataGroup)}

          {hasPro(plan) && planSection}

          {fold("about", t("setSecAbout"), t("version", VERSION), (
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
          ))}
        </>
      )}
    </div>
  )
}

/** A section of Settings: its head folds it (as a Tips block); folded, a line says what's in it. */
function Fold({ id, title, summary, open, onToggle, children }: { id: SettingsSection; title: string; summary: string; open: boolean; onToggle: () => void; children: ComponentChildren }): VNode {
  return (
    <section class={`cf-set-sec ${open ? "open" : ""}`} data-sec={id}>
      <button type="button" class="cf-set-head" aria-expanded={open} onClick={onToggle}>
        <span class="cf-set-head-text">
          <span class="cf-set-title">{title}</span>
          {!open && summary && <span class="cf-set-sum">{summary}</span>}
        </span>
        <svg class="cf-set-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && <div class="cf-set-body">{children}</div>}
    </section>
  )
}

/** The page hints' switch (2.7): kept with the hints' own state on this device (src/content/pagehints/store.ts). */
function PageHintsSwitch(): VNode {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => void hintsOn().then(setOn), [])
  if (on === null) return <></>
  return (
    <>
      <label class="cf-row toggle">
        <span class="cf-label">{t("setPageHints")}</span>
        <input type="checkbox" checked={on} onChange={(e) => {
          const next = e.currentTarget.checked
          setOn(next)
          void setHintsOn(next)
          void sendBackground({ type: "useEvent", f: "page_hint", a: next ? "switch_on" : "switch_off" })
        }} />
      </label>
      <p class="cf-hint">{t("setPageHintsHint")}</p>
    </>
  )
}

/** Which sections are open on this device (settingsFold.ts). */
async function foldedOpen(): Promise<SettingsSection[]> {
  try {
    return keptOpen((await chrome.storage.local.get(OPEN_KEY))[OPEN_KEY])
  } catch {
    return [...OPEN_FIRST]
  }
}

function keepOpen(open: SettingsSection[]): void {
  try {
    void chrome.storage.local.set({ [OPEN_KEY]: open })
  } catch {
    // Kept while Settings is open.
  }
}
