// The panel and the ✦ circle on either side of the screen (2.7, plan section 9, the owner: «чтобы когда перетаскиваешь
// кружок - он тянулся за пальцем, но магнитился к ближайшей стороне. Но и нужно сайдбар тоже перемещать, а не только
// кружок»). The numbers of a drag, kept apart so they can be tested without a page.

export type Side = "left" | "right"

// The circle: its size and its distance from the edge (styles.css .cf-fab).
export const FAB_SIZE = 48
export const FAB_MARGIN = 14
// A press that moves less than this (px, across and down together) is a tap.
export const DRAG_START = 8

/** The side a point is nearer to. */
export const nearestSide = (x: number, width: number): Side => (x < width / 2 ? "left" : "right")

/** The circle's height while dragged and where it stays: a share of the screen, never under the very top or bottom. */
export const heightPercent = (y: number, height: number): number => Math.min(92, Math.max(8, (y / Math.max(1, height)) * 100))

/** The circle's left edge (px) for a point under the finger: centred on it, kept on screen. */
export const fabLeftFor = (x: number, width: number): number => Math.min(width - FAB_SIZE - 4, Math.max(4, x - FAB_SIZE / 2))

/** Where the circle's left edge settles on a side. */
export const fabLeftAt = (side: Side, width: number, inset = 0): number =>
  side === "left" ? Math.max(FAB_MARGIN, inset) : width - Math.max(FAB_MARGIN, inset) - FAB_SIZE

/** The side a dragged panel goes to: the one its middle is nearer to. */
export const panelSideFor = (rect: { left: number; width: number }, width: number): Side => nearestSide(rect.left + rect.width / 2, width)

/** A press moved far enough to be a drag. */
export const isDrag = (dx: number, dy: number): boolean => Math.abs(dx) + Math.abs(dy) >= DRAG_START

/**
 * The side the circle (and on iPad and Mac the panel) is on: the person's choice in any language; until they choose,
 * the interface's direction (left in Arabic, right elsewhere), so a later language switch still follows it. Before 2.7
 * every settings save wrote "right", so a stored "right" without the choice mark isn't a choice; "left" only ever came
 * from a drag.
 */
export function resolveSide(s: { fabSide?: Side; fabSideChosen?: boolean }, direction: "ltr" | "rtl"): Side {
  if (s.fabSideChosen && s.fabSide) return s.fabSide
  if (s.fabSide === "left") return "left"
  return direction === "rtl" ? "left" : "right"
}

/** Taps inside the panel's header that are its controls, not a drag of the panel. */
export const HEADER_CONTROLS = "button,a,input,select,textarea,label,[role=menu],[role=menuitem],[role=button],[contenteditable]"
