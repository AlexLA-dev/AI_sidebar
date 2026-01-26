export {}

// Background service worker for ContextFlow
// Handles API calls to avoid CORS issues and manages context state

chrome.runtime.onInstalled.addListener(() => {
  console.log("ContextFlow extension installed")
})
