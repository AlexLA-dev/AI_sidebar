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
  // Extension installed
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

// ── Native messaging helper ──────────────────────────────────────────────

/**
 * Send a message to the native SafariWebExtensionHandler.
 * Tries both 2-arg and 1-arg calling conventions.
 */
function callNative(msg: any): Promise<any> {
  if (typeof browserGlobal?.runtime?.sendNativeMessage !== "function") {
    return Promise.reject(new Error("sendNativeMessage is not a function"))
  }

  // Try 2-arg first (Apple docs example), then 1-arg fallback
  return browserGlobal.runtime.sendNativeMessage(
    "com.contextflow.app.Extension", msg
  ).catch(() => {
    return browserGlobal.runtime.sendNativeMessage(msg)
  })
}

// Handle messages from content scripts and extension pages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "openAuth") {
    // Remember the current tab so we can switch back after auth
    const senderTabId = _sender.tab?.id
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html")
    }, (newTab) => {
      // Store the originating tab ID so the auth page can switch back
      if (senderTabId && newTab?.id) {
        chrome.storage.local.set({ _authOriginTabId: senderTabId })
      }
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
    const { action: _, ...nativeMessage } = message

    callNative(nativeMessage).then((response: any) => {
      sendResponse(response)
    }).catch((err: any) => {
      sendResponse({ success: false, error: String(err) })
    })
  }
  return true
})
