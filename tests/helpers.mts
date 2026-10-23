import { readFileSync } from "node:fs"
import { sign, X509Certificate } from "node:crypto"

const dir = new URL("./fixtures/", import.meta.url)
const pem = (name: string) => readFileSync(new URL(name, dir), "utf8")
const der = (name: string) => new X509Certificate(pem(name)).raw.toString("base64")

export const TEST_ROOT_FINGERPRINT = new X509Certificate(pem("root.pem")).fingerprint256

export function signJws(payload: Record<string, unknown>, opts: { leaf?: "leaf" | "rogue"; tamper?: boolean } = {}): string {
  const leaf = opts.leaf ?? "leaf"
  const header = { alg: "ES256", x5c: [der(`${leaf}.pem`), der("intermediate.pem"), der("root.pem")] }
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const signingInput = `${enc(header)}.${enc(payload)}`
  const signature = sign("sha256", Buffer.from(signingInput), { key: pem(`${leaf}.key`), dsaEncoding: "ieee-p1363" })
  const body = opts.tamper ? enc({ ...payload, productId: "com.contextflow.pro.monthly", expiresDate: 4102444800000 }) : enc(payload)
  return `${enc(header)}.${body}.${signature.toString("base64url")}`
}

export function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return {
    bundleId: "com.contextflow.app",
    productId: "com.contextflow.pro.monthly",
    originalTransactionId: "2000000123",
    transactionId: "2000000456",
    environment: "Sandbox",
    type: "Auto-Renewable Subscription",
    purchaseDate: now - 86_400_000,
    expiresDate: now + 30 * 86_400_000,
    signedDate: now,
    ...overrides
  }
}
