export {}

// Background service worker for ContextFlow
// Handles extension lifecycle events and cross-browser compatibility

// Detect browser (Chrome has sidePanel, Safari doesn't)
const isSafari = typeof chrome.sidePanel === "undefined"

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

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "openAuth") {
    // Open auth page in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html")
    })
    sendResponse({ success: true })
  }
  return true
})
