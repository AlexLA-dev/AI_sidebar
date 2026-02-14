/**
 * Platform detection for ContextFlow.
 *
 * Determines whether the extension is running in Safari (App Store distribution,
 * must use StoreKit for purchases) or Chrome (uses Stripe Payment Links).
 */

export type Platform = "safari" | "chrome" | "unknown"

let cachedPlatform: Platform | null = null

/**
 * Detect the current browser platform.
 *
 * Uses multiple signals because the `chrome.sidePanel` check alone can be
 * unreliable — Safari may expose a stub when the permission is declared in
 * the manifest, and Plasmo may polyfill it in built output.
 *
 * Detection order:
 * 1. Safari (and Firefox) expose a native `browser` global with `browser.runtime`.
 *    Chrome does NOT have this unless a polyfill is loaded (Plasmo does not add one).
 * 2. Fallback: Chrome has `chrome.sidePanel` when the permission is declared;
 *    Safari does not implement it.
 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform

  try {
    // Both Chrome and Safari expose `chrome.runtime` in extension contexts
    if (typeof chrome === "undefined" || typeof chrome.runtime === "undefined") {
      cachedPlatform = "unknown"
      return "unknown"
    }

    // Primary signal: Safari exposes the native `browser` global with runtime API.
    // Chrome does not have `browser.runtime` unless a polyfill adds it.
    const browserGlobal = (globalThis as any).browser
    if (browserGlobal && typeof browserGlobal.runtime !== "undefined") {
      cachedPlatform = "safari"
      return "safari"
    }

    // Secondary signal: Chrome has chrome.sidePanel; Safari does not.
    if (typeof (chrome as any).sidePanel === "undefined") {
      cachedPlatform = "safari"
      return "safari"
    }

    cachedPlatform = "chrome"
    return "chrome"
  } catch {
    cachedPlatform = "unknown"
    return "unknown"
  }
}

/** True when running inside Safari (App Store build). */
export function isSafari(): boolean {
  return getPlatform() === "safari"
}

/** True when running inside Chrome or a Chromium-based browser. */
export function isChrome(): boolean {
  return getPlatform() === "chrome"
}

/**
 * Check if the native StoreKit bridge is available.
 *
 * Requires both:
 * 1. Running in Safari (detected by platform check)
 * 2. The `browser.runtime.sendNativeMessage` function exists in the background
 *    (we can only check the `browser` global here — the sidebar relays via
 *    chrome.runtime.sendMessage to the background which calls sendNativeMessage)
 */
export function isNativeStoreKitAvailable(): boolean {
  if (!isSafari()) return false

  // Extra safety: verify chrome.runtime.sendMessage is available
  // (the sidebar uses this to relay StoreKit commands to the background script)
  return typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function"
}

/**
 * Determine which payment provider to use.
 * Safari App Store builds MUST use StoreKit (App Store Review Guideline 3.1.1).
 * Chrome uses Stripe.
 */
export type PaymentProvider = "appstore" | "stripe"

export function getPaymentProvider(): PaymentProvider {
  return isSafari() ? "appstore" : "stripe"
}
