/**
 * The consent to send questions to the AI, asked before the first answer. Version 2 names
 * Anthropic (Claude) with OpenAI as the backup (2.4); the consent given before (stored as `true`)
 * named OpenAI only, so those people are asked again.
 */
export const CONSENT_VERSION = 2

/** "ok": given for this text; "old": given for an earlier text, ask again; "none": never given. */
export type ConsentStatus = "ok" | "old" | "none"

export function consentStatus(stored: unknown): ConsentStatus {
  if (typeof stored === "number" && stored >= CONSENT_VERSION) return "ok"
  return stored ? "old" : "none"
}
