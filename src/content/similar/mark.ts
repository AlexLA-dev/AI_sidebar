// Build 95: the chat a Find similar notification's tap asked to open, named in the page's address (SimilarAway.swift).
/**
 * The chat a "Find similar is done" notification asked to open (build 95): `#cf-similar=<chat>` in the address the app
 * opened, taken out of the address at once (the page's own fragment, if any, stays); null when there is none.
 */
export function takeSimilarMark(): string | null {
  const m = /(^#|&)cf-similar=([A-Za-z0-9_-]{1,80})(?=&|$)/.exec(location.hash)
  if (!m) return null
  const rest = location.hash.slice(0, m.index) + location.hash.slice(m.index + m[0].length).replace(/^&/, m[1] === "#" ? "#" : "&")
  const hash = rest === "#" || rest === "" ? "" : rest.startsWith("#") ? rest : `#${rest}`
  const clean = `${location.pathname}${location.search}${hash}`
  try {
    history.replaceState(history.state, "", clean)
  } catch {
    // The page's own state can't come across (an extension's script runs apart from the page): the address alone.
    try { history.replaceState(null, "", clean) } catch { /* a page that won't let its address change: harmless */ }
  }
  return m[2]
}
