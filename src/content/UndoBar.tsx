import type { VNode } from "preact"

/**
 * The bar over the question field after something that can be taken back ("Moved to “Trips” · Undo · Open"), in the
 * one look of toasts and bars (.cf-snack, the panel's inverse in either theme). It only draws: App takes it away
 * after its seconds (undoClock.ts) or on the next action, and holds it while a pointer rests on it (`onHold`). The
 * app has the same (UndoBar.swift).
 */
export function UndoBar({ text, actions, onHold }: {
  text: string
  actions: Array<{ label: string; run: () => void }>
  onHold?: (on: boolean) => void
}): VNode {
  return (
    <div
      class="cf-undo-bar cf-snack"
      role="status"
      aria-live="polite"
      onPointerEnter={onHold && (() => onHold(true))}
      onPointerLeave={onHold && (() => onHold(false))}
    >
      <span>{text}</span>
      {actions.map((a) => (
        <button type="button" key={a.label} onClick={a.run}>{a.label}</button>
      ))}
    </div>
  )
}
