import type { ComponentChildren, VNode } from "preact"

import { t } from "../shared/i18n"
import { revealHint } from "./hintReveal"

/**
 * A "first time here" hint (the advanced level of the onboarding; the tour is the basic one): what
 * isn't obvious about a part of the panel, shown once, the first time the user gets there. 2.7: a few short lines
 * (`list`), and a way on (`action`: All tips opens the Tips sheet, so hints and Tips point to each other).
 */
export function Hint({ icon, title, children, list, action, onDone, reveal }: {
  icon: VNode
  title: string
  children?: ComponentChildren
  list?: string[]
  action?: { label: string; run: () => void }
  onDone: () => void
  // At the chat's end: scrolled into sight once as it shows (2.7, the director's acceptance of 108: after the first-run
  // tour was skipped, the hint under the chips came half hidden by the input's border).
  reveal?: boolean
}): VNode {
  return (
    <div class="cf-hint" role="note" ref={reveal ? revealHint : undefined}>
      <span class="cf-hint-icon">{icon}</span>
      <div class="cf-hint-text">
        <strong>{title}</strong>
        {children !== undefined && <p>{children}</p>}
        {list && list.length > 0 && <ul class="cf-hint-list">{list.map((line) => <li key={line}>{line}</li>)}</ul>}
        {action && <button type="button" class="cf-link cf-hint-more" onClick={action.run}>{action.label}</button>}
      </div>
      <button type="button" class="cf-link cf-hint-done" onClick={onDone}>{t("hintGot")}</button>
    </div>
  )
}
