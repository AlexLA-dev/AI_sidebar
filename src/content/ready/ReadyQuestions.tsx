// 2.8 (В4.1, В4.2, В6.2, В6.3): the empty panel is never an empty field. Two or three questions about this page by its
// kind, one tap each; «Continue «…»» for the chat the person was in last; and, before the consent is given, the same
// consent text the card has, with each question saying «Agree and ask»: the tap gives the consent and asks, still
// explicit, with no card of its own.

import type { VNode } from "preact"
import { useEffect } from "preact/hooks"

import { LINKS } from "../../shared/config"
import { t, type MessageKey } from "../../shared/i18n"
import { sendBackground } from "../insert/store"

export interface ReadyProps {
  questions: readonly MessageKey[]
  // The consent isn't given yet: each question gives it (the text says so).
  consentFirst: boolean
  // Given before for an older text: the same, asked once more.
  again: boolean
  onAsk: (text: string) => void
  // The chat the person was in last (not this page's), to go back to.
  last?: { name: string; open: () => void } | null
}

export function ReadyQuestions({ questions, consentFirst, again, onAsk, last }: ReadyProps): VNode {
  useEffect(() => {
    if (consentFirst) void sendBackground({ type: "useEvent", f: "consent", a: "shown", via: "ready", ...(again ? { step: 2 } : {}) })
  }, [consentFirst])
  return (
    <div class="cf-ready" role="group" aria-label={t("rqTitle")}>
      {questions.map((key) => (
        <button type="button" key={key} class="cf-ready-q" dir="auto" onClick={() => {
          if (consentFirst) void sendBackground({ type: "useEvent", f: "consent", a: "accepted", via: "ready", ...(again ? { step: 2 } : {}) })
          onAsk(t(key))
        }}>
          <span class="cf-ready-text">{t(key)}</span>
          {consentFirst && <span class="cf-ready-agree">{t("rqAgree")}</span>}
        </button>
      ))}
      {last && (
        <button type="button" class="cf-ready-q cf-ready-last" dir="auto" onClick={last.open}>
          <span class="cf-ready-text">{t("rqContinue", last.name)}</span>
        </button>
      )}
      {consentFirst && (
        <p class="cf-ready-consent">
          {t("consentBody")} {t("rqAgreeNote")}{" "}
          <button type="button" class="cf-link cf-consent-policy" onClick={() => void sendBackground({ type: "openUrl", url: LINKS.privacy })}>{t("privacyPolicy")}</button>
        </p>
      )}
    </div>
  )
}
