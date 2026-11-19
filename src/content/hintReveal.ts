// A hint at the chat's end brought into sight once, as it shows (2.7, the director's acceptance of 108: after the
// first-run tour was skipped, the hint under the chips came half hidden by the input's border). Only the chat's list
// scrolls: scrollIntoView also scrolled the panel's own fixed frame and pushed the sheet down the screen.

/** Brought into sight in the chat once, as it shows (the page hints' how-to uses it too). */
export function revealHint(el: HTMLElement | null): void {
  if (!el || el.dataset.revealed) return
  el.dataset.revealed = "1"
  // The chat's list alone is scrolled (scrollIntoView also scrolled the panel's fixed frame and pushed the sheet down).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const list = el.closest<HTMLElement>(".cf-messages")
    if (!list) return
    const by = revealBy(el.getBoundingClientRect(), list.getBoundingClientRect())
    if (by !== 0) list.scrollTo({ top: list.scrollTop + by, behavior: "smooth" })
  }))
}

/** How far the list scrolls to bring the hint into sight: its bottom to the list's (its top, when it's taller). */
export function revealBy(hint: { top: number; bottom: number }, list: { top: number; bottom: number }): number {
  const pad = 8
  if (hint.bottom + pad <= list.bottom && hint.top >= list.top) return 0
  if (hint.bottom - hint.top + 2 * pad > list.bottom - list.top) return hint.top - list.top - pad
  return hint.bottom + pad - list.bottom
}
