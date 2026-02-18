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
    const { action: _, ...nativeMessage } = message

    console.log("[ContextFlow] Native relay:", nativeMessage.command)

    callNative(nativeMessage).then((response: any) => {
      console.log("[ContextFlow] Native response:", JSON.stringify(response))
      sendResponse(response)
    }).catch((err: any) => {
      console.error("[ContextFlow] Native messaging error:", err)
      sendResponse({ success: false, error: String(err) })
    })
  } else if (message.action === "diagnoseBridge") {
    // Diagnostic: test every step of the native bridge and report results.
    const diag: Record<string, any> = {
      isSafari,
      hasBrowserGlobal: !!browserGlobal,
      hasBrowserRuntime: !!browserGlobal?.runtime,
      hasSendNativeMessage: typeof browserGlobal?.runtime?.sendNativeMessage === "function",
      timestamp: new Date().toISOString()
    }

    if (typeof browserGlobal?.runtime?.sendNativeMessage !== "function") {
      diag.error = "sendNativeMessage not available"
      sendResponse({ success: true, data: diag })
    } else {
      // Actually try calling native with a ping command
      callNative({ command: "ping" }).then((response: any) => {
        diag.nativePingResponse = response
        diag.nativePingOK = true
        sendResponse({ success: true, data: diag })
      }).catch((err: any) => {
        diag.nativePingOK = false
        diag.nativePingError = String(err)
        sendResponse({ success: true, data: diag })
      })
    }
  }
  return true
})
