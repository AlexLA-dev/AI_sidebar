/**
 * The one consent to ContextFlow's AI, asked before the first thing any feature sends (src/content/Consent.tsx).
 * Version 2 named Anthropic (Claude) with OpenAI as the backup (2.4), for answers only; the consent given before
 * (stored as `true`) named OpenAI only. Version 3 (2.5 (78), the owner: "let it be given once, saying which
 * features it covers") lists every feature that sends something: answers, AI search and "Ask your chats",
 * templates, page watch and suggestions. Everyone who agreed to an earlier text is asked once more.
 */
export const CONSENT_VERSION = 3

/** "ok": given for this text; "old": given for an earlier text, ask again; "none": never given. */
export type ConsentStatus = "ok" | "old" | "none"

export function consentStatus(stored: unknown): ConsentStatus {
  if (typeof stored === "number" && stored >= CONSENT_VERSION) return "ok"
  return stored ? "old" : "none"
}
