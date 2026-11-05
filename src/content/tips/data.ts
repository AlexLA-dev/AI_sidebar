// The app's Tips, for the panel's Tips sheet (2.5 (78), the owner's note: the same Tips in the extension). The build
// puts them in (scripts/tips-source.mjs): the blocks, cards and Pro badges from the app's ContentView.swift, the
// texts in every language from the app's catalog, as tip_… messages read through chrome.i18n. Nothing to keep in
// step by hand: change a tip in the app and the next extension build has it.

export type TipText = { key: string; en: string }
export type TipEntry = { title: TipText; text: TipText; mac?: { title: TipText; text: TipText }; pro?: true }
export type TipBlock = { id: string; title: TipText; tips: TipEntry[] }
export type TipsData = { heading: TipText; intro: TipText; lead: TipEntry; groups: TipBlock[] }

declare const __TIPS__: TipsData | undefined

/** The Tips, or null in a build without them (tests that bundle the panel on their own). */
export function tipsData(): TipsData | null {
  return typeof __TIPS__ === "undefined" ? null : __TIPS__
}

/** A text in the panel's language (the browser's pick, like every other string), English where there's none. */
export function say(text: TipText): string {
  try {
    return chrome.i18n?.getMessage(text.key) || text.en
  } catch {
    return text.en
  }
}

/** A tip as written for this device: a Mac's own words where they differ (no swipes, a toolbar icon, ⌃⇧V). */
export function forDevice(tip: TipEntry, mac: boolean): { title: TipText; text: TipText } {
  return mac && tip.mac ? tip.mac : tip
}
