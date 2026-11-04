import type { VNode } from "preact"

/**
 * The bar over the question field after something that can be taken back ("Moved to “Trips” · Undo · Open"), in the
 * one look of toasts and bars (.cf-snack, the panel's inverse in either theme). It only draws: App takes it away
 * after its seconds or on the next action. The app has the same (UndoBar.swift).
 */
export function UndoBar({ text, actions }: { text: string; actions: Array<{ label: string; run: () => void }> }): VNode {
  return (
    <div class="cf-undo-bar cf-snack" role="status" aria-live="polite">
      <span>{text}</span>
      {actions.map((a) => (
        <button type="button" key={a.label} onClick={a.run}>{a.label}</button>
      ))}
    </div>
  )
}
