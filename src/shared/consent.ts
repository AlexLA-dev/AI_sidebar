/**
 * The one consent to ContextFlow's AI, asked before the first thing any feature sends (src/content/Consent.tsx).
 * Version 2 named Anthropic (Claude) with OpenAI as the backup (2.4), for answers only; the consent given before
 * (stored as `true`) named OpenAI only. Version 3 (2.5 (78), the owner: "let it be given once, saying which
 * features it covers") lists every feature that sends something: answers, AI search and "Ask your chats",
 * templates, page watch and suggestions. Everyone who agreed to an earlier text is asked once more.
 * 2.6: the visible text names OpenAI (when Claude can't answer, suggestions) and Google Gemini (Google answers) next
 * to Anthropic, and the own-key option; the version stays 3 until the owner decides whether everyone who agreed
 * is asked again (4) or only new people see the new text (3, as now).
 */
export const CONSENT_VERSION = 3

/** "ok": given for this text; "old": given for an earlier text, ask again; "none": never given. */
export type ConsentStatus = "ok" | "old" | "none"

export function consentStatus(stored: unknown): ConsentStatus {
  if (typeof stored === "number" && stored >= CONSENT_VERSION) return "ok"
  return stored ? "old" : "none"
}
