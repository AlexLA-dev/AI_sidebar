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
 * Safari detection: check for `browser.runtime.sendNativeMessage` — this API
 * exists ONLY in Safari Web Extensions with a native app container.
 * We avoid user-agent sniffing because WKWebView extension pages often omit
 * the "Safari" token from `navigator.userAgent`.
 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform

  try {
    const browser = (globalThis as any).browser

    // Safari Web Extensions expose `browser.runtime.sendNativeMessage`
    // for communicating with the native SafariWebExtensionHandler.
    // Chrome does NOT have this on the `browser` namespace.
    if (
      typeof browser !== "undefined" &&
      typeof browser.runtime !== "undefined" &&
      typeof browser.runtime.sendNativeMessage === "function"
    ) {
      cachedPlatform = "safari"
      return "safari"
    }

    // Chrome / Chromium-based browsers
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      cachedPlatform = "chrome"
      return "chrome"
    }

    cachedPlatform = "unknown"
    return "unknown"
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
