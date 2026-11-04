// The panel's shadow root, for windows drawn outside App (watching's, WatchSheet): closed in what ships, so it can't
// be found from the page; index.tsx hands it over when it makes it.

let root: ShadowRoot | null = null

export function setPanelRoot(r: ShadowRoot): void {
  root = r
}

export function panelRoot(): ShadowRoot | null {
  return root?.host.isConnected ? root : null
}
