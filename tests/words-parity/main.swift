import Foundation

// The app's side of tests/words-parity.test.mts: reads texts (JSON, as UTF-16 units) on stdin, writes the words
// TopicWords.swift gives for each, sorted, on stdout.

let input = FileHandle.standardInput.readDataToEndOfFile()
let texts = (try? JSONSerialization.jsonObject(with: input)) as? [[NSNumber]] ?? []
let results: [[String]] = texts.map { units in
    let u = units.map(\.uint16Value)
    return TopicWords.of(String(utf16CodeUnits: u, count: u.count)).sorted()
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results))
