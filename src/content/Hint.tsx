import type { ComponentChildren, VNode } from "preact"
import { useState } from "preact/hooks"

import { t } from "../shared/i18n"

/**
 * A "first time here" hint (the advanced level of the onboarding; the tour is the basic one): what
 * isn't obvious about a part of the panel, shown once, the first time the user gets there. 2.7: a few short lines
 * (`list`), and a way on (`action`: All tips opens the Tips sheet, so hints and Tips point to each other).
 *
 * `line` (2.7 after build 107, the compact chat): one line, its title with «Show» and a close, so the hint never takes
 * the chat from an answer or the quick actions (the owner's 107 frame had «New in ContextFlow 2.7» over half the
 * panel). «Show» opens it as the card it was; × puts it away for good, as «Got it» does. The × is named with the
 * hint's title («Close: New in ContextFlow 2.7»): the panel's own Close is a few lines above it for VoiceOver.
 */
export function Hint({ icon, title, children, list, action, line = false, onDone }: {
  icon: VNode
  title: string
  children?: ComponentChildren
  list?: string[]
  action?: { label: string; run: () => void }
  line?: boolean
  onDone: () => void
}): VNode {
  const [open, setOpen] = useState(false)
  if (line && !open) {
    return (
      <div class="cf-hint line" role="note">
        <span class="cf-hint-icon">{icon}</span>
        <button type="button" class="cf-hint-open" aria-expanded={false} onClick={() => setOpen(true)}>
          <strong>{title}</strong>
          <span class="cf-link">{t("hintShow")}</span>
        </button>
        <button type="button" class="cf-hint-x" aria-label={`${t("close")}: ${title}`} title={t("close")} onClick={onDone}>×</button>
      </div>
    )
  }
  return (
    <div class="cf-hint" role="note">
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
