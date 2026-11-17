// Compact or roomy (2.7 after build 107, the owner's decision 1 on the «Тихая панель» mockup): phones and an iPad mini
// held in the hands get the compact chat (one row of buttons under a message, the footer line folded into «+»); an
// iPad with a keyboard and the Mac keep what they showed, «большое выпадающее меню только переносит перегруз».
//
// The rule, by what the panel has, never by the device's name:
// - a mouse or a trackpad is there (any-pointer: fine, or any-hover: hover) → roomy;
// - a hardware keyboard was seen on a wide screen (below) → roomy;
// - the panel itself is wide and tall (ROOMY_WIDTH × ROOMY_HEIGHT) → roomy;
// - else compact.
// It's read as the panel opens and kept until it opens again: nothing re-flows under a finger.
//
// A hardware keyboard with no trackpad tells a page nothing about itself. What can be seen: the panel's own field
// takes the focus and the screen's visible part doesn't shrink, as it does for the on-screen keyboard. That is noted
// (on screens at least WIDE_SCREEN wide: a phone stays compact with any keyboard) and used from the next opening.
// The visible part is compared with the tallest the window has been at this width, not with the window now: Safari on
// an iPad shrinks the window itself under the on-screen keyboard (1001 → 661 pt on an iPad mini), so the two agree.

export type Density = "compact" | "roomy"

export const ROOMY_WIDTH = 560
export const ROOMY_HEIGHT = 480
export const WIDE_SCREEN = 700
// The on-screen keyboard takes far more than this off the visible part; a hardware keyboard's bar of shortcuts, less.
export const KEYBOARD_MIN = 120

export interface DensityInput {
  // The panel's own size on screen.
  width: number
  height: number
  // A mouse or a trackpad among the pointers; something that can hover.
  finePointer: boolean
  hover: boolean
  // A hardware keyboard was seen (keyboardSeen).
  keyboard: boolean
}

export function panelDensity({ width, height, finePointer, hover, keyboard }: DensityInput): Density {
  if (finePointer || hover || keyboard) return "roomy"
  return width >= ROOMY_WIDTH && height >= ROOMY_HEIGHT ? "roomy" : "compact"
}

/** The panel's size before it's drawn, from its layout (styles.css: the side panel, the sheet, the popup). */
export function panelSize(layout: "side" | "sheet" | "popup", screen: { width: number; height: number }): { width: number; height: number } {
  if (layout === "side") return { width: Math.min(420, screen.width - 20), height: screen.height - 20 }
  if (layout === "sheet") return { width: screen.width, height: Math.min(screen.height * 0.78, 640, screen.height - 40) }
  return screen
}

/**
 * What a focus in the panel's field says about the keyboard: true (a hardware one: the visible part kept its height),
 * false (the on-screen one came up), or null when it says nothing (a narrow screen, where it changes nothing).
 */
export function keyboardSeen(screen: { width: number; height: number }, visibleHeight: number): boolean | null {
  if (screen.width < WIDE_SCREEN) return null
  return screen.height - visibleHeight < KEYBOARD_MIN
}

const KEY = "cf:hwKeyboard"
let keyboard = false

// The window's tallest height seen at its present width (a turn of the screen starts again).
let tallest = { width: 0, height: 0 }

/** The window's height now, kept if it's the tallest at this width; the tallest is returned. */
export function tallestHeight(now: { width: number; height: number }, seen = tallest): { width: number; height: number } {
  if (now.width !== seen.width || now.height > seen.height) return { width: now.width, height: now.height }
  return seen
}

function seeWindow(): void {
  tallest = tallestHeight({ width: window.innerWidth, height: window.innerHeight })
}

/** Read once as the page's script starts, long before the panel can open. */
export function loadKeyboard(): void {
  seeWindow()
  try {
    window.addEventListener("resize", seeWindow, { passive: true })
  } catch {
    // no events: the height at the start is the one
  }
  try {
    chrome.storage.local.get(KEY, (r) => {
      void chrome.runtime.lastError
      keyboard = r?.[KEY] === true
    })
  } catch {
    // no storage: no keyboard seen
  }
}

/** The panel's field has had the focus for a moment: what the screen says about the keyboard is kept. */
export function noteKeyboard(): void {
  const vv = window.visualViewport
  if (!vv) return
  seeWindow()
  const seen = keyboardSeen(tallest, vv.height * vv.scale)
  if (seen === null || seen === keyboard) return
  keyboard = seen
  try {
    void chrome.storage.local.set({ [KEY]: seen })
  } catch {
    // kept for this page only
  }
}

const media = (query: string): boolean => {
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

/** The panel's density for this opening. */
export function densityNow(layout: "side" | "sheet" | "popup"): Density {
  const size = panelSize(layout, { width: window.innerWidth, height: window.innerHeight })
  return panelDensity({ ...size, finePointer: media("(any-pointer: fine)"), hover: media("(any-hover: hover)"), keyboard })
}
