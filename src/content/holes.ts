// A lit-up part's place in the panel (the tour's and the guide's frames, Tour.tsx), and whether two readings of it
// are the same place. On their own, so the tests can load them without the panel.

export interface Hole {
  top: number
  left: number
  width: number
  height: number
}

/** The same places, to half a point (a rectangle read twice can differ in its last digits). */
export function sameHoles(a: Hole[], b: Hole[]): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5
  return a.length === b.length && a.every((h, i) => near(h.top, b[i].top) && near(h.left, b[i].left) && near(h.width, b[i].width) && near(h.height, b[i].height))
}
