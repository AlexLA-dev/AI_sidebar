// The one consent to ContextFlow's AI (2.5 (78), the owner: "let it be given once, saying which features it
// covers"). The same card wherever something would go to the AI for the first time: the panel's answers and AI
// search, quick insert's templates (marking the blanks, "Fill from the page", "Find by meaning"). Given once, it
// covers them all; no feature has a consent of its own. What it lists matches site/privacy.html, section 2.
//
// Compact (the director, after 78: a card two screens long before the first answer costs activation): the title,
// two or three lines and the buttons in view at once, on an iPhone's 375 pt with the question box; what each
// feature sends folds out under "What exactly is sent", folded at first.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { LINKS } from "../shared/config"
import { t, type MessageKey } from "../shared/i18n"
import { sendBackground } from "./insert/store"

/** What goes where, feature by feature. */
export const CONSENT_ITEMS: MessageKey[] = ["consentAnswers", "consentChats", "consentTemplates", "consentWatch", "consentSuggest"]

let lists = 0

const Chevron = (): VNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
)

/** Scrolls the nearest scrolling box around `card` so all of it shows (its top first when it's taller than the box). */
function showIn(card: HTMLElement): void {
  let box = card.parentElement
  while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  if (!box) return
  const c = card.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  if (c.bottom > b.bottom) box.scrollTop += Math.min(c.bottom - b.bottom + 8, c.top - b.top)
  else if (c.top < b.top) box.scrollTop -= b.top - c.top
}

/** `again`: agreed to an earlier text, asked once more for this one. */
export function ConsentCard({ again, onAccept, onDecline }: { again: boolean; onAccept: () => void; onDecline: () => void }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [listId] = useState(() => `cf-consent-list-${++lists}`)
  // Shown under the chips or the last answer: its list scrolls to it, buttons and all (only the list, never the page).
  useEffect(() => {
    const card = ref.current
    if (card) showIn(card)
  }, [])
  const title = t(again ? "consentAgainTitle" : "consentTitle")
  return (
    <div ref={ref} class="cf-card consent" role="region" aria-label={title}>
      <strong>{title}</strong>
      <p>{t("consentBody")}</p>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onAccept}>{t("consentAccept")}</button>
        <button type="button" class="cf-link" onClick={onDecline}>{t("consentDecline")}</button>
      </div>
      <div class="cf-consent-foot">
        <button type="button" class={`cf-consent-more ${open ? "open" : ""}`} aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {t("consentWhat")} <Chevron />
        </button>
        <button type="button" class="cf-link" onClick={() => void sendBackground({ type: "openUrl", url: LINKS.privacy })}>{t("privacyPolicy")}</button>
      </div>
      {open && (
        <div id={listId} class="cf-consent-details">
          <ul class="cf-consent-list">
            {CONSENT_ITEMS.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
          <p>{t("consentStored")}</p>
        </div>
      )}
    </div>
  )
}
