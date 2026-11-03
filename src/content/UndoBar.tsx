import type { VNode } from "preact"

/**
 * The dark bar over the question field after something that can be taken back ("Moved to “Trips” · Undo · Open").
 * It only draws: whoever shows it takes it away on the next action. The app has the same (UndoBar.swift).
 */
export function UndoBar({ text, actions }: { text: string; actions: Array<{ label: string; run: () => void }> }): VNode {
  return (
    <div class="cf-undo-bar" role="status" aria-live="polite">
      <span>{text}</span>
      {actions.map((a) => (
        <button type="button" key={a.label} onClick={a.run}>{a.label}</button>
      ))}
    </div>
  )
}
