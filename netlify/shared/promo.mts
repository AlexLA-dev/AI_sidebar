// Own key → Pro at a discount: StoreKit promotional offers are signed by the developer's server with an
// In-App Purchase key (App Store Connect → Users and Access → Integrations → In-App Purchase). The app passes
// the signature to Product.purchase(options: .promotionalOffer(…)); Apple checks it and charges the offer.
// https://developer.apple.com/documentation/storekit/generating-a-signature-for-promotional-offers

import { createPrivateKey, randomUUID, sign } from "node:crypto"

import { config } from "./config.mts"

/** All three are set in Netlify: the offer, the key's id and the key itself. */
export function promoConfigured(): boolean {
  return Boolean(config.promoOfferId && config.promoKeyId && config.promoPrivateKey)
}

export interface PromoSignature {
  offerId: string
  keyId: string
  nonce: string
  timestamp: number
  signature: string
}

/**
 * Apple's signature for one purchase: ECDSA P-256 / SHA-256 (DER, base64) over bundle id, key id, product id,
 * offer id, app account token (lowercase; empty without one), nonce (lowercase) and timestamp (ms), joined
 * with U+2063.
 */
export function signPromo(bundleId: string, productId: string, appAccountToken: string, now = Date.now()): PromoSignature {
  const nonce = randomUUID().toLowerCase()
  const payload = [bundleId, config.promoKeyId, productId, config.promoOfferId, appAccountToken.toLowerCase(), nonce, String(now)].join("⁣")
  const key = createPrivateKey(config.promoPrivateKey)
  const signature = sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }).toString("base64")
  return { offerId: config.promoOfferId, keyId: config.promoKeyId, nonce, timestamp: now, signature }
}
