import { createHash, verify as verifySignature, X509Certificate } from "node:crypto"

import { config, PRODUCTS, type PaidPlan } from "./config.mts"

// SHA-256 fingerprint of "Apple Root CA - G3" (https://www.apple.com/certificateauthority/).
// Every StoreKit 2 / App Store Server Notification JWS chains up to it.
export const APPLE_ROOT_CA_G3_FINGERPRINT =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79"

// Marker extensions Apple's own SignedDataVerifier requires. Without them any
// certificate issued under the same root (e.g. a developer's signing
// certificate) could be used to forge a "purchase".
const LEAF_OID = derOid("1.2.840.113635.100.6.11.1")
const INTERMEDIATE_OID = derOid("1.2.840.113635.100.6.2.1")
const MAX_CLOCK_SKEW_MS = 60_000

export class JwsError extends Error {}

let trustedRoot = APPLE_ROOT_CA_G3_FINGERPRINT

/** Unit tests sign with a throwaway chain; production never calls this. */
export function setTrustedRootFingerprintForTests(fingerprint: string): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only")
  trustedRoot = fingerprint
}

export interface VerifyOptions {
  rootFingerprint?: string
  now?: Date
}

/** Verifies an Apple-signed JWS (x5c chain + ES256 signature) and returns its payload. */
export function verifyAppleJws<T = Record<string, unknown>>(jws: string, options: VerifyOptions = {}): T {
  const parts = typeof jws === "string" ? jws.split(".") : []
  if (parts.length !== 3) throw new JwsError("malformed")

  const header = decodeSegment<{ alg?: string; x5c?: string[] }>(parts[0])
  const payload = decodeSegment<T & { signedDate?: number }>(parts[1])
  if (header.alg !== "ES256") throw new JwsError("unsupported alg")
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) throw new JwsError("missing x5c chain")

  let leaf: X509Certificate, intermediate: X509Certificate, root: X509Certificate
  try {
    ;[leaf, intermediate, root] = header.x5c.map(
      (der) => new X509Certificate(`-----BEGIN CERTIFICATE-----\n${der}\n-----END CERTIFICATE-----`)
    ) as [X509Certificate, X509Certificate, X509Certificate]
  } catch {
    throw new JwsError("bad certificate")
  }

  if (root.fingerprint256 !== (options.rootFingerprint ?? trustedRoot)) {
    throw new JwsError("untrusted root")
  }
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new JwsError("leaf not issued by intermediate")
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new JwsError("intermediate not issued by root")
  if (!leaf.raw.includes(LEAF_OID)) throw new JwsError("leaf is not an App Store signing certificate")
  if (!intermediate.raw.includes(INTERMEDIATE_OID)) throw new JwsError("intermediate is not Apple WWDR")

  // Like Apple's offline verifier: certificates must be valid when the data was signed.
  const effective = typeof payload.signedDate === "number" ? new Date(payload.signedDate) : options.now ?? new Date()
  for (const cert of [leaf, intermediate, root]) {
    if (Date.parse(cert.validFrom) > effective.getTime() + MAX_CLOCK_SKEW_MS ||
        Date.parse(cert.validTo) < effective.getTime() - MAX_CLOCK_SKEW_MS) {
      throw new JwsError("certificate not valid at signedDate")
    }
  }

  const ok = verifySignature(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url")
  )
  if (!ok) throw new JwsError("bad signature")
  return payload
}

export interface AppleTransaction {
  originalTransactionId: string
  transactionId: string
  productId: string
  bundleId: string
  environment: string
  expiresDate?: number
  revocationDate?: number
  appAccountToken?: string
  signedDate?: number
  // What the customer paid (milliunits of `currency`) and where; absent in some sandbox data.
  price?: number
  currency?: string
  storefront?: string
  // 1 introductory, 2 promotional, 3 offer code, 4 win-back.
  offerType?: number
  // "FREE_TRIAL", "PAY_AS_YOU_GO" or "PAY_UP_FRONT" when an offer applies (newer transactions only).
  offerDiscountType?: string
  // The offer code's or promotional offer's identifier.
  offerIdentifier?: string
}

export interface Entitlement {
  plan: PaidPlan
  productId: string
  originalTransactionId: string
  environment: string
  expiresAt: number | null
  appAccountToken?: string
}

export function decodeTransaction(jws: string, options?: VerifyOptions): AppleTransaction {
  const tx = verifyAppleJws<AppleTransaction>(jws, options)
  if (tx.bundleId !== config.appStoreBundleId) throw new JwsError("wrong bundle id")
  if (!tx.originalTransactionId || !tx.productId) throw new JwsError("incomplete transaction")
  if (tx.environment !== "Production" && !(config.acceptSandbox && tx.environment === "Sandbox")) {
    throw new JwsError(`environment ${tx.environment} not accepted`)
  }
  return tx
}

export function toEntitlement(tx: AppleTransaction): Entitlement | null {
  const plan = PRODUCTS[tx.productId as keyof typeof PRODUCTS]
  if (!plan) return null
  return {
    plan,
    productId: tx.productId,
    originalTransactionId: String(tx.originalTransactionId),
    environment: tx.environment,
    expiresAt: typeof tx.expiresDate === "number" ? tx.expiresDate : null,
    appAccountToken: tx.appAccountToken
  }
}

// Verification is CPU work; the same JWS is sent with every request until the
// subscription renews, so warm function instances remember the result.
const cache = new Map<string, { tx: AppleTransaction | null; error?: string; at: number }>()
const CACHE_TTL_MS = 10 * 60_000

export function verifyTransactionCached(jws: string): { tx: AppleTransaction | null; error?: string } {
  const key = createHash("sha256").update(jws).digest("base64url")
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit
  let entry: { tx: AppleTransaction | null; error?: string; at: number }
  try {
    entry = { tx: decodeTransaction(jws), at: Date.now() }
  } catch (err) {
    entry = { tx: null, error: err instanceof Error ? err.message : "invalid", at: Date.now() }
  }
  if (cache.size > 500) cache.clear()
  cache.set(key, entry)
  return entry
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T
  } catch {
    throw new JwsError("malformed segment")
  }
}

// DER encoding of an OBJECT IDENTIFIER (tag + length + base-128 arcs).
function derOid(oid: string): Buffer {
  const arcs = oid.split(".").map(Number)
  const bytes = [arcs[0] * 40 + arcs[1]]
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f]
    let rest = arc >>> 7
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80)
      rest >>>= 7
    }
    bytes.push(...chunk)
  }
  return Buffer.from([0x06, bytes.length, ...bytes])
}
