// Fields inside the sites' open shadow roots (LinkedIn's #interop-outlet, Reddit's components, Salesforce): the
// way up from an element to its document, across the roots. No imports, so the tests can load it as it is.

/** The shadow root `node` is in, or null (in the document itself). */
export function shadowRootOf(node: Node): ShadowRoot | null {
  const root = node.getRootNode?.() as ShadowRoot | Document | undefined
  return root && "host" in root && root.host ? root : null
}

/** The shadow roots from `node` up to its document, innermost first. */
export function shadowRootsOf(node: Node): ShadowRoot[] {
  const roots: ShadowRoot[] = []
  for (let root = shadowRootOf(node); root && roots.length < 32; root = shadowRootOf(root.host)) roots.push(root)
  return roots
}

/** `closest`, going on from a shadow root to its host. */
export function closestComposed(el: Element, selector: string): Element | null {
  for (let cur: Element | null = el, n = 0; cur && n < 32; n++) {
    const hit = cur.closest(selector)
    if (hit) return hit
    cur = shadowRootOf(cur)?.host ?? null
  }
  return null
}
