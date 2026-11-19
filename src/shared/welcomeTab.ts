// The «ContextFlow is ready» tab of a new install (welcome.html), build 110.
//
// It used to open in front the moment Safari sent the install event, and Safari sends it when it chooses: as a page
// loads, or seconds after the background's first start. On an iPhone that start can be the person's first tap on ✦:
// the app's «Open Safari» had opened our site, ✦ was there, the tap woke the background, and the tab that says "open
// any website and tap ✦" came up over the page where they had just done so.
//
// Now the tab is only for a person who isn't on a website ContextFlow works on: the background asks the tab in front
// whether its panel is there, and looks at whether it is a site it's allowed on (Safari shows a tab's address only
// then), where the panel is or is about to be. Neither: the tab opens, as before.
//
// Nothing here waits for long. Safari on an iPhone puts the background to sleep within seconds and wakes it at the
// person's next action; a first version that kept looking for 3 s opened the tab 42 s later, over Safari's own
// permission sheet (the simulator, 2026-11-19). So: one more look after a moment, and if that moment turned out to be
// long, the tab's time has passed and it doesn't open at all.

/** What the background sees of the tab in front. In Safari `url` is empty for a site ContextFlow isn't allowed on. */
export interface FrontTab {
  id?: number
  url?: string
  status?: string
}

export interface WelcomeDeps {
  /** The tab in front now (asked again at the second look: the app's page may open a moment after Safari starts). */
  front(): Promise<FrontTab | null>
  /** Does the panel's script answer in this tab? Never throws. */
  panelIn(tabId: number): Promise<boolean>
  open(): Promise<void>
  wait(ms: number): Promise<void>
  now(): number
}

/** The one pause between the two looks: Safari starting from the app shows its old tab first, our page a moment later. */
export const WELCOME_PAUSE_MS = 600
/** Both looks and the pause take under 3 s awake. Longer than this, and the background was asleep in between:
 *  whatever is in front now, it isn't that moment. */
export const WELCOME_LATE_MS = 5000

/** Why no tab: the panel answered, the front tab is a site ContextFlow works on, or the moment has passed. */
export type WelcomeOutcome = "panel" | "site" | "late" | "opened"

async function look(deps: WelcomeDeps): Promise<"panel" | "site" | null> {
  const tab = await deps.front().catch(() => null)
  if (tab?.id !== undefined && (await deps.panelIn(tab.id).catch(() => false))) return "panel"
  return /^https?:\/\//i.test(tab?.url ?? "") ? "site" : null
}

/** Opens the welcome tab unless the person is already on a website ContextFlow works on. Says which, for the tests. */
export async function welcomeOnInstall(deps: WelcomeDeps): Promise<WelcomeOutcome> {
  const start = deps.now()
  const first = await look(deps)
  if (first) return first
  await deps.wait(WELCOME_PAUSE_MS)
  const second = await look(deps)
  if (second) return second
  if (deps.now() - start > WELCOME_LATE_MS) return "late"
  await deps.open()
  return "opened"
}
