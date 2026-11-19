// Apple DeviceCheck (2.7, invite a friend): two bits Apple keeps per device for us, which survive reinstalls. bit0 says
// the device has had a friend's bonus, so a reinstall can't take it again. The app (and, where Safari lets it, the
// extension) makes a token with DCDevice; the server asks Apple about it with a DeviceCheck key
// (developer.apple.com → Keys, "DeviceCheck"). Nothing about the device is kept on our side.
// https://developer.apple.com/documentation/devicecheck/accessing-and-modifying-per-device-data

import { createPrivateKey, randomUUID, sign } from "node:crypto"

import { config } from "./config.mts"

const HOSTS = { production: "https://api.devicecheck.apple.com", development: "https://api.development.devicecheck.apple.com" } as const
type Host = keyof typeof HOSTS

/** The key's id, the team and the key itself are set in Netlify. */
export function deviceCheckConfigured(): boolean {
  return Boolean(config.deviceCheck.keyId && config.deviceCheck.teamId && config.deviceCheck.privateKey)
}

let kept: { token: string; at: number } | null = null

/** The ES256 JWT Apple wants (kid: the key, iss: the team), reused for 20 minutes (Apple takes up to an hour). */
export function deviceCheckJwt(now = Date.now()): string {
  if (kept && now - kept.at < 20 * 60_000) return kept.token
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const head = `${part({ alg: "ES256", kid: config.deviceCheck.keyId })}.${part({ iss: config.deviceCheck.teamId, iat: Math.floor(now / 1000) })}`
  const signature = sign("sha256", Buffer.from(head), { key: createPrivateKey(config.deviceCheck.privateKey), dsaEncoding: "ieee-p1363" })
  kept = { token: `${head}.${signature.toString("base64url")}`, at: now }
  return kept.token
}

export type DeviceAnswer = "new" | "used" | "bad" | "error"

async function call(host: Host, path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${HOSTS[host]}/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceCheckJwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ device_token: body.device_token, transaction_id: randomUUID(), timestamp: Date.now(), ...body }),
    signal: AbortSignal.timeout(8_000)
  })
  return { status: res.status, text: await res.text().catch(() => "") }
}

/** What Apple's answer to query_two_bits says: 200 with the bits, 200 "Failed to find bit state" (never set). */
export function readBits(status: number, text: string): DeviceAnswer {
  if (status === 400) return "bad"
  if (status !== 200) return "error"
  if (/failed to find bit state/i.test(text)) return "new"
  try {
    const bits = JSON.parse(text) as { bit0?: boolean }
    return bits.bit0 === true ? "used" : "new"
  } catch {
    return "error"
  }
}

/**
 * Whether this device has had a friend's bonus. A token from a development build (Xcode) is only known to Apple's
 * development server: a production "bad token" is asked there too. Returns where the device was found, for the update.
 */
export async function deviceStatus(token: string): Promise<{ answer: DeviceAnswer; host?: Host }> {
  try {
    for (const host of ["production", "development"] as const) {
      const { status, text } = await call(host, "query_two_bits", { device_token: token })
      const answer = readBits(status, text)
      if (answer !== "bad") return { answer, host }
    }
    return { answer: "bad" }
  } catch {
    return { answer: "error" }
  }
}

/** Marks the device as having had a friend's bonus (bit0). A failure is only logged: the database row stands. */
export async function markDevice(token: string, host: Host): Promise<boolean> {
  try {
    const { status } = await call(host, "update_two_bits", { device_token: token, bit0: true })
    return status === 200
  } catch {
    return false
  }
}
