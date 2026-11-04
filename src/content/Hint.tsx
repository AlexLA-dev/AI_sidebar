import type { ComponentChildren, VNode } from "preact"

import { t } from "../shared/i18n"

/**
 * A "first time here" hint (the advanced level of the onboarding; the tour is the basic one): what
 * isn't obvious about a part of the panel, shown once, the first time the user gets there.
 */
export function Hint({ icon, title, children, onDone }: { icon: VNode; title: string; children: ComponentChildren; onDone: () => void }): VNode {
  return (
    <div class="cf-hint" role="note">
      <span class="cf-hint-icon">{icon}</span>
      <div class="cf-hint-text">
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      <button type="button" class="cf-link cf-hint-done" onClick={onDone}>{t("hintGot")}</button>
    </div>
  )
}
