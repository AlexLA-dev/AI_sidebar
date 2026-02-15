export {}

// Background service worker for ContextFlow
// Handles extension lifecycle events and cross-browser compatibility

// Detect browser: Safari exposes the native `browser` global; Chrome does not.
// Fallback: Chrome has chrome.sidePanel when the permission is declared.
const browserGlobal = (globalThis as any).browser
const isSafari =
  (browserGlobal && typeof browserGlobal.runtime !== "undefined") ||
  typeof chrome.sidePanel === "undefined"

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ContextFlow] Extension installed, platform:", isSafari ? "safari" : "chrome")
  if (isSafari) {
    const hasNativeMessaging = typeof browserGlobal?.runtime?.sendNativeMessage === "function"
    console.log("[ContextFlow] Native messaging available:", hasNativeMessaging)
  }
})

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return

  if (isSafari) {
    // Safari: toggle floating panel on current page
    chrome.tabs.sendMessage(tab.id, { action: "toggleFloatingPanel" })
  } else {
    // Chrome: open side panel
    chrome.sidePanel.open({ tabId: tab.id })
  }
})

// Handle messages from content scripts and extension pages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "openAuth") {
    // Open auth page in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html")
    })
    sendResponse({ success: true })
  } else if (message.action === "openPaywall") {
    // Open sidepanel with paywall flag — StoreKit requires native WKWebView context
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html?showPaywall=1")
    })
    sendResponse({ success: true })
  } else if (message.action === "native") {
    // Relay native commands from sidebar/popup to SafariWebExtensionHandler.
    // browser.runtime.sendNativeMessage() is only available in the background script.
    // Used for: getSubscriptionStatus, getSettings (no StoreKit purchases here).
    const { action: _, ...nativeMessage } = message

    console.log("[ContextFlow] Native relay:", nativeMessage.command)

    if (typeof browserGlobal?.runtime?.sendNativeMessage === "function") {
      // Try both calling conventions: Safari may use 1-arg or 2-arg form
      // depending on the version. We try 2-arg first (per Apple's docs),
      // then fall back to 1-arg if it fails.
      const tryNativeMessage = (msg: any): Promise<any> => {
        return browserGlobal.runtime.sendNativeMessage(
          "com.contextflow.app.Extension", msg
        ).catch(() => {
          // Fallback: 1-arg form (some Safari versions)
          return browserGlobal.runtime.sendNativeMessage(msg)
        })
      }

      tryNativeMessage(nativeMessage).then((response: any) => {
        console.log("[ContextFlow] Native response:", JSON.stringify(response))
        sendResponse(response)
      }).catch((err: any) => {
        console.error("[ContextFlow] Native messaging error:", err)
        sendResponse({ success: false, error: String(err) })
      })
    } else {
      console.error("[ContextFlow] Native messaging not available.")
      sendResponse({
        success: false,
        error: "Native messaging not available. Ensure ContextFlow is installed from the App Store."
      })
    }
  }
  return true
})
