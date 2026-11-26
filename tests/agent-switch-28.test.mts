// 2.8 (the director): the server switches the agent off (AGENT=off) → nothing in the panel or the app offers it. The
// status says so (`agent: {on}`); the device keeps the last state heard; not heard yet, the plans don't name the agent
// and its offers to someone without Pro wait, while Do stays as before for Pro and Ultra.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { agentOffered, agentSold, keptSwitch, switchFromStatus } from "../src/shared/agentSwitch.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

test("the state a status says: off only when it says so; an older server's status (no field) is on", () => {
  assert.equal(switchFromStatus({ agent: { on: false } }), "off")
  assert.equal(switchFromStatus({ agent: { on: true } }), "on")
  assert.equal(switchFromStatus({}), "on")
  assert.equal(switchFromStatus({ agent: null }), "on")
  assert.equal(keptSwitch("off"), "off")
  assert.equal(keptSwitch("on"), "on")
  assert.equal(keptSwitch(undefined), "unknown")
  assert.equal(keptSwitch("maybe"), "unknown")
})

test("off: nothing offers it; unknown: Do as before, the plans without it; on: everything", () => {
  assert.deepEqual([agentOffered("off"), agentSold("off")], [false, false])
  assert.deepEqual([agentOffered("unknown"), agentSold("unknown")], [true, false])
  assert.deepEqual([agentOffered(undefined), agentSold(undefined)], [true, false])
  assert.deepEqual([agentOffered("on"), agentSold("on")], [true, true])
})

test("the server: the status carries the switch next to organizing's", () => {
  assert.match(read("netlify/functions/v2-status.mts"), /agent: \{ on: settings\.agent\.enabled \},/)
})

test("the background keeps it (every status; offline the last heard) and the agent refuses to start or defer while off", () => {
  const bg = read("src/background/index.ts")
  assert.match(bg, /agent: switchFromStatus\(body\)\n    \}\n    void keepAgentSwitch\(value\.agent!, keptSwitch\(local\[AGENT_SWITCH_KEY\]\)\)/)
  assert.match(bg, /offline: true, organize: null,\n\s*\/\/ Offline: the agent as last heard[^\n]*\n\s*agent: keptSwitch\(local\[AGENT_SWITCH_KEY\]\)/)
  const agent = read("src/background/agent.ts")
  // Start (a deferred task's too) and defer: OFF before anything.
  assert.match(agent, /async function start\([^)]*\)[^{]*\{\n[^\n]*\n  if \(\(await deps\.agentSwitch\?\.\(\)\) === "off"\) return \{ ok: false, code: "OFF" \}/)
  assert.match(agent, /async function defer\([^)]*\)[^{]*\{\n  if \(\(await deps\.agentSwitch\?\.\(\)\) === "off"\) return \{ ok: false, code: "OFF" \}/)
  // A watch that fires sends no notification; the agent's own call answered OFF switches the device off at once.
  assert.match(agent, /export async function deferredWatchMet[\s\S]{0,200}if \(\(await deps\.agentSwitch\?\.\(\)\) === "off"\) return/)
  assert.match(agent, /if \(json\.code === "OFF"\) deps\.agentOffHeard\?\.\(\)/)
  // Notifications still ahead go when it's switched off and come back (in their own words) when it's on again.
  assert.match(agent, /if \(now === "off"\) await callNative\("agent_cancel", \{ id: d\.id \}, 6_000\)/)
  assert.match(agent, /callNative\("agent_schedule", \{ id: d\.id, at: d\.at, url: d\.url, title: w\.title, body: w\.body \}, 10_000\)/)
  assert.match(agent, /\/\/ \(A task due at a time keeps its words too[^\n]*\n\s*if \(task\) \{/)
})

test("the panel: Do in «+» and the send menu, the chip, the page line, the deferred task, the agent's plans message", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const agentHere = agentOffered\(agentSwitch\) && \(agentSells \|\| hasPro\(status\?\.plan \?\? keptPlan \?\? "free"\)\)/)
  assert.match(app, /const swipeDo = hasPro\(status\?\.plan \?\? keptPlan \?\? "free"\) && !historyMode && agentHere/)
  assert.match(app, /agent=\{historyMode \|\| !agentHere \? null : \{/)
  assert.match(app, /at === offerAt && agentHere && \(/)
  assert.match(app, /may: \(id\) => \(id !== "agent" \|\| agentHereRef\.current\) && /)
  assert.match(app, /if \(id === "agent"\) \{\n\s*if \(!agentHereRef\.current\) return/)
  assert.match(app, /\{agentUpsell && agentSells && \(\n\s*<PlanOffer\n\s*place="agent"/)
  assert.match(app, /if \(\(await agentSwitchNow\(\)\) === "off"\) return\n\s*const list = await sendBackground[^\n]*agentDeferred/)
  assert.match(app, /if \(!text \|\| \(await agentSwitchNow\(\)\) === "off"\) return/)
  assert.match(app, /else if \(r\?\.code === "OFF"\) \{\n[^\n]*\n\s*setAgentMode\(false\)\n\s*setDraft\(text\)/)
  assert.match(app, /if \(agentSwitch === "off"\) setAgentMode\(false\)/)
})

test("the panel's gallery: the agent's slide only when known on, the slide on screen kept by name", () => {
  const gallery = read("src/content/Gallery.tsx")
  assert.match(gallery, /const slides = agentSold\(useAgentSwitch\(\)\) \? SLIDES : SLIDES\.filter\(\(s\) => s !== "agent"\)/)
  assert.match(gallery, /const \[at, setAt\] = useState<Slide>/)
  assert.doesNotMatch(gallery, /SLIDES\.map|SLIDES\.length|SLIDES\[index\]/)
})

test("the app: the switch from every status it reads; the plans and their gallery only when on; What's new and Tips unless off", () => {
  const ai = read("ContextFlow/Shared (App)/ChatAI.swift")
  assert.equal((ai.match(/AgentSwitch\.heard\(object\)/g) ?? []).length, 3)
  assert.match(ai, /let on = \(\(status\["agent"\] as\? \[String: Any\]\)\?\["on"\] as\? Bool\) != false/)
  assert.match(ai, /static var offered: Bool \{ kept != "off" \}/)
  assert.match(ai, /static var sold: Bool \{ kept == "on" \}/)
  assert.match(ai, /var agentSold = AgentSwitch\.sold/)
  const view = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(view, /if store\.planFacts\.agentSold \{\n\s*Feature\(systemImage: "calendar\.badge\.checkmark", text: "It books for you, right on the page"\)/)
  assert.match(view, /static func keeps\(_ tip: Tip\) -> Bool \{ offered \|\| tip\.title != TipGroup\.agentTip\.title \}/)
  assert.match(view, /ForEach\(TipGroup\.shown, id: \\\.id\)/)
  assert.match(view, /all\.map \{ group in TipGroup\(id: group\.id, title: group\.title, tips: group\.tips\.filter\(AgentSwitch\.keeps\)\) \}/)
  assert.match(read("ContextFlow/Shared (App)/WhatsNew.swift"), /\[TipGroup\.agentTip, TipGroup\.cookiesTip\]\.filter\(AgentSwitch\.keeps\)/)
  // The panel's Tips (the app's, built in): without the agent's card while off.
  const tips = read("src/content/tips/TipsSheet.tsx")
  assert.match(tips, /const data = withoutAgent\(tipsData\(\), useAgentSwitch\(\) === "off"\)/)
  assert.match(view, /static var agentTip: Tip \{\n\s*#if os\(iOS\)\n\s*Tip\(symbol: "sparkles", color: brandBlue, title: "It books for you, right on the page"/)
  assert.match(tips, /const AGENT_TIP = "It books for you, right on the page"/)
  const gallery = read("ContextFlow/Shared (App)/PaidGallery.swift")
  assert.match(gallery, /private var first: Int \{ facts\.agentSold \? 0 : Slide\.media\.rawValue \}/)
  assert.match(gallery, /ForEach\(slides, id: \\\.rawValue\)/)
  assert.match(gallery, /guard target != shown, target >= first/)
})
