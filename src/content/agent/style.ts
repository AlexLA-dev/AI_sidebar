// Computed styles read once per element while one map is built (2.8, round 140): the map's checks walk the same
// ancestors for every control (whether it's hidden, whether it's in a fixed layer), and each walk read every ancestor's
// style again — 22 000 to 29 000 reads on a long results list. Within one build the page doesn't change, so one read an
// element is the same answer.

let cache: Map<Element, CSSStyleDeclaration> | null = null
let reads = 0

/** Starts a build's cache; returns a function that ends it (and says how many styles were read). */
export function beginStyles(): () => number {
  cache = new Map()
  reads = 0
  return () => {
    cache = null
    return reads
  }
}

/** The element's computed style (once per build while a build runs). */
export function styleOf(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView
  if (!view?.getComputedStyle) return null
  const hit = cache?.get(el)
  if (hit) return hit
  const s = view.getComputedStyle(el)
  reads++
  cache?.set(el, s)
  return s
}

/** Whether the browser itself says the element doesn't show (round 141, the director's item 6): display none, hidden or
 *  skipped content, visibility hidden, opacity 0 on it or an ancestor — one native call, no style object. null where the
 *  browser hasn't the call (Safari before 17.4): the caller then reads styles, cached per build. A checkbox or a radio
 *  a site draws over with its label is often opacity 0: those are asked without the opacity check. */
export function hiddenNatively(el: Element, opacity = true): boolean | null {
  const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility
  if (typeof check !== "function") return null
  return !check.call(el, { checkOpacity: opacity, opacityProperty: opacity, checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true })
}
