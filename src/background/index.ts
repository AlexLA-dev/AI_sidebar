export {}

// Background service worker for ContextFlow
// Handles extension lifecycle events and cross-browser compatibility

// Detect browser (Chrome has sidePanel, Safari doesn't)
const isSafari = typeof chrome.sidePanel === "undefined"

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ContextFlow] Extension installed")
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
  } else if (message.action === "storekit") {
    // Relay StoreKit commands from sidebar/popup to native SafariWebExtensionHandler.
    // browser.runtime.sendNativeMessage() is only available in the background script,
    // so extension pages must relay through here.
    const browser = (globalThis as any).browser
    const { action: _, ...nativeMessage } = message

    if (typeof browser?.runtime?.sendNativeMessage === "function") {
      browser.runtime.sendNativeMessage(
        "com.contextflow.app.Extension",
        nativeMessage
      ).then((response: any) => {
        sendResponse(response)
      }).catch((err: any) => {
        sendResponse({ success: false, error: String(err) })
      })
    } else {
      sendResponse({ success: false, error: "Native messaging not available in background" })
    }
  }
  return true
})
