export {}

// Background service worker for ContextFlow
// Handles extension lifecycle events and future API proxy

// TODO: Move OpenAI API calls here for better security and persistence in V2
// Benefits:
// - API key stored in service worker context (more secure than sidepanel)
// - Persistent connections survive sidepanel close/reopen
// - Better error handling and retry logic
// - Centralized rate limiting
//
// Trade-off: Requires message passing for streaming, which adds complexity.
// For MVP, we keep API calls in sidepanel for simpler real-time streaming UX.

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ContextFlow] Extension installed")
})

// Handle extension icon click to open side panel
// chrome.sidePanel is Chrome-only; Safari uses popover/action instead.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id })
  }
})
