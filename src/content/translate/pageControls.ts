// Whether the translate offer would lie over the page's own controls (2.7, the director's acceptance of 108: on
// hurriyet.com.tr the offer by the circle hid the consent dialog's main button). Plain DOM, so it's tested without a
// browser (tests/accept108.test.mts).

export const PAGE_CONTROL = "a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=checkbox], [role=tab], [onclick]"

/** What a page draws over itself: its dialogs (a site's consent, a sign-in, an alert). */
export const OVERLAY = "dialog, [role=dialog], [role=alertdialog], [aria-modal=true]"

/**
 * The control sits in an overlay of the page: in a dialog, or it or one of its ancestors is fixed or sticky (a consent
 * bar, a sticky header). Only those count (2.7, 108, the director's real-page pass: on es.wikipedia.org the row of
 * icons and the links of the text under the circle kept the offer from ever coming by itself). Controls in the page's
 * own flow scroll away; a pill over them for a moment is what every floating button does.
 */
export function inOverlay(el: Element): boolean {
  if (el.closest?.(OVERLAY)) return true
  const doc = el.ownerDocument
  const view = doc?.defaultView
  for (let e: Element | null = el; e && e !== doc?.body && e !== doc?.documentElement; e = e.parentElement) {
    const position = view?.getComputedStyle?.(e).position
    if (position === "fixed" || position === "sticky") return true
  }
  return false
}

/**
 * The page's control a tap at (x, y) would reach under our own (the panel's host is skipped), when it sits in an
 * overlay of the page (inOverlay); else null.
 */
export function pageControlAt(doc: Document, x: number, y: number, host: Element | null): Element | null {
  const under = (doc.elementsFromPoint?.(x, y) ?? []).find((el) => el !== host && !(host && host.contains(el)))
  const control = under?.closest(PAGE_CONTROL) ?? null
  return control && inOverlay(control) ? control : null
}

/**
 * True when a control in an overlay of the page lies under any of the rect's sample points (a 4 × 2 grid inside it):
 * a sticky header's controls count only where the pill really lies on them.
 */
export function coversPageControl(doc: Document, rect: { left: number; top: number; width: number; height: number }, host: Element | null): boolean {
  if (rect.width < 2 || rect.height < 2) return false
  for (const fy of [0.3, 0.7]) {
    for (const fx of [0.12, 0.38, 0.62, 0.88]) {
      if (pageControlAt(doc, rect.left + rect.width * fx, rect.top + rect.height * fy, host)) return true
    }
  }
  return false
}
