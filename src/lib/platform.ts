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
 * Safari Web Extensions set `browser` global and have webkit message handlers.
 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform

  try {
    // Safari Web Extensions expose the `browser` namespace (WebExtensions API)
    // and webkit message handlers from the native container app
    const isSafari =
      typeof (globalThis as any).browser !== "undefined" &&
      typeof (globalThis as any).browser.runtime !== "undefined" &&
      /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

    if (isSafari) {
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
 * The native container app injects `webkit.messageHandlers.storekit` when built
 * with the StoreKit extension handler.
 */
export function isNativeStoreKitAvailable(): boolean {
  try {
    return (
      isSafari() &&
      typeof (globalThis as any).webkit?.messageHandlers?.storekit !== "undefined"
    )
  } catch {
    return false
  }
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
