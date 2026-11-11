import Foundation

// The app's side of tests/speech-parity.test.mts: reads cases (JSON) on stdin, writes what SpeechText.swift gives for
// each on stdout. Built together with ContextFlow/Shared (App)/SpeechText.swift, under Swift 6 with the app's default
// isolation (the main actor).

/// VoicedList.ask works out a chat's ids and keys off the main thread as it opens: so does this, in a detached task.
/// Built as the app is, it doesn't compile if any of that work needs the main actor.
nonisolated final class Box<T>: @unchecked Sendable { var value: T? }
nonisolated func onMainThread() -> Bool { Thread.isMainThread }
func offMain<T: Sendable>(_ work: @escaping @Sendable () -> T) -> T {
    let box = Box<T>()
    let done = DispatchSemaphore(value: 0)
    Task.detached(priority: .utility) {
        precondition(!onMainThread(), "off the main thread")
        box.value = work()
        done.signal()
    }
    done.wait()
    return box.value!
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []

/// A text sent as its UTF-16 units (JSONSerialization would drop a leading U+FEFF from a string).
func text(_ value: Any?) -> String {
    let units = (value as? [NSNumber] ?? []).map(\.uint16Value)
    return String(utf16CodeUnits: units, count: units.count)
}

func run(_ c: [String: Any]) -> Any {
    let s = text(c["u"])
    switch c["op"] as? String ?? "" {
    case "text": return SpeechText.text(s)
    case "parts":
        let first = (c["first"] as? NSNumber)?.intValue ?? SpeechText.firstPartChars
        let size = (c["size"] as? NSNumber)?.intValue ?? SpeechText.partChars
        return SpeechText.parts(s, first: first, size: size)
    case "needsScript": return SpeechText.needsScript(s)
    case "chunks": return SpeechText.scriptChunks(s)
    case "lang": return SpeechText.language(s) ?? NSNull()
    case "split":
        // The text in pieces of `step` characters (UTF-16), as it streams; 0: whole.
        let step = (c["step"] as? NSNumber)?.intValue ?? 0
        let splitter = PartSplitter(first: (c["first"] as? Bool) ?? true)
        var out: [String] = []
        let ns = s as NSString
        if step <= 0 {
            out += splitter.push(s)
        } else {
            var at = 0
            while at < ns.length {
                var end = min(ns.length, at + step)
                // Not inside a surrogate pair (a stream decodes whole characters).
                if end < ns.length, (0xD800...0xDBFF).contains(ns.character(at: end - 1)) { end += 1 }
                out += splitter.push(ns.substring(with: NSRange(location: at, length: end - at)))
                at = end
            }
        }
        return out + splitter.end()
    case "answer":
        // Listen under an answer in the app's chats: what it sends, as the panel does.
        let text = (s as NSString).length > SpeechText.maxChars ? (s as NSString).substring(to: SpeechText.maxChars) : s
        return ["parts": Array(SpeechText.parts(SpeechText.text(text)).prefix(80)), "lang": SpeechText.language(s) ?? NSNull(), "script": SpeechText.needsScript(text)] as [String: Any]
    case "voicedId": return VoicedQuery.id(what: c["what"] as? String ?? "answer", text: s)
    case "answers":
        let list = (c["lu"] as? [Any] ?? []).map(text)
        return offMain { VoicedQuery.answers(list).map { [$0.id, $0.text] } }
    case "keys":
        // An answer's parts' keys, the texts written for the ear kept on this device as given ("script|answer|<key>").
        let kept = c["kept"] as? [String: String] ?? [:]
        return offMain { VoicedQuery.keys(answer: s, uiLanguage: "en", kept: { kept[$0].map { Data($0.utf8) } }) }
    default: return NSNull()
    }
}

let results = cases.map(run)
let data = try! JSONSerialization.data(withJSONObject: results, options: [.fragmentsAllowed])
FileHandle.standardOutput.write(data)
