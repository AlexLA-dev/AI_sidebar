// The cookie closer in Settings (2.7.1): the switch «Закрывать окна cookie» (on by default, for new and existing
// users), its hint, and the site exception «Не закрывать на этом сайте». Kept on this device (cf:cookies).

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { closesOn, siteKey, withSite, type CookieState } from "../../shared/cookies/state"
import { t } from "../../shared/i18n"
import { sendBackground } from "../insert/store"
import { cookieSettings, setCookieSettings } from "./auto"

const step = (a: string) => void sendBackground({ type: "useEvent", f: "cookies", a })

export function CookieGroup({ site }: { site: string }): VNode {
  const [state, setState] = useState<CookieState | null>(null)
  useEffect(() => void cookieSettings().then(setState), [])
  if (!state) return <></>
  const on = !state.off
  const here = closesOn({ ...state, off: false }, site)
  return (
    <section class="cf-group">
      <label class="cf-row toggle">
        <span class="cf-label">{t("setCookies")}</span>
        <input type="checkbox" checked={on} onChange={(e) => {
          const next = e.currentTarget.checked
          void setCookieSettings((s) => ({ ...s, off: !next })).then(setState)
          step(next ? "switch_on" : "switch_off")
        }} />
      </label>
      <p class="cf-hint">{t("setCookiesHint")}</p>
      {/* 121, the owner: «в настройках выключаемую опцию Принять все, если нет других вариантов» (off by default). */}
      {on && (
        <label class="cf-row toggle">
          <span class="cf-label">{t("setCookiesAccept")}</span>
          <input type="checkbox" checked={state.accept === true} onChange={(e) => {
            const next = e.currentTarget.checked
            void setCookieSettings((s) => ({ ...s, accept: next })).then(setState)
            step(next ? "accept_on" : "accept_off")
          }} />
        </label>
      )}
      {on && site && (
        <div class="cf-row">
          <button type="button" class="cf-link" onClick={() => {
            void setCookieSettings((s) => withSite(s, site, !here)).then(setState)
            step(here ? "site_off" : "site_on")
          }}>
            {here ? t("cookiesOffOnSite", siteKey(site)) : t("cookiesOnOnSite", siteKey(site))}
          </button>
        </div>
      )}
    </section>
  )
}
