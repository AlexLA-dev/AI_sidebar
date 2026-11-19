// The «ContextFlow is ready» tab of a new install (welcome.html), build 110.
//
// It used to open in front the moment the background first ran after the install. On an iPhone that moment can be
// the person's first tap on ✦: the app's «Open Safari» had opened our site, ✦ was there, the tap woke the background,
// and the tab that says "open any website and tap ✦" came up over the page where they had just done so.
//
// Now the tab is only for a person who has no panel in front of them: the background asks the front tab whether its
// panel is there, gives a page that is still coming the time to load, and opens the tab only when nobody answers.

/** What the background sees of the tab in front. In Safari `url` is empty for a site ContextFlow isn't allowed on. */
export interface FrontTab {
  id?: number
  url?: string
  status?: string
}

export interface WelcomeDeps {
  /** The tab in front now (asked again at every look: the app's page may open a moment after Safari starts). */
  front(): Promise<FrontTab | null>
  /** Does the panel's script answer in this tab? Never throws. */
  panelIn(tabId: number): Promise<boolean>
  open(): Promise<void>
  wait(ms: number): Promise<void>
}

/** Looks at 0, 0.6, 1.5 and 3 s: Safari starting from the app shows its old tab first, our page a moment later. */
export const WELCOME_LOOKS = [600, 900, 1500] as const
/** A page still loading in front gets this much longer, a look each second (the first load on a slow network). */
export const WELCOME_LOADING_MS = 12_000

const isLoading = (tab: FrontTab | null): boolean => tab?.status === "loading"

/** Opens the welcome tab unless the person already has the panel in front. Says which, for the tests. */
export async function welcomeOnInstall(deps: WelcomeDeps): Promise<"panel" | "opened"> {
  let waited = 0
  for (let look = 0; ; look++) {
    const tab = await deps.front().catch(() => null)
    if (tab?.id !== undefined && (await deps.panelIn(tab.id).catch(() => false))) return "panel"
    const next = look < WELCOME_LOOKS.length ? WELCOME_LOOKS[look] : isLoading(tab) && waited < WELCOME_LOADING_MS ? 1000 : null
    if (next === null) break
    await deps.wait(next)
    waited += next
  }
  await deps.open()
  return "opened"
}
