import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { siteKey } from "../../shared/copied"
import { t } from "../../shared/i18n"
import { DEFAULT_INSERT_SETTINGS, type InsertSettings } from "../../shared/insert"
import { clearCopied, loadInsertSettings, onInsertSettings, saveInsertSettings } from "./store"
import { signFor } from "./trigger"

/** Quick insert in Settings: the button by fields, Copied, the sign, the shortcut, the sites left out. */
export function InsertSettingsGroup({ site, touch, onOpenTemplates }: { site: string; touch: boolean; onOpenTemplates: () => void }): VNode {
  const [s, setS] = useState<InsertSettings>(DEFAULT_INSERT_SETTINGS)
  const [sign, setSign] = useState(DEFAULT_INSERT_SETTINGS.sign)
  const [cleared, setCleared] = useState(false)
  useEffect(() => {
    void loadInsertSettings().then((v) => {
      setS(v)
      setSign(v.sign)
    })
    return onInsertSettings(setS)
  }, [])
  const change = (patch: Partial<InsertSettings>) => void saveInsertSettings(patch).then(setS)
  const host = siteKey(site)
  const buttonOff = s.buttonOffSites.includes(host)
  const here = signFor(site, s.sign)

  return (
    <section class="cf-group">
      <div class="cf-row">
        <span class="cf-label">{t("qiTitle")}</span>
        <button type="button" class="cf-link" onClick={onOpenTemplates}>{t("qiAllTemplates")}</button>
      </div>
      {touch && (
        <>
          <label class="cf-row toggle">
            <span class="cf-label">{t("qiSetButton")}</span>
            <input type="checkbox" checked={s.button} onChange={(e) => change({ button: e.currentTarget.checked })} />
          </label>
          {s.button && host && (
            <div class="cf-row">
              <button type="button" class="cf-link" onClick={() => change({ buttonOffSites: buttonOff ? s.buttonOffSites.filter((x) => x !== host) : [...s.buttonOffSites, host].slice(-200) })}>
                {buttonOff ? t("showOnSite", host) : t("hideOnSite", host)}
              </button>
            </div>
          )}
        </>
      )}
      <label class="cf-row toggle">
        <span class="cf-label">{t("qiKeepCopied")}</span>
        <input type="checkbox" checked={s.copied} onChange={(e) => change({ copied: e.currentTarget.checked })} />
      </label>
      <p class="cf-hint">{t("qiSetCopiedHint")}</p>
      {s.copiedOffSites.length > 0 && (
        <div class="cf-qi-sites">
          {s.copiedOffSites.map((x) => (
            <button type="button" class="cf-qi-chip" title={t("qiKeepOnSite", x)} onClick={() => change({ copiedOffSites: s.copiedOffSites.filter((y) => y !== x) })}>{x} ✕</button>
          ))}
        </div>
      )}
      <div class="cf-row">
        <button type="button" class="cf-link" onClick={() => void clearCopied().then(() => {
          setCleared(true)
          setTimeout(() => setCleared(false), 1500)
        })}>{cleared ? t("qiCleared") : t("qiClearCopied")}</button>
      </div>
      <div class="cf-row">
        <span class="cf-label">{t("qiSetSign")}</span>
        <input
          class="cf-qi-sign"
          value={sign}
          maxLength={3}
          aria-label={t("qiSetSign")}
          onInput={(e) => setSign(e.currentTarget.value)}
          onBlur={() => change({ sign: sign.trim() || "/" })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <p class="cf-hint">{t("qiSetSignHint", here)} {t("qiSetShortcut")}</p>
    </section>
  )
}
