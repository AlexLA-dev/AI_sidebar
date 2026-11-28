// 2.8's tests (events-2.8.md §1): an install's arm by the parity of one hex digit of its random id, a different digit
// per test, so two tests never overlap. Sent as `client.variant` ("first=guide") with every event and answer.

/** The first-open test (В6.2), on the id's last digit: even, today's guided first request; odd, ready questions with
 *  the consent in the same tap. */
export type FirstArm = "guide" | "ask"

export function firstArm(installId: string): FirstArm | null {
  const digit = /[0-9a-f]$/i.exec(installId.trim())?.[0]
  if (!digit) return null
  return parseInt(digit, 16) % 2 === 0 ? "guide" : "ask"
}

/** `client.variant` for an install: every test it is in (one today). */
export function variantOf(installId: string): string | null {
  const arm = firstArm(installId)
  return arm ? `first=${arm}` : null
}
