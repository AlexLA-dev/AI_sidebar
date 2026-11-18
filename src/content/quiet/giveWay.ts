// The order the row under a message gives way in (ToolsRow.tsx), apart so the tests can run it.

/** One step of giving way: the buttons closer, one label off (its data-give), or one button out of the row (data-drop). */
export type Step = { tight: true } | { give: number } | { drop: string }

/**
 * The steps in order (pure, for the tests): closer; the words of the buttons that can leave; those buttons, the lowest
 * data-drop first; then the other words, the lowest data-give first. `buttons`: each button's data-give (null: no
 * words) and data-drop (null: it stays) and its name.
 */
export function giveWay(buttons: Array<{ give: number | null; drop: string | null; order: number | null }>): Step[] {
  const gives = (leaving: boolean) => buttons
    .filter((b) => b.give !== null && (b.drop !== null) === leaving)
    .map((b) => b.give as number)
    .sort((a, b) => a - b)
    .map((give): Step => ({ give }))
  const drops = buttons
    .filter((b) => b.drop !== null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b): Step => ({ drop: b.drop as string }))
  return [{ tight: true }, ...gives(true), ...drops, ...gives(false)]
}
