// Settings in sections that fold (2.7.1, the owner on build 121: «настроек стало очень много, их бы группировать по
// функционалу и сворачивать, как в Tips»). Which sections are open is kept on this device, as Tips keeps its blocks;
// only «Основное» is open at first. A link to one setting (SettingsAt) opens its section.

export type SettingsSection = "plan" | "general" | "button" | "writing" | "agent" | "cookies" | "chats" | "data" | "about"

const ALL: SettingsSection[] = ["plan", "general", "button", "writing", "agent", "cookies", "chats", "data", "about"]

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
