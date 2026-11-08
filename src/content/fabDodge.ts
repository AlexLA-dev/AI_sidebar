// The round button and the selection buttons (build 89, the owner: "sometimes the selection pop-up covers the round
// button; it must always be visible"). The selection buttons stay by the selection, and on iPhone they're nearly as
// wide as the screen, so it's the round button that steps out of their way, up or down to the nearest free place, and
// back once they're gone. Pure, for tests (tests/fab-dodge.test.mts).

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

const overlaps = (a: Box, b: Box, air: number) =>
  a.left < b.right + air && a.right > b.left - air && a.top < b.bottom + air && a.bottom > b.top - air

/**
 * Where the button's center goes while the selection buttons show, or null when they leave it alone.
 * `fab` is the button at its own place, `view` the visible part of the screen (top and bottom). The new place clears
 * the selection buttons and, when it can, the selection itself; of those, the one nearest its own place.
 */
export function dodgeFab(fab: Box, bubble: Box, selection: Box | null, view: { top: number; bottom: number }, air = 8): number | null {
  if (!overlaps(fab, bubble, air)) return null
  const half = (fab.bottom - fab.top) / 2
  const home = fab.top + half
  const at = (center: number): Box => ({ ...fab, top: center - half, bottom: center + half })
  const fits = (center: number) => center - half >= view.top + air && center + half <= view.bottom - air
  const candidates = [bubble.top - air - half, bubble.bottom + air + half]
  // Clear of the selection too, if there's such a place; then the nearer one.
  if (selection) {
    const sel = selection
    // Just past the selection, either side of it.
    candidates.push(sel.top - air - half, sel.bottom + air + half)
  }
  const free = candidates.filter((c) => fits(c) && !overlaps(at(c), bubble, air / 2))
  const best = (list: number[]) => list.sort((a, b) => Math.abs(a - home) - Math.abs(b - home))[0]
  const clearOfAll = free.filter((c) => !selection || !overlaps(at(c), selection, 0))
  const pick = best(clearOfAll) ?? best(free)
  if (pick !== undefined) return pick
  // No room above or below them (a tall pop-up on a short landscape screen): the screen's edge farther from them.
  const roomAbove = bubble.top - view.top
  const roomBelow = view.bottom - bubble.bottom
  return roomAbove > roomBelow ? view.top + air + half : view.bottom - air - half
}
