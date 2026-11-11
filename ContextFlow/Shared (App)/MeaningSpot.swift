import Foundation

// Search by meaning (2.6 (98), the owner on 98: a result that links to a chat should open it at the message the result
// refers to, highlighted like a pinned answer). The server names the chat and says why it fits, no message; the message
// is found here, on the device, by the words the description and that "why" share with it. The panel does the same
// (src/shared/meaningSpot.ts, checked against this by tests/meaning-spot-parity.test.mts): Foundation only, so the test
// builds this file alone.
nonisolated enum MeaningSpot {
    private enum Kind { case cjk, hangul, other }

    private static func kind(_ s: Unicode.Scalar) -> Kind {
        let c = s.value
        if (0x3040...0x30FF).contains(c) || (0x3400...0x4DBF).contains(c) || (0x4E00...0x9FFF).contains(c) || (0xF900...0xFAFF).contains(c) { return .cjk }
        if (0xAC00...0xD7AF).contains(c) || (0x1100...0x11FF).contains(c) || (0x3130...0x318F).contains(c) { return .hangul }
        return .other
    }

    /// Lower case, the accents off, "ß" as "ss": the panel's `unaccent` (src/shared/fold.ts), scalar for scalar.
    static func fold(_ text: String) -> String {
        let lower = text.lowercased().replacingOccurrences(of: "ß", with: "ss")
        var kept = String.UnicodeScalarView()
        for s in lower.decomposedStringWithCanonicalMapping.unicodeScalars {
            let v = s.value
            if (0x300...0x36F).contains(v) || (0x64B...0x65F).contains(v) || v == 0x670 { continue }
            kept.append(s)
        }
        return String(kept).precomposedStringWithCanonicalMapping
    }

    /// A letter, a mark or a digit (the panel's [\p{L}\p{M}\p{Nd}]).
    private static func inWord(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark, .decimalNumber: return true
        default: return false
        }
    }

    /// A text's words as stems: a word's first five letters, words of three or more; Korean, a word's first two
    /// syllables; Chinese and Japanese, every two characters in a row.
    static func stems(_ text: String) -> Set<String> {
        var out = Set<String>()
        var words: [[Unicode.Scalar]] = []
        var word: [Unicode.Scalar] = []
        for s in fold(text).unicodeScalars {
            if inWord(s) { word.append(s) } else if !word.isEmpty { words.append(word); word = [] }
        }
        if !word.isEmpty { words.append(word) }
        let joined = { (run: ArraySlice<Unicode.Scalar>) -> String in
            var view = String.UnicodeScalarView()
            view.append(contentsOf: run)
            return String(view)
        }
        for chars in words {
            var i = 0
            while i < chars.count {
                let k = kind(chars[i])
                var j = i
                while j < chars.count && kind(chars[j]) == k { j += 1 }
                let run = chars[i..<j]
                switch k {
                case .cjk:
                    var a = run.startIndex
                    while a + 1 < run.endIndex { out.insert(joined(run[a...(a + 1)])); a += 1 }
                case .hangul:
                    if run.count >= 2 { out.insert(joined(run.prefix(2))) }
                case .other:
                    if run.count >= 3 { out.insert(joined(run.prefix(5))) }
                }
                i = j
            }
        }
        return out
    }

    /// A word of three letters ("the", "and", "day"): it counts, but never picks a message alone.
    private static func short(_ stem: String) -> Bool {
        let scalars = Array(stem.unicodeScalars)
        return scalars.count == 3 && kind(scalars[0]) == .other
    }

    /// The message a meaning result refers to (its index among `texts`): the one sharing the most of the description's
    /// and the "why"'s words, a word counting more the fewer messages have it; at least one shared word, longer than
    /// three letters, in no more than half of them. None: nil (the chat opens at its end). A tie: the earlier message.
    static func index(texts: [String], query: String, why: String) -> Int? {
        let asked = stems("\(query)\n\(why)")
        guard !asked.isEmpty else { return nil }
        let shared = texts.map { stems($0).filter { asked.contains($0) } }
        var count: [String: Int] = [:]
        for list in shared { for s in list { count[s, default: 0] += 1 } }
        let n = texts.count
        var best: Int?
        var bestScore = 0
        for (i, list) in shared.enumerated() {
            var score = 0
            var rare = false
            for s in list {
                let d = count[s] ?? 0
                score += n - d + 1
                if d * 2 <= max(n, 2) && !short(s) { rare = true }
            }
            if rare && score > bestScore {
                best = i
                bestScore = score
            }
        }
        return best
    }
}
