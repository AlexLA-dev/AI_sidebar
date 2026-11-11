import Foundation

// tests/review-gate.test.mts: the cases come in on stdin as JSON, ReviewGate's answers go out on stdout.
struct Case: Decodable {
    let via: String
    let firstSession: Bool
    let goodAnswers: Int
    let lastAsk: Double?
    let sinceTaskLink: Double?
    let busy: Bool
    let now: Double
}

struct First: Decodable {
    let firstLaunch: Double?
    let now: Double
    let left: Bool
}

struct Input: Decodable {
    let cases: [Case]
    let first: [First]
}

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
let goes: [Bool] = input.cases.map { c in
    guard let via = ReviewGate.Via(rawValue: c.via) else { return false }
    return ReviewGate.goesNow(via, ReviewGate.State(firstSession: c.firstSession, goodAnswers: c.goodAnswers, lastAsk: c.lastAsk, sinceTaskLink: c.sinceTaskLink, busy: c.busy, now: c.now))
}
let first = input.first.map { ReviewGate.firstSession(firstLaunch: $0.firstLaunch, now: $0.now, left: $0.left) }
let out: [String: Any] = [
    "goes": goes,
    "first": first,
    "vias": ReviewGate.Via.allCases.map(\.rawValue),
    "milestones": ReviewGate.milestones.sorted()
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
