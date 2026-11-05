// The one consent to ContextFlow's AI (2.5 (78), the owner: "let it be given once, saying which features it
// covers"). The same card wherever something would go to the AI for the first time: the panel's answers and AI
// search, quick insert's templates (marking the blanks, "Fill from the page", "Find by meaning"). Given once, it
// covers them all; no feature has a consent of its own. What it lists matches site/privacy.html, section 2.

import type { VNode } from "preact"

import { LINKS } from "../shared/config"
import { t, type MessageKey } from "../shared/i18n"
import { sendBackground } from "./insert/store"

/** What goes where, feature by feature. */
const ITEMS: MessageKey[] = ["consentAnswers", "consentChats", "consentTemplates", "consentWatch", "consentSuggest"]

/** `again`: agreed to an earlier text, asked once more for this one. */
export function ConsentCard({ again, onAccept, onDecline }: { again: boolean; onAccept: () => void; onDecline: () => void }): VNode {
  return (
    <div class="cf-card consent" role="region" aria-label={t(again ? "consentAgainTitle" : "consentTitle")}>
      <strong>{t(again ? "consentAgainTitle" : "consentTitle")}</strong>
      <p>{t("consentBody")}</p>
      <ul class="cf-consent-list">
        {ITEMS.map((key) => <li key={key}>{t(key)}</li>)}
      </ul>
      <p>{t("consentStored")}</p>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onAccept}>{t("consentAccept")}</button>
        <button type="button" class="cf-link" onClick={onDecline}>{t("consentDecline")}</button>
        <button type="button" class="cf-link" onClick={() => void sendBackground({ type: "openUrl", url: LINKS.privacy })}>{t("privacyPolicy")}</button>
      </div>
    </div>
  )
}
