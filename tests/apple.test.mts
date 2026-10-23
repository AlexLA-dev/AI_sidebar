import assert from "node:assert/strict"
import { test } from "node:test"

import { APPLE_ROOT_CA_G3_FINGERPRINT, decodeTransaction, toEntitlement, verifyAppleJws } from "../netlify/shared/apple.mts"
import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

const opts = { rootFingerprint: TEST_ROOT_FINGERPRINT }

test("accepts a correctly signed StoreKit transaction", () => {
  const tx = decodeTransaction(signJws(transaction()), opts)
  assert.equal(tx.productId, "com.contextflow.pro.monthly")
  const ent = toEntitlement(tx)
  assert.equal(ent?.plan, "pro")
  assert.equal(ent?.originalTransactionId, "2000000123")
})

test("maps the BYOK product", () => {
  const tx = decodeTransaction(signJws(transaction({ productId: "com.contextflow.byok.monthly" })), opts)
  assert.equal(toEntitlement(tx)?.plan, "byok")
})

test("rejects a chain that does not end at Apple Root CA G3", () => {
  assert.throws(() => verifyAppleJws(signJws(transaction())), /untrusted root/)
  assert.equal(APPLE_ROOT_CA_G3_FINGERPRINT.length, 95)
})

test("rejects a leaf without the App Store marker OID (e.g. a developer certificate)", () => {
  assert.throws(() => verifyAppleJws(signJws(transaction(), { leaf: "rogue" }), opts), /App Store signing certificate/)
})

test("rejects a tampered payload", () => {
  assert.throws(() => verifyAppleJws(signJws(transaction(), { tamper: true }), opts), /bad signature/)
})

test("rejects another app's purchase", () => {
  assert.throws(() => decodeTransaction(signJws(transaction({ bundleId: "com.other.app" })), opts), /wrong bundle/)
})

test("rejects Xcode-local transactions", () => {
  assert.throws(() => decodeTransaction(signJws(transaction({ environment: "Xcode" })), opts), /not accepted/)
})

test("rejects garbage", () => {
  assert.throws(() => verifyAppleJws("a.b"), /malformed/)
  assert.throws(() => verifyAppleJws("e30.e30.e30"), /unsupported alg/)
})
