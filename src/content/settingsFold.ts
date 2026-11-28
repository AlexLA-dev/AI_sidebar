// Settings in sections that fold (2.7.1, the owner on build 121: «настроек стало очень много, их бы группировать по
// функционалу и сворачивать, как в Tips»). Which sections are open is kept on this device, as Tips keeps its blocks;
// only «Основное» is open at first. A link to one setting (SettingsAt) opens its section.

// 2.7.1 (123, the owner: «Раздел About не нужно сворачивать»): «О приложении» isn't one of them: always open, at the
// bottom, no chevron (Settings.tsx).
export type SettingsSection = "plan" | "general" | "button" | "writing" | "agent" | "cookies" | "chats" | "data"

const ALL: SettingsSection[] = ["plan", "general", "button", "writing", "agent", "cookies", "chats", "data"]

/** The settings a link elsewhere in the panel opens Settings at, and the section each is in. */
export type SettingsAt = "ownKey" | "access"
export const SECTIONS: Record<SettingsAt, SettingsSection> = { ownKey: "plan", access: "agent" }

export const OPEN_FIRST: SettingsSection[] = ["general"]

/** Where which sections are open is kept (chrome.storage.local, Settings.tsx). */
export const OPEN_KEY = "cf:settingsOpen"

/** What's kept, read safely: known sections only, each once; nothing kept (or not a list) is the first state. */
export function keptOpen(raw: unknown): SettingsSection[] {
  if (!Array.isArray(raw)) return [...OPEN_FIRST]
  return ALL.filter((id) => raw.includes(id))
}

/** `open` with `id` flipped, or set to `on`. */
export function toggled(open: SettingsSection[], id: SettingsSection, on?: boolean): SettingsSection[] {
  const has = open.includes(id)
  const want = on ?? !has
  if (want === has) return open
  return want ? ALL.filter((x) => x === id || open.includes(x)) : open.filter((x) => x !== id)
}

/**
 * Which open section's head stays at the top while its settings scroll under it (2.7.1, 123, the owner: «удерживать
 * шапку раздела функционала, когда листаем вниз блок»): the one whose top has gone above the list's top and whose
 * end hasn't yet come up to the head's bottom (the next head pushes it off: CSS sticky within its section). `sections`
 * as on screen (px, the same frame as `listTop`). Null when none is.
 */
export function stuckSection<T extends string>(sections: { id: T; open: boolean; top: number; bottom: number; head: number }[], listTop: number): T | null {
  for (const s of sections) {
    if (s.open && s.top < listTop - 0.5 && s.bottom > listTop + s.head) return s.id
  }
  return null
}

/**
 * Folding a section whose head was stuck at the top: its top was above the list's, so after it folds the list scrolls
 * by this much (negative: up) to show its head at the top, not the middle of whatever came up under it. 0 otherwise.
 */
export function foldScroll(sectionTop: number, listTop: number): number {
  return sectionTop < listTop - 0.5 ? sectionTop - listTop : 0
}
