// A selection the person put away themselves (2.7 (108), the owner in Gmail: «Закрываю панель, убираю выделения текста
// письма, открываю панель – текст снова выделен… Если снова убрать выделения и снова открыть панель – ситуация
// повторится»). The latest selection is remembered for a while after the page loses it, because our own controls take
// it away: a tap on the round button or the selection's buttons on iPhone, the panel's field, the system's edit menu
// we clear from over the panel. The panel opens about the remembered one and puts it back on the page when it closes.
// A tap on the page that clears the selection is none of those: the person is done with it. Until now it stayed
// remembered all the same, so the next opening took it again and the closing selected it again, each round renewing
// its half a minute.
//
// What tells the two apart is where the pointer went down right before the selection ended: on the page, or on
// something of ours. A selection that ends with no press at all (a script of the page, Safari's toolbar) stays
// remembered, as before.

/** A selection ends this soon after the press that cleared it (a tap clears it when the finger lifts). */
export const CLEAR_AFTER_PRESS_MS = 1500

export interface PointerDown {
  // The event's clock: the same as performance.now().
  at: number
  // On the page, not on anything of ours.
  onPage: boolean
}

/**
 * Whether the selection that just ended (`now`) was cleared by the person's own press on the page. `down`: the latest
 * pointer down; `liveAt`: when the page last had the selection. The press has to come after that: the long press or
 * the drag that made the selection went down before it was there, and says nothing about its end.
 */
export function clearedByHand(down: PointerDown | null, liveAt: number, now: number): boolean {
  if (!down || !down.onPage) return false
  return down.at >= liveAt && now - down.at <= CLEAR_AFTER_PRESS_MS
}
