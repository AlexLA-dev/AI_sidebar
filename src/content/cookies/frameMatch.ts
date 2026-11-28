// Consent platforms whose window is a frame of their own, told by the frame's address (2.7.1). Tiny on purpose:
// frame.js runs in every frame and only asks for the closer (dist/cookieframe.js) in one of these.

export const CONSENT_FRAMES: ReadonlyArray<readonly [id: string, url: RegExp]> = [
  // Sourcepoint's privacy manager (its settings), then its message (cdn.privacy-mgmt.com or the site's subdomain).
  ["sourcepoint_pm", /\/privacy-manager\//i],
  ["sourcepoint", /[?&]message_id=\d/i],
  ["sourcepoint", /^https:\/\/[^/]*privacy-mgmt\.com\//i],
  ["trustarc", /^https:\/\/consent-pref\.trustarc\.com\//i],
  ["consentmanager", /^https:\/\/[^/]*consentmanager\.net\//i]
]

/** The consent platform whose frame this address is, or null. */
export function consentFrame(href: string): string | null {
  for (const [id, url] of CONSENT_FRAMES) if (url.test(href)) return id
  return null
}
