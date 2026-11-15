// 2.7, plan section 5 «Пригласи друга»: the code's rules, the friend's extra answers in every free allowance, the
// inviter's reward, Apple DeviceCheck, /api/v2/invite over an in-memory stand-in for the cf_invite_* functions (the SQL
// itself is checked on Postgres by ~/ContextFlow-work/invite-27/pg/check.mjs), and the panel's and the app's wiring.
import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { before, beforeEach, test } from "node:test"

import { INVITE_ALPHABET, inviteLink, parseInviteCode } from "../src/shared/invite.ts"
import { FEATURES } from "../src/shared/usage.ts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const INVITER = "11111111-1111-4111-8111-111111111111"
const FRIEND = "22222222-2222-4222-8222-222222222222"
const APP = "33333333-3333-4333-8333-333333333333"

// ---- in-memory stand-ins: cf_consume, cf_log, cf_invite_*, Apple's DeviceCheck ------------------------------------
type Row = { friend: string; install: string | null; code: string; device: string; until: string; active: boolean }
let codes = new Map<string, string>() // code → install
let invites: Row[] = []
let events: { kind: string; data: Record<string, unknown> }[] = []
let consumed = new Map<string, number>()
let bits = new Map<string, boolean>() // device token → bit0
let rpcCalls: string[] = []
let dbDown = false

const json = (v: unknown) => Response.json(v)
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.includes("devicecheck.apple.com")) {
    assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    const token = String(body.device_token)
    // A development build's token is unknown to the production server; a broken one to both.
    const known = token !== "broken-token-xxxxxxxxxxxxxxxx" && (!token.startsWith("dev-") || url.includes("api.development."))
    if (!known) return new Response("Missing or incorrectly formatted device token payload", { status: 400 })
    if (url.endsWith("/query_two_bits")) return bits.has(token) ? json({ bit0: bits.get(token), bit1: false, last_update_time: "2026-11" }) : new Response("Failed to find bit state", { status: 200 })
    if (url.endsWith("/update_two_bits")) {
      bits.set(token, body.bit0)
      return new Response("", { status: 200 })
    }
  }
  const fn = url.startsWith("https://db.test/rest/v1/rpc/") ? url.split("/rpc/")[1].split("?")[0] : ""
  rpcCalls.push(fn)
  if (dbDown && fn.startsWith("cf_invite")) return new Response(JSON.stringify({ message: `function public.${fn} does not exist` }), { status: 404, headers: { "Content-Type": "application/json" } })
  switch (fn) {
    case "cf_consume": {
      const items = body.p_items as Array<{ subject: string; limit: number | null }>
      const blocked = items.find((i) => i.limit !== null && (consumed.get(i.subject) ?? 0) >= i.limit)
      if (!blocked) items.forEach((i) => consumed.set(i.subject, (consumed.get(i.subject) ?? 0) + 1))
      return json({ allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: consumed.get(i.subject) ?? 0 })) })
    }
    case "cf_log":
      events.push({ kind: body.p_kind, data: body.p_data })
      return json(null)
    case "cf_invite_code": {
      for (const [code, owner] of codes) if (owner === body.p_install || owner === body.p_other) return json(code)
      if (codes.has(body.p_new)) return json(null)
      codes.set(body.p_new, body.p_install)
      return json(body.p_new)
    }
    case "cf_invite_redeem": {
      const owner = codes.get(body.p_code)
      if (!owner) return json("unknown")
      if (owner === body.p_friend || owner === body.p_install) return json("own")
      if (invites.some((r) => [r.friend, r.install].includes(body.p_friend) || (body.p_install && [r.friend, r.install].includes(body.p_install)))) return json("already")
      if (invites.filter((r) => r.code === body.p_code).length >= body.p_cap) return json("full")
      invites.push({ friend: body.p_friend, install: body.p_install, code: body.p_code, device: body.p_device, until: body.p_until, active: false })
      return json("ok")
    }
    case "cf_invite_link": {
      const row = invites.find((r) => r.friend === body.p_app && !r.install)
      if (!row) return json(false)
      row.install = body.p_install
      return json(true)
    }
    case "cf_invite_bonus":
      return json(invites.some((r) => (body.p_ids.includes(r.friend) || body.p_ids.includes(r.install)) && Date.parse(r.until) > Date.now()))
    case "cf_invite_state": {
      const code = [...codes].find(([, owner]) => body.p_ids.includes(owner))?.[0] ?? null
      const mine = invites.filter((r) => r.code === code)
      const entered = invites.find((r) => body.p_ids.includes(r.friend) || body.p_ids.includes(r.install))
      return json({ code, joined: mine.length, active: mine.filter((r) => r.active).length, new_active: 0, answers_taken: 0, answers_last: null, entered_until: entered?.until ?? null, first_seen: null })
    }
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let invite: (req: Request, ctx: any) => Promise<Response>
let config: any
let plan: typeof import("../netlify/shared/plan.mts")
let shared: typeof import("../netlify/shared/invite.mts")
let dc: typeof import("../netlify/shared/devicecheck.mts")

before(async () => {
  config = (await import("../netlify/shared/config.mts")).config
  invite = (await import("../netlify/functions/v2-invite.mts")).default
  plan = await import("../netlify/shared/plan.mts")
  shared = await import("../netlify/shared/invite.mts")
  dc = await import("../netlify/shared/devicecheck.mts")
})

beforeEach(() => {
  codes = new Map([["ABC234", INVITER]])
  invites = []
  events = []
  consumed = new Map()
  bits = new Map()
  rpcCalls = []
  dbDown = false
  config.deviceCheck.keyId = ""
  config.deviceCheck.privateKey = ""
  config.invite.ultraOfferCode = ""
  config.invite.inviterAnswers = false
})

function ctx(ip = "203.0.113.7") {
  const pending: Promise<unknown>[] = []
  return { ip, waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}
async function call(body: Record<string, unknown>) {
  const c = ctx()
  const res = await invite(new Request("https://aisidebar.netlify.app/api/v2/invite", { method: "POST", body: JSON.stringify({ client: { platform: "ios", version: "2.7" }, ...body }) }), c)
  await Promise.all(c.pending)
  return { status: res.status, body: (await res.json()) as any }
}

// ---- the code -------------------------------------------------------------------------------------------------------

test("a code is read from what was typed or pasted: any case, spaces, a dash, the link, a message with the link", () => {
  assert.equal(parseInviteCode("ABC234"), "ABC234")
  assert.equal(parseInviteCode(" abc-234 "), "ABC234")
  assert.equal(parseInviteCode("abc 234"), "ABC234")
  assert.equal(parseInviteCode("https://context-flow.app/i/abc234"), "ABC234")
  assert.equal(parseInviteCode("Пользуюсь ContextFlow. С моим кодом ABC234 у тебя будут бонусные ответы: https://context-flow.app/i/ABC234"), "ABC234")
  for (const bad of ["", "ABC23", "ABC2345", "ABCI23", "AB0234", "O00000", "https://context-flow.app/i/ABC2345", null, 42]) assert.equal(parseInviteCode(bad), null, String(bad))
  assert.equal(inviteLink("ABC234"), "https://context-flow.app/i/ABC234")
})

test("a code typed on a Japanese or Chinese keyboard in full width is the same code, in the panel and in the app", () => {
  assert.equal(parseInviteCode("ＡＢＣ２３４"), "ABC234")
  assert.equal(parseInviteCode("ａｂｃ－２３４"), "ABC234", "full-width dash")
  assert.equal(parseInviteCode("ＡＢＣ\u3000２３４"), "ABC234", "ideographic space")
  assert.equal(parseInviteCode("https://context-flow.app/i/ＡＢＣ２３４"), "ABC234")
  assert.equal(parseInviteCode("ＡＢＣ２３"), null)
  const swift = readFileSync(new URL("../ContextFlow/Shared (App)/Invite.swift", import.meta.url), "utf8")
  assert.match(swift, /static func parseCode\(_ raw: String\) -> String\? \{\n\s+let text = String\(raw\.precomposedStringWithCompatibilityMapping\./)
})

test("new codes use the alphabet without look-alikes, six signs", () => {
  assert.doesNotMatch(INVITE_ALPHABET, /[0O1IL]/)
  const made = new Set(Array.from({ length: 300 }, () => shared.newCode()))
  for (const code of made) assert.equal(parseInviteCode(code), code)
  assert.ok(made.size > 295, "random")
})

// ---- the friend's extra answers -------------------------------------------------------------------------------------

test("the friend's extra answers raise the free daily allowance only, never Pro's week", () => {
  const free = { plan: "free" as const, entitlement: null }
  assert.equal(plan.countersFor(free, FRIEND, "ip:x")[0].limit, config.freeDailyLimit)
  assert.equal(plan.countersFor(free, FRIEND, "ip:x", 5)[0].limit, config.freeDailyLimit + 5)
  assert.equal(plan.countersFor(free, FRIEND, "ip:x", -3)[0].limit, config.freeDailyLimit)
  const pro = { plan: "pro" as const, entitlement: { plan: "pro" as const, productId: "com.contextflow.pro.monthly", originalTransactionId: "1", environment: "Production", expiresAt: null } }
  assert.equal(plan.countersFor(pro, FRIEND, "ip:x", 5)[0].limit, config.proWeeklyLimit)
})

test("the database is asked about the bonus only for requests marked inv, on free (or Own key) plans", async () => {
  invites.push({ friend: FRIEND, install: FRIEND, code: "ABC234", device: "checked", until: new Date(Date.now() + 86_400_000).toISOString(), active: false })
  assert.equal(await shared.inviteExtra({ platform: "ios" }, [FRIEND], "free"), 0)
  assert.deepEqual(rpcCalls, [], "no mark, no call")
  assert.equal(await shared.inviteExtra({ inv: 1 }, [FRIEND], "pro"), 0)
  assert.deepEqual(rpcCalls, [])
  assert.equal(await shared.inviteExtra({ inv: 1 }, [FRIEND], "free"), config.invite.friendDaily)
  assert.equal(await shared.inviteExtra({ inv: 1 }, [INVITER], "free"), 0, "the mark alone gains nothing")
  dbDown = true
  assert.equal(await shared.inviteExtra({ inv: 1 }, [FRIEND], "free"), 0, "before the migration: as before")
})

test("every request that charges a free answer passes the friend's extra answers", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
  for (const fn of ["v2-chat", "v2-status", "v2-find", "v2-write", "v2-translate"]) {
    assert.match(read(`netlify/functions/${fn}.mts`), /inviteExtra\(client, \[installId\], access\.plan\)/, fn)
  }
  assert.match(read("netlify/functions/v2-write.mts"), /answer: countersFor\(access, installId, ip, extra\)/)
  assert.match(read("netlify/shared/translate.mts"), /answer: countersFor\(access, installId, ip, extra\)/)
})

// ---- /api/v2/invite ---------------------------------------------------------------------------------------------------

test("state: nothing is made by looking; create makes the install's code once", async () => {
  let r = await call({ op: "state", installId: FRIEND })
  assert.equal(r.status, 200)
  assert.equal(r.body.code, null)
  assert.equal(r.body.canEnter, true)
  r = await call({ op: "state", installId: FRIEND, create: true })
  assert.match(r.body.code, /^[A-HJKMNP-Z2-9]{6}$/)
  assert.equal(r.body.link, `https://context-flow.app/i/${r.body.code}`)
  const again = await call({ op: "state", installId: FRIEND, create: true })
  assert.equal(again.body.code, r.body.code)
  assert.equal(codes.size, 2)
})

test("redeem: a friend's code on a new install, its bonus, the refusals", async () => {
  let r = await call({ op: "redeem", installId: FRIEND, code: "abc-234" })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.friendDaily, config.invite.friendDaily)
  assert.ok(Date.parse(r.body.until) > Date.now() + 6 * 86_400_000)
  assert.deepEqual(invites[0], { ...invites[0], friend: FRIEND, install: FRIEND, code: "ABC234", device: "unchecked" })
  assert.equal((await call({ op: "redeem", installId: FRIEND, code: "ABC234" })).body.code, "ALREADY")
  assert.equal((await call({ op: "redeem", installId: INVITER, code: "ABC234" })).body.code, "OWN_CODE")
  assert.equal((await call({ op: "redeem", installId: APP, code: "ZZZ999" })).body.code, "CODE_UNKNOWN")
  assert.equal((await call({ op: "redeem", installId: APP, code: "nonsense" })).body.code, "CODE_UNKNOWN")
  assert.deepEqual(events.filter((e) => e.kind === "invite_redeem").map((e) => e.data.result), ["ok", "already", "own", "unknown"])
  // The friend's state says so; the inviter sees a friend.
  assert.ok((await call({ op: "state", installId: FRIEND })).body.entered.until)
  assert.equal((await call({ op: "state", installId: INVITER })).body.joined, 1)
})

test("redeem from the app before the extension ran: the app's id; the extension's install links it later", async () => {
  let r = await call({ op: "redeem", installId: APP, appId: APP, code: "ABC234" })
  assert.equal(r.body.ok, true)
  assert.deepEqual([invites[0].friend, invites[0].install], [APP, null])
  r = await call({ op: "link", installId: FRIEND, appId: APP })
  assert.deepEqual(r.body, { ok: true, linked: true })
  assert.equal(invites[0].install, FRIEND)
  assert.equal(await shared.inviteExtra({ inv: 1 }, [FRIEND], "free"), config.invite.friendDaily)
  // With the extension known, the app sends both: linked at once.
  invites = []
  r = await call({ op: "redeem", installId: FRIEND, appId: APP, code: "ABC234" })
  assert.deepEqual([invites[0].friend, invites[0].install], [APP, FRIEND])
})

test("tries are capped per install and per address; a code per day and in all", async () => {
  for (let i = 0; i < config.invite.triesDaily; i++) await call({ op: "redeem", installId: FRIEND, code: "ZZZ999" })
  assert.equal((await call({ op: "redeem", installId: FRIEND, code: "ABC234" })).body.code, "LIMIT_REACHED")
  consumed = new Map()
  const cap = config.invite.cap
  config.invite.cap = 1
  await call({ op: "redeem", installId: FRIEND, code: "ABC234" })
  assert.equal((await call({ op: "redeem", installId: APP, code: "ABC234" })).body.code, "CODE_FULL")
  config.invite.cap = cap
})

test("DeviceCheck, once its key is set: a token is needed, one friend's bonus per device, the bit set after", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  config.deviceCheck.keyId = "KEY1234567"
  config.deviceCheck.privateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  // The JWT: ES256, the key's id, the team; signed with the key.
  const jwt = dc.deviceCheckJwt(Date.now() + 3_600_000)
  const [head, payload, sig] = jwt.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" })
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, config.deviceCheck.teamId)
  assert.ok(verify("sha256", Buffer.from(`${head}.${payload}`), { key: createPublicKey(publicKey.export({ type: "spki", format: "pem" })), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")))

  assert.equal((await call({ op: "redeem", installId: FRIEND, code: "ABC234" })).body.code, "DEVICE_CHECK", "no token")
  assert.equal((await call({ op: "redeem", installId: FRIEND, code: "ABC234", deviceToken: "broken-token-xxxxxxxxxxxxxxxx" })).body.code, "DEVICE_CHECK")
  const token = "token-of-a-real-device-0000000000"
  const ok = await call({ op: "redeem", installId: FRIEND, code: "ABC234", deviceToken: token })
  assert.equal(ok.body.ok, true)
  assert.equal(invites[0].device, "checked")
  assert.equal(bits.get(token), true, "bit0 set")
  // A reinstall on the same device: a new install id, the same device.
  assert.equal((await call({ op: "redeem", installId: APP, code: "ABC234", deviceToken: token })).body.code, "DEVICE_USED")
  // A development build's token is found on Apple's development server.
  const dev = await call({ op: "redeem", installId: "44444444-4444-4444-8444-444444444444", code: "ABC234", deviceToken: "dev-token-from-xcode-00000000000" })
  assert.equal(dev.body.ok, true)
})

test("Apple's answers to query_two_bits", () => {
  assert.equal(dc.readBits(200, "Failed to find bit state"), "new")
  assert.equal(dc.readBits(200, JSON.stringify({ bit0: false, bit1: true })), "new")
  assert.equal(dc.readBits(200, JSON.stringify({ bit0: true, bit1: false })), "used")
  assert.equal(dc.readBits(400, "Missing or incorrectly formatted device token payload"), "bad")
  assert.equal(dc.readBits(401, "Unable to verify authorization token"), "error")
  assert.equal(dc.readBits(200, "<html>"), "error")
})

test("the inviter's reward: Pro's offer code once a friend is active, Ultra's once set up; answers only when switched on", () => {
  const row = { code: "ABC234", joined: 2, active: 0, new_active: 0, answers_taken: 0, answers_last: null, entered_until: null, first_seen: null }
  assert.equal(shared.stateOf(row, "CONTEXTFLOW50", 50).reward, null, "no active friend yet")
  let state = shared.stateOf({ ...row, active: 1 }, "CONTEXTFLOW50", 50)
  assert.deepEqual(state.reward, { pro: { code: "CONTEXTFLOW50", discount: 50 }, ultra: null, answers: null })
  config.invite.ultraOfferCode = "ULTRA50"
  config.invite.inviterAnswers = true
  state = shared.stateOf({ ...row, active: 2, answers_taken: 1 }, "CONTEXTFLOW50", 50)
  assert.deepEqual(state.reward, { pro: { code: "CONTEXTFLOW50", discount: 50 }, ultra: { code: "ULTRA50", discount: 50 }, answers: { daily: config.invite.friendDaily, days: config.invite.friendDays, left: 1 } })
  assert.equal(shared.stateOf({ ...row, active: 1 }, "off", 50).reward?.pro, null, "PRO_OFFER_CODE=off")
  // A friend's code can be entered only on a new install that hasn't entered one.
  assert.equal(shared.stateOf({ ...row, first_seen: new Date(Date.now() - 2 * 86_400_000).toISOString() }, "", 50).canEnter, true)
  assert.equal(shared.stateOf({ ...row, first_seen: new Date(Date.now() - 30 * 86_400_000).toISOString() }, "", 50).canEnter, false)
  assert.equal(shared.stateOf({ ...row, entered_until: new Date().toISOString() }, "", 50).canEnter, false)
  const answersLast = new Date(Date.now() - 86_400_000).toISOString()
  assert.ok(shared.stateOf({ ...row, answers_last: answersLast }, "", 50).answersUntil)
  assert.equal(shared.stateOf({ ...row, answers_last: new Date(Date.now() - 30 * 86_400_000).toISOString() }, "", 50).answersUntil, null)
})

test("the inviter's answers are refused unless switched on (the owner hasn't decided)", async () => {
  assert.equal((await call({ op: "answers", installId: INVITER })).body.code, "UNAVAILABLE")
})

test("before the migration: UNAVAILABLE, nothing else breaks", async () => {
  dbDown = true
  const r = await call({ op: "state", installId: FRIEND, create: true })
  assert.deepEqual([r.status, r.body.code], [503, "UNAVAILABLE"])
  config.invite.enabled = false
  assert.equal((await call({ op: "state", installId: FRIEND })).status, 404)
  config.invite.enabled = true
  assert.equal((await call({ op: "state", installId: "not-a-uuid" })).body.code, "BAD_REQUEST")
})

// ---- the clients -----------------------------------------------------------------------------------------------------

test("every string of the panel's invite is in all 14 languages, with its placeholders", () => {
  const dir = new URL("../src/locales/", import.meta.url)
  const en = JSON.parse(readFileSync(new URL("en.json", dir), "utf8"))
  const keys = Object.keys(en).filter((k) => k.startsWith("inv"))
  assert.ok(keys.length >= 28)
  for (const file of readdirSync(dir)) {
    const strings = JSON.parse(readFileSync(new URL(file, dir), "utf8"))
    for (const k of keys) {
      assert.ok(typeof strings[k] === "string" && strings[k].trim(), `${file}: ${k}`)
      assert.deepEqual((strings[k].match(/\{\d\}/g) ?? []).sort(), (en[k].match(/\{\d\}/g) ?? []).sort(), `${file}: ${k} placeholders`)
    }
  }
})

test("the app's invite strings are translated in its 13 languages with matching placeholders", () => {
  const catalog = JSON.parse(readFileSync(new URL("../ContextFlow/Shared (App)/Localizable.xcstrings", import.meta.url), "utf8"))
  const swift = readFileSync(new URL("../ContextFlow/Shared (App)/Invite.swift", import.meta.url), "utf8")
  const keys = ["Invite a friend", "Have a friend's code?", "Code or link", "Enter", "Get my code and link", "Your code",
    "Came with your code: %lld · using it: %lld", "Code accepted: bonus answers, +%lld a day, until %@.",
    "I use ContextFlow, AI right on the page in Safari. With my code %@ you get bonus answers for your first week: %@",
    "Thank you: %lld%% off the first month of Pro or Ultra, your choice. The App Store applies it if you haven't used this discount before.",
    "Couldn't check this device. Try again later.", "Enter it for bonus answers in your first week."]
  const spec = (s: string) => (s.match(/%(\d\$)?(lld|@)/g) ?? []).map((m) => m.replace(/\d\$/, "")).sort()
  for (const key of keys) {
    const entry = catalog.strings[key]
    assert.ok(entry, key)
    const langs = Object.keys(entry.localizations)
    assert.equal(langs.length, 14, key)
    for (const lang of langs) assert.deepEqual(spec(entry.localizations[lang].stringUnit.value), spec(key), `${lang}: ${key}`)
  }
  assert.match(swift, /DCDevice\.current\.generateToken/)
  assert.match(swift, /PasteButton\(payloadType: String\.self\)/, "the system's paste button asks nothing")
})

test("wiring: the panel's group, the reward card, the marks on requests; the app's first screen, Settings and links", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
  assert.match(read("src/content/Settings.tsx"), /TARGET === "safari" && <InviteGroup onRedeem=\{props\.onRedeem\}/)
  assert.match(read("src/content/App.tsx"), /<InviteRewardCard onRedeem=\{redeemOffer\}/)
  assert.match(read("src/content/index.tsx"), /\$\{inviteStyles\}/)
  assert.match(read("src/background/index.ts"), /inviteMarks\(\)/)
  assert.match(read("src/background/index.ts"), /startInvite\(\{/)
  const content = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(content, /FriendCodeCard\(\)/)
  assert.match(content, /case "invite":/)
  assert.match(content, /InviteModel\.shared\.shown = true/)
  assert.match(read("ContextFlow/Shared (App)/ChatAI.swift"), /client\["inv"\] = 1/)
  assert.match(read("ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift"), /case "invite":/)
  assert.match(read("ContextFlow/ContextFlow.xcodeproj/project.pbxproj"), /Invite\.swift in Sources/)
  // The site page: the code from the address, the App Store button copies it, the app's link.
  const page = read("site/i.html")
  assert.match(page, /<meta name="robots" content="noindex" \/>/)
  assert.match(page, /contextflow:\/\/invite\?code=/)
  assert.match(read("netlify.toml"), /from = "\/i\/\*"\n\s+to = "\/i\.html"\n\s+status = 200/)
  // Counted steps, named in the registry.
  assert.deepEqual([...FEATURES.invite.actions].sort(), ["code_bad", "code_ok", "copy", "open", "reward_answers", "reward_pro", "reward_shown", "reward_ultra", "share"])
})
