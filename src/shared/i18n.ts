import en from "../locales/en.json"

export type MessageKey = keyof typeof en

// Strings come from _locales/<lang>/messages.json via chrome.i18n (the browser
// picks the user's language). English is bundled as a fallback for contexts
// where chrome.i18n is unavailable (tests, preview harness).
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  let message: string = en[key]
  try {
    message = chrome.i18n?.getMessage(key) || message
  } catch {
    // English
  }
  // {0}, {1}: filled in here, not by the browser (Safari's substitution drops values next to “ ” « »).
  return message.replace(/\{(\d)\}/g, (_, i: string) => String(subs[Number(i)] ?? ""))
}

export function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage()
  } catch {
    return navigator.language || "en"
  }
}

/**
 * The panel strings' language as a BCP 47 tag ("ar", "zh-Hant", "pt-BR"): their own langCode, so it's the language the
 * browser actually loaded. On the panel's root as lang (Traditional Chinese gets PingFang TC's glyphs, 2.6).
 */
export function uiLang(): string {
  return t("langCode") || "en"
}

/**
 * The panel's direction: "rtl" when its strings are in a right-to-left language (Arabic, 2.6), else "ltr". Set on the
 * panel's root: the host's `all: initial` doesn't reset direction, so without it a page's dir would leak in.
 */
export function uiDirection(): "rtl" | "ltr" {
  return /^(ar|he|fa|ur)\b/i.test(uiLang()) ? "rtl" : "ltr"
}
