import Foundation

// The app's side of tests/meaning-spot-parity.test.mts: reads cases (JSON) on stdin, writes what MeaningSpot.swift
// gives for each on stdout. Texts come as UTF-16 units (JSONSerialization would drop a leading U+FEFF).

func text(_ value: Any?) -> String {
    let units = (value as? [NSNumber] ?? []).map(\.uint16Value)
    return String(utf16CodeUnits: units, count: units.count)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []
let results: [Any] = cases.map { c in
    let texts = (c["texts"] as? [Any] ?? []).map(text)
    let stems = MeaningSpot.stems(text(c["query"])).sorted()
    let spot: Any = MeaningSpot.index(texts: texts, query: text(c["query"]), why: text(c["why"])) ?? NSNull()
    return ["stems": stems, "spot": spot]
}
let data = try! JSONSerialization.data(withJSONObject: results)
FileHandle.standardOutput.write(data)
