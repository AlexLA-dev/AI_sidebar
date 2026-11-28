// 2.7.1 (the Apple Ads report, point 4): one install, one person in the counts. The app makes a random id on its first
// launch (sent with "app opened" and the Apple Ads answer); the extension makes its own random install id (sent with
// everything Safari's side counts, and given to the app for purchases). This step sends the two together, from the
// extension's side, so the server can tell for every download where it came from, whether ContextFlow was switched on
// in Safari, and whether it was paid for.
//
// 2.7 sent it once, from the native handler, only when the panel first asked for the subscription, without waiting
// for an answer: someone who switched it on and never opened the panel, a request lost when Safari suspended the
// handler, or an app reinstalled under an extension that kept its storage stayed two people. Here the background
// sends it whenever the app's id it hears from the app isn't the one the server last confirmed, until it does.
// Both ids are random; nothing else goes (no new kind of data: the same "use" step 2.7 already sends).

export interface LinkDeps {
  /** The app's random id from the native side (`ping`), or null when the app hasn't been opened yet or can't say. */
  appId: () => Promise<string | null>
  installId: () => Promise<string>
  client: () => Promise<Record<string, unknown>>
  /** The app id the server last confirmed for this install. */
  linked: () => Promise<string | null>
  markLinked: (appId: string) => Promise<void>
  post: (body: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Sends the link when it's new or the app's id changed; true when the server has it now (or had it already). */
export async function linkApp(deps: LinkDeps): Promise<boolean> {
  const app = (await deps.appId())?.toLowerCase() ?? null
  if (!app || !UUID.test(app)) return false
  if ((await deps.linked()) === app) return true
  const [installId, client] = await Promise.all([deps.installId(), deps.client()])
  const res = await deps.post({ kind: "use", f: "activation", a: "linked", s: "app", appId: app, installId, client }).catch(() => null)
  if (!res) return false
  // 400: the server will never take it (an id it doesn't accept); not asked again for this app id.
  if (res.ok || res.status === 400) {
    await deps.markLinked(app)
    return res.ok
  }
  return false
}
