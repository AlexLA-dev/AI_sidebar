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

func run(_ c: [String: Any]) -> Any {
    switch c["op"] as? String {
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
