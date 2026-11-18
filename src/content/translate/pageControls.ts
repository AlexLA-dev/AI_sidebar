// Whether the translate offer would lie over the page's own controls (2.7, the director's acceptance of 108: on
// hurriyet.com.tr the offer by the circle hid the consent dialog's main button). Plain DOM, so it's tested without a
// browser (tests/accept108.test.mts).

export const PAGE_CONTROL = "a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=checkbox], [role=tab], [onclick]"

/**
 * The page's element a tap at (x, y) would reach under our own (the panel's host is skipped): a control of the page
 * (a button, a link, a field), or null.
 */
export function pageControlAt(doc: Document, x: number, y: number, host: Element | null): Element | null {
  const under = (doc.elementsFromPoint?.(x, y) ?? []).find((el) => el !== host && !(host && host.contains(el)))
  const control = under?.closest(PAGE_CONTROL) ?? null
  // A link in running text doesn't count (an article's lines pass under the pill as the page scrolls); a link drawn
  // as a button (as tall as one) does.
  if (control && /^(A|SPAN)$/.test(control.tagName) && !control.matches?.("[role=button]")) {
    const h = control.getBoundingClientRect?.().height ?? LINK_AS_BUTTON
    if (h < LINK_AS_BUTTON) return null
  }
  return control
}

/** A link this tall or taller looks like a button (a line of text is about 20–24 px). */
export const LINK_AS_BUTTON = 30

/** True when a control of the page lies under any of the rect's sample points (a 4 × 2 grid inside it). */
export function coversPageControl(doc: Document, rect: { left: number; top: number; width: number; height: number }, host: Element | null): boolean {
  if (rect.width < 2 || rect.height < 2) return false
  for (const fy of [0.3, 0.7]) {
    for (const fx of [0.12, 0.38, 0.62, 0.88]) {
      if (pageControlAt(doc, rect.left + rect.width * fx, rect.top + rect.height * fy, host)) return true
    }
  }
  return false
}
