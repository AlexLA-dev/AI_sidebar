// 2.6 (100), the owner: «при обнаружении в чате предложения по структурированию чат перескакивает вверх, в начало, что
// неудобно и дергано». The place being read stays where it is while the chat's suggestions come, change and go (the
// bar at the top, the rows under messages) and while one is taken or undone: the messages at the top of the list,
// under its bars, keep their places on screen. Safari has no scroll anchoring: a bar or a row put in above the place
// moved the text by its height.

export interface ReadingPlace {
  // The first messages under the bars, from the one at the top: each by its key, with its top against the list's top.
  at: Array<{ key: string; top: number }>
}

// A few, in case the first is the one that goes (a move of the block being read).
const KEPT = 4

/** Where `list` is being read: its first messages under the bars at its top. `keyOf` gives the key of the message the
 * list shows at an index. */
export function readingPlace(list: HTMLElement, keyOf: (index: number) => string | undefined): ReadingPlace | null {
  const box = list.getBoundingClientRect()
  const bars = list.querySelector<HTMLElement>(":scope > .cf-topbars, :scope > .cf-pinbar")
  const from = bars ? bars.getBoundingClientRect().bottom : box.top
  const at: ReadingPlace["at"] = []
  for (const el of list.querySelectorAll<HTMLElement>(":scope > .cf-msg[data-index]")) {
    const r = el.getBoundingClientRect()
    if (r.bottom <= from) continue
    if (r.top >= box.bottom || at.length >= KEPT) break
    const key = keyOf(Number(el.dataset.index))
    if (key) at.push({ key, top: r.top - box.top })
  }
  return at.length ? { at } : null
}

/** After the change: the list scrolled so the place's first message still in the chat sits where it did. `indexOf`
 * gives a message's index in the chat now (-1 when it's gone). */
export function keepReadingPlace(list: HTMLElement, place: ReadingPlace, indexOf: (key: string) => number): void {
  for (const { key, top } of place.at) {
    const index = indexOf(key)
    const el = index >= 0 ? list.querySelector<HTMLElement>(`:scope > .cf-msg[data-index="${index}"]`) : null
    if (!el) continue
    const shift = el.getBoundingClientRect().top - list.getBoundingClientRect().top - top
    if (Math.abs(shift) >= 1) list.scrollTop += shift
    return
  }
}
