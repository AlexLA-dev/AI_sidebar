import { t, type MessageKey } from "../shared/i18n"

document.documentElement.lang = chrome.i18n?.getUILanguage?.() ?? "en"
document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
  el.textContent = t(el.dataset.i18n as MessageKey)
})
if (new URLSearchParams(location.search).has("restricted")) {
  document.getElementById("restricted")?.removeAttribute("hidden")
}
