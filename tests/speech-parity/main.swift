import Foundation

// The app's side of tests/speech-parity.test.mts: reads cases (JSON) on stdin, writes what SpeechText.swift gives for
// each on stdout. Built together with ContextFlow/Shared (App)/SpeechText.swift.

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try? JSONSerialization.jsonObject(with: input)) as? [[String: Any]] ?? []

func run(_ c: [String: Any]) -> Any {
    let s = c["s"] as? String ?? ""
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
    default: return NSNull()
    }
}

let results = cases.map(run)
let data = try! JSONSerialization.data(withJSONObject: results, options: [.fragmentsAllowed])
FileHandle.standardOutput.write(data)
