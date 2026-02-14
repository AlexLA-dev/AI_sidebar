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
 * Safari detection: Chrome has `chrome.sidePanel` API (when the permission
 * is declared), Safari does not. This is the same approach used in
 * background/index.ts and works reliably in all extension contexts
 * (background, sidebar, popup, content scripts).
 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform

  try {
    // Both Chrome and Safari expose `chrome.runtime` in extension contexts
    if (typeof chrome === "undefined" || typeof chrome.runtime === "undefined") {
      cachedPlatform = "unknown"
      return "unknown"
    }

    // Safari doesn't support the sidePanel API.
    // Chrome exposes chrome.sidePanel when the "sidePanel" permission is declared.
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
 * `isSafari()` already verifies that `browser.runtime.sendNativeMessage` exists,
 * so this is equivalent to the Safari check.
 */
export function isNativeStoreKitAvailable(): boolean {
  return isSafari()
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
