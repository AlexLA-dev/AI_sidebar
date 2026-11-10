import type { VNode } from "preact"

import { t, uiLanguage, type MessageKey } from "../shared/i18n"
import { tagColor } from "../shared/threads"
import type { OrganizeReply } from "../shared/types"
import * as Icon from "./icons"

export type OrganizeMove = NonNullable<Extract<OrganizeReply, { ok: true }>["move"]>

/** "4 messages", in the language's plural form. */
export function messagesCount(n: number): string {
  let rule: string
  try {
    rule = new Intl.PluralRules(uiLanguage()).select(n)
  } catch {
    rule = n === 1 ? "one" : "other"
  }
  const key: MessageKey = rule === "one" ? "orgCountOne" : rule === "few" ? "orgCountFew" : rule === "many" ? "orgCountMany" : "orgCountOther"
  return t(key, n)
}

/** A message with `name` set apart (bold) where the translation puts it. */
function withName(key: MessageKey, name: string, ...before: Array<string | number>): VNode {
  const [head, tail = ""] = t(key, ...before, "").split("")
  return <>{head}<b>{name}</b>{tail}</>
}

const Arrow = (): VNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v7a4 4 0 0 0 4 4h12M15 10l5 5-5 5" /></svg>
)

/**
 * Where a selection in the panel starts (null: none, or outside the panel). Safari reports a selection in a shadow
 * root on its host; `getComposedRanges` (Safari 17+) gives the real one.
 */
export function panelSelectionStart(root: ShadowRoot): Node | null {
  type Composed = Selection & { getComposedRanges?: (...args: unknown[]) => StaticRange[] }
  const sel = document.getSelection() as Composed | null
  if (!sel || !sel.rangeCount) return null
  let range: AbstractRange | undefined
  if (typeof sel.getComposedRanges === "function") {
    try {
      range = sel.getComposedRanges({ shadowRoots: [root] })[0]
    } catch {
      try {
        range = sel.getComposedRanges(root)[0]
      } catch {
        range = undefined
      }
    }
  }
  range ??= sel.getRangeAt(0)
  return !range.collapsed && root.contains(range.startContainer) ? range.startContainer : null
}

/**
 * Under an answer or a note: what organizing suggests for it, dashed — one of the user's tags (a tap adds it) and,
 * under a block's last message, a better chat or a new one (a tap moves the block); ✕ turns either down.
 */
export function OrganizeRow({ tag, move, name, quiet, onTag, onTagNo, onMove, onMoveNo, onName, onNameNo }: {
  tag?: string
  move?: OrganizeMove
  // 2.6 (91): a better name for the chat (under its last message); taken or turned down like the rest.
  name?: string
  onName?: () => void
  onNameNo?: () => void
  // Text in this message is selected: the row steps aside (keeping its place) for the bubble by the selection.
  quiet?: boolean
  onTag: () => void
  onTagNo: () => void
  onMove: () => void
  onMoveNo: () => void
}): VNode {
  return (
    <div class={`cf-org${quiet ? " quiet" : ""}`} role="group" aria-label={t("orgSuggested")}>
      <span class="cf-org-label">{t("orgSuggested")}</span>
      {tag && (
        <span class={`cf-org-chip c${tagColor(tag)}`}>
          <button type="button" class="cf-org-take" onClick={onTag} aria-label={t("orgTagA11y", tag)}>#{tag}</button>
          <button type="button" class="cf-org-x" onClick={onTagNo} aria-label={t("orgNoA11y")}><Icon.Close /></button>
        </span>
      )}
      {move && (
        <span class="cf-org-chip move">
          <button type="button" class="cf-org-take" onClick={onMove} aria-label={move.why === "merge" ? t("orgMergeA11y", move.toName) : move.to ? t("orgMoveA11y", messagesCount(move.count), move.toName) : t("orgSplitA11y", move.toName)}>
            <Arrow /><span class="cf-org-text">{move.why === "merge" ? withName("orgMergeInto", move.toName) : move.to ? withName("orgMoveTo", move.toName, messagesCount(move.count)) : withName("orgSplit", move.toName)}</span>
            {move.to && move.match !== undefined && <span class="cf-org-match">{t("orgMatch", move.match)}</span>}
          </button>
          <button type="button" class="cf-org-x" onClick={onMoveNo} aria-label={t("orgNoA11y")}><Icon.Close /></button>
        </span>
      )}
      {name && (
        <span class="cf-org-chip move name">
          <button type="button" class="cf-org-take" onClick={onName} aria-label={t("orgNameAs", name)}>
            <Icon.Pencil /><span class="cf-org-text">{withName("orgNameAs", name)}</span>
          </button>
          <button type="button" class="cf-org-x" onClick={onNameNo} aria-label={t("orgNoA11y")}><Icon.Close /></button>
        </span>
      )}
    </div>
  )
}

const still = () => undefined

/**
 * What organizing does, drawn with its real pieces (2.6, the owner: the abstract bars read as placeholder art): a
 * question, the answer and the row the panel really shows under it, a suggested tag and "3 messages to “Trips”"; in a
 * gentle loop the bar after a move takes its place (organize.css; it stays on the row with Reduce Motion). `compact`:
 * the row alone, for the small cards. Not interactive.
 */
export function OrganizePreview({ compact }: { compact?: boolean }): VNode {
  const chat = t("orgDemoChat")
  const row = (
    <OrganizeRow
      tag={t("orgDemoTag")}
      move={{ start: 0, end: 2, to: "sample", toName: chat, why: "topic", count: 3 }}
      onTag={still} onTagNo={still} onMove={still} onMoveNo={still}
    />
  )
  const inert = (el: HTMLElement | null) => el?.setAttribute("inert", "")
  if (compact) return <div ref={inert} class="cf-org-demo compact" aria-hidden="true">{row}</div>
  return (
    <div ref={inert} class="cf-org-demo" aria-hidden="true">
      <div class="cf-org-demo-q">{t("orgDemoQuestion")}</div>
      <div class="cf-org-demo-a">{t("orgDemoAnswer")}</div>
      <div class="cf-org-demo-swap">
        <div class="cf-org-demo-row">{row}</div>
        <div class="cf-org-demo-bar cf-snack"><span>{t("orgMoved", chat)}</span><b>{t("orgUndo")}</b></div>
      </div>
    </div>
  )
}

/**
 * Cards about organizing, under the chat's last message: "consent" — Pro, suggestions off: a switch to turn them on
 * (what they send is in the one AI consent, Consent.tsx, not here); "mess" — not Pro, the chat looks like a pile; "tags" — not
 * Pro, after the third tag. Each is shown once; ✕ (or Not now) closes it for good.
 */
export function OrganizeCard({ kind, pro, onPrimary, onClose }: {
  kind: "consent" | "mess" | "tags"
  // The button for those without Pro ("Try Pro", or the Own key plan's upgrade).
  pro?: string
  onPrimary: () => void
  onClose: () => void
}): VNode {
  if (kind === "consent") {
    return (
      <div class="cf-card cf-org-card" role="region" aria-label={t("orgConsentTitle")}>
        <strong>{t("orgConsentTitle")}</strong>
        <p>{t("orgConsentText")}</p>
        <div class="cf-card-actions">
          <button type="button" class="cf-primary" onClick={onPrimary}>{t("orgTurnOn")}</button>
          <button type="button" class="cf-secondary" onClick={onClose}>{t("offerLater")}</button>
        </div>
      </div>
    )
  }
  return (
    <div class="cf-card cf-org-card promo" role="region" aria-label={t(kind === "mess" ? "orgMessTitle" : "orgTagsTitle")}>
      <button type="button" class="cf-org-close" onClick={onClose} aria-label={t("orgCloseA11y")}><Icon.Close /></button>
      <div class="cf-org-promo">
        <div>
          <strong>{t(kind === "mess" ? "orgMessTitle" : "orgTagsTitle")}</strong>
          <p>{t(kind === "mess" ? "orgMessText" : "orgTagsText")}</p>
        </div>
      </div>
      <OrganizePreview compact />
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onPrimary}><Icon.Sparkle size={14} /> {pro ?? t("getPro")}</button>
      </div>
    </div>
  )
}
