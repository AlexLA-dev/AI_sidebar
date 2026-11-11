import Foundation

// The app's side of tests/organize-parity.test.mts: reads cases (JSON) on stdin, writes what Organize.swift
// gives for each on stdout. Built together with ContextFlow/Shared (App)/Organize.swift.

func thread(_ raw: Any?) -> OrganizeThread? {
    guard let raw = raw as? [String: Any], let id = raw["id"] as? String, let u = (raw["u"] as? NSNumber)?.int64Value else { return nil }
    var object = raw
    object.removeValue(forKey: "id")
    object.removeValue(forKey: "u")
    return OrganizeThread(id: id, u: u, object: object)
}

func out(_ thread: OrganizeThread?) -> Any {
    guard let thread else { return NSNull() }
    var object = thread.object
    object["id"] = thread.id
    object["u"] = NSNumber(value: thread.u)
    return object
}

func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
func ms(_ value: Any?) -> Int64 { (value as? NSNumber)?.int64Value ?? 0 }
func threads(_ raw: Any?) -> [OrganizeThread] { (raw as? [Any] ?? []).compactMap(thread) }

/// The case's vectors by message key, as numbers or packed (base64): both sides use the same ones.
func vectors(_ raw: Any?) -> Organize.VectorOf {
    let table = raw as? [String: Any] ?? [:]
    return { entry in
        switch table[Organize.entryKey(entry)] {
        case let packed as String: return Organize.unpackVector(packed)
        case let numbers as [NSNumber]: return numbers.map { Float($0.doubleValue) }
        default: return nil
        }
    }
}

/// A vector as JSON: its Float numbers as the Doubles they are (as `Array.from` a Float32Array).
func numbers(_ v: [Float]?) -> Any { v.map { $0.map(Double.init) } ?? NSNull() }

func suggestion(_ s: Organize.MoveSuggestion?) -> Any {
    guard let s else { return NSNull() }
    var out: [String: Any] = ["start": s.start, "end": s.end, "to": s.to ?? NSNull(), "why": s.why.rawValue, "score": s.score, "current": s.current]
    if let match = s.match { out["match"] = match }
    if let from = s.from { out["from"] = from }
    return out
}

func candidate(_ c: Organize.TagCandidate) -> Any {
    ["tag": c.tag, "pos": c.pos, "neg": c.neg, "coherence": c.coherence, "examples": c.examples] as [String: Any]
}

func verdicts(_ raw: Any?) -> [Organize.TagVerdict] {
    (raw as? [[String: Any]] ?? []).map {
        Organize.TagVerdict(tag: $0["tag"] as? String ?? "", fits: $0["fits"] as? Bool ?? false, confidence: ($0["confidence"] as? NSNumber)?.doubleValue ?? 0)
    }
}

func run(_ c: [String: Any]) -> Any {
    let cfg = OrganizeConfig(c["cfg"])
    switch c["op"] as? String {
    case "config":
        let read = OrganizeConfig(c["raw"])
        return Dictionary(uniqueKeysWithValues: OrganizeConfig.fields.map { ($0.name, read[keyPath: $0.path]) })
    case "embedText":
        return (c["m"] as? [[String: Any]] ?? []).map(Organize.embedText)
    case "nameText":
        return Organize.nameText(c["m"] as? [[String: Any]] ?? [])
    case "wantsNameCheck":
        return thread(c["chat"]).map(Organize.wantsNameCheck) ?? false
    case "org":
        // 2.6 (93): the state kept with a chat as it's read back, what it still suggests, a name check's answer on it,
        // the state a run keeps, and what a name check is about.
        guard let chat = thread(c["chat"]) else { return NSNull() }
        let chats = threads(c["chats"])
        let org = chat.org
        let answer = c["answer"] as? [String: Any] ?? [:]
        let after = Organize.nameState(after: org?.nm, key: c["key"] as? String ?? "", fits: answer["fits"] as? Bool ?? false,
                                       title: answer["title"] as? String ?? "", current: c["current"] as? String ?? "")
        let tg = (c["tg"] as? [[String]] ?? []).map { (key: $0[0], tag: $0[1]) }
        let state = Organize.orgState(for: chat, move: Organize.suggestMove(chat, chats, vectors(c["vectors"]), cfg), tags: tg, nm: org?.nm)
        return ["clean": org?.json ?? NSNull(), "move": Organize.openMove(chat, chats)?.json ?? NSNull(),
                "tags": Organize.openTags(chat).map { ["index": $0.index, "key": $0.key, "tag": $0.tag] as [String: Any] },
                "name": Organize.openName(chat, name: c["name"] as? String ?? "") ?? NSNull(), "after": after.json, "state": state.json,
                "key": Organize.nameCheckKey(chat)] as [String: Any]
    case "names":
        let pairs = (c["pairs"] as? [[String]] ?? []).map { Organize.nearName($0[0], $0[1]) }
        let downs = (c["downs"] as? [[Any]] ?? []).map { Organize.turnedDownName($0[0] as? [String] ?? [], $0[1] as? String ?? "") }
        return ["near": pairs, "down": downs]
    case "hostOf":
        return (c["urls"] as? [Any] ?? []).map { Organize.hostOf($0 as? String) }
    case "pack":
        let packed = (c["vectors"] as? [[NSNumber]] ?? []).map { Organize.packVector($0.map(\.doubleValue)) }
        return ["packed": packed, "unpacked": packed.map { numbers(Organize.unpackVector($0)) }]
    case "unpack":
        return (c["packed"] as? [String] ?? []).map { numbers(Organize.unpackVector($0)) }
    case "scoredBlocks":
        return Organize.scoredBlocks(c["m"] as? [[String: Any]] ?? [], vectors(c["vectors"])).map { b -> [String: Any] in
            ["start": b.start, "end": b.end, "url": b.url ?? NSNull(), "v": numbers(b.v), "a": numbers(b.a), "weak": b.weak, "t": b.t.map(Organize.whole) ?? NSNull(),
             "host": b.host, "settled": b.settled, "dismissed": b.dismissed]
        }
    case "movesAllowed":
        guard let chat = thread(c["chat"]) else { return NSNull() }
        return Organize.movesAllowed(chat, threads(c["chats"]), cfg)
    case "suggestMove":
        guard let chat = thread(c["chat"]) else { return NSNull() }
        return suggestion(Organize.suggestMove(chat, threads(c["chats"]), vectors(c["vectors"]), cfg))
    case "scan":
        guard let chat = thread(c["chat"]) else { return NSNull() }
        let chats = threads(c["chats"])
        let vectorOf = vectors(c["vectors"])
        let s = Organize.organizeScan(chat, chats, vectorOf, cfg, Organize.suggestMove(chat, chats, vectorOf, cfg))
        return ["chats": s.chats, "msgs": s.msgs, "vec": s.vec, "mg": s.mg, "mga": s.mga, "mgw": s.mgw, "mv": s.mv, "mvw": s.mvw, "res": s.res, "tv": s.tv]
    case "tags":
        // Each message that gets tag suggestions now: its candidates, the judge's text, and what the verdicts leave.
        guard let chat = thread(c["chat"]) else { return NSNull() }
        let chats = threads(c["chats"])
        let vectorOf = vectors(c["vectors"])
        return Organize.tagTargets(chat, cfg, chats, vectorOf).map { i -> [String: Any] in
            let candidates = Organize.tagCandidates(chat, i, chats, vectorOf, cfg)
            return ["i": i, "judge": Organize.judgeText(chat.entries, i), "candidates": candidates.map(candidate),
                    "judged": Organize.judgedTags(candidates, verdicts(c["verdicts"]), cfg)]
        }
    case "tagCandidates":
        guard let chat = thread(c["chat"]) else { return NSNull() }
        return Organize.tagCandidates(chat, int(c["index"]), threads(c["chats"]), vectors(c["vectors"]), cfg).map(candidate)
    case "refusedTags":
        return Organize.refusedTags(threads(c["chats"]), cfg).sorted()
    case "judgedTags":
        let candidates = (c["candidates"] as? [String] ?? []).map { Organize.TagCandidate(tag: $0, pos: 0, neg: 0, coherence: 0, examples: []) }
        return Organize.judgedTags(candidates, verdicts(c["verdicts"]), cfg)
    case "looksMixed":
        guard let chat = thread(c["chat"]) else { return NSNull() }
        return Organize.looksMixed(chat, cfg)
    case "missingVectors":
        let known = c["known"] as? [String: String] ?? [:]
        return Organize.missingVectors(threads(c["chats"]), has: { known[$0] == $1 }, limit: c["max"] is NSNumber ? int(c["max"]) : .max)
            .map { ["key": $0.key, "text": $0.text] }
    case "basics":
        let m = c["m"] as? [[String: Any]] ?? []
        return [
            "keys": m.map(Organize.entryKey),
            "times": Organize.entryTimes(m).map { $0.map { Organize.whole($0) } ?? NSNull() },
            "blocks": Organize.pageBlocks(m).map { ["start": $0.start, "end": $0.end, "url": $0.url ?? NSNull()] as [String: Any] },
            "pageChanges": Organize.withPageChanges(m).map { $0["pageChanged"] as? Bool == true }
        ]
    case "move", "undo":
        guard let source = thread(c["source"]),
              let moved = Organize.move(source: source, start: int(c["start"]), end: int(c["end"]), target: thread(c["target"]), targetId: c["targetId"] as? String ?? "", now: ms(c["now"])) else { return NSNull() }
        if c["op"] as? String == "move" { return ["source": out(moved.source), "target": out(moved.target)] }
        // Changed since the move: these copies instead of the move's.
        let current = (source: c["changedSource"] != nil ? thread(c["changedSource"]) : moved.source, target: c["changedTarget"] != nil ? thread(c["changedTarget"]) : moved.target)
        guard let back = Organize.undo(moved.undo, source: current.source, target: current.target, now: ms(c["later"])) else { return NSNull() }
        return ["source": out(back.source), "target": out(back.target)]
    case "sweep":
        let threads = (c["threads"] as? [Any] ?? []).compactMap(thread)
        let swept = Organize.sweep(threads, now: ms(c["now"]))
        return ["changed": swept.changed.sorted { $0.id < $1.id }.map(out), "emptied": swept.emptied.sorted()]
    default:
        return NSNull()
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []
let data = try! JSONSerialization.data(withJSONObject: cases.map(run), options: [.sortedKeys])
FileHandle.standardOutput.write(data)
