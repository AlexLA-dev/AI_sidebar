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
    // Safari: open popup is handled automatically by manifest
    // Or open in new tab as fallback
    chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html")
    })
  } else {
    // Chrome: open side panel
    chrome.sidePanel.open({ tabId: tab.id })
  }
})
