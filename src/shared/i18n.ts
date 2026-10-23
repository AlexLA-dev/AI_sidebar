import en from "../locales/en.json"

export type MessageKey = keyof typeof en

// Strings come from _locales/<lang>/messages.json via chrome.i18n (the browser
// picks the user's language). English is bundled as a fallback for contexts
// where chrome.i18n is unavailable (tests, preview harness).
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  try {
    const message = chrome.i18n?.getMessage(key, subs.map(String))
    if (message) return message
  } catch {
    // fall through
  }
  return en[key].replace(/\{(\d)\}/g, (_, i: string) => String(subs[Number(i)] ?? ""))
}

export function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage()
  } catch {
    return navigator.language || "en"
  }
}
