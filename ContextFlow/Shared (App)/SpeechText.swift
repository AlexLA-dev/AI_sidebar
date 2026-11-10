import Foundation

/// Read aloud's text as the panel makes it (build 95): src/shared/speech.ts (speechText, speechParts, needsScript,
/// scriptChunks, PartSplitter) and src/shared/share.ts (textLanguage), line for line. The same answer then gives the
/// same parts, language and text written for the ear here and in Safari, so their keys match: the audio kept on this
/// device or in iCloud plays again, and the week's minutes count each part once (heard in the panel, then in the app's
/// chats, or the other way round, it's the same part). tests/speech-parity.test.mts checks both give the same.
///
/// JavaScript's regular expressions differ from ICU's in a few ways that matter here, so the patterns spell them out:
/// `\s` and `trim()` are JavaScript's set, `\d` is ASCII digits, `\b` is an ASCII word boundary, `.` stops at JavaScript's
/// line ends, and `$` without the m flag is the very end. Lengths are UTF-16 units, as in JavaScript.
nonisolated enum SpeechText {
    static let firstPartChars = 240
    static let partChars = 500
    static let maxChars = 24_000

    // MARK: JavaScript's regular expressions on ICU

    /// JavaScript's whitespace (`\s`, and what `trim()` takes off).
    private static let ws = #"\t\n\u000B\f\r    -     　﻿"#
    private static let wsSet: CharacterSet = {
        var set = CharacterSet(charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        set.insert(charactersIn: "\u{2000}"..."\u{200A}")
        return set
    }()

    /// A pattern written as in JavaScript: `\s` / `\S` become JavaScript's sets, `.` stops where JavaScript's does.
    private static func js(_ pattern: String) -> String {
        pattern
            .replacingOccurrences(of: #"\S"#, with: "[^\(ws)]")
            .replacingOccurrences(of: #"\s"#, with: "[\(ws)]")
            .replacingOccurrences(of: "(DOT)", with: #"[^\n\r  ]"#)
    }

    nonisolated(unsafe) private static var cache: [String: NSRegularExpression] = [:]
    private static let lock = NSLock()

    private static func re(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        let key = "\(options.rawValue)|\(pattern)"
        lock.lock()
        defer { lock.unlock() }
        if let known = cache[key] { return known }
        let made = try! NSRegularExpression(pattern: js(pattern), options: options)
        cache[key] = made
        return made
    }

    private static func all(_ text: String) -> NSRange { NSRange(location: 0, length: (text as NSString).length) }

    /// String.replace with the g flag.
    private static func replace(_ text: String, _ pattern: String, _ template: String, _ options: NSRegularExpression.Options = []) -> String {
        re(pattern, options).stringByReplacingMatches(in: text, range: all(text), withTemplate: template)
    }

    /// String.replace without the g flag: the first match only.
    private static func replaceFirst(_ text: String, _ pattern: String, _ template: String) -> String {
        let regex = re(pattern)
        guard let match = regex.firstMatch(in: text, range: all(text)) else { return text }
        let ns = text as NSString
        return ns.replacingCharacters(in: match.range, with: regex.replacementString(for: match, in: text, offset: 0, template: template))
    }

    private static func test(_ text: String, _ pattern: String, _ options: NSRegularExpression.Options = []) -> Bool {
        re(pattern, options).firstMatch(in: text, range: all(text)) != nil
    }

    private static func count(_ text: String, _ pattern: String, _ options: NSRegularExpression.Options = []) -> Int {
        re(pattern, options).numberOfMatches(in: text, range: all(text))
    }

    static func trim(_ text: String) -> String { text.trimmingCharacters(in: wsSet) }
    private static func length(_ text: String) -> Int { (text as NSString).length }

    // MARK: speechText

    private static let tableRule = #"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\z"#

    private static func isTableRow(_ line: String) -> Bool {
        test(line, tableRule) || (line.contains("|") && test(line, #"^\|(DOT)*\|\z"#))
    }

    private static func cells(_ row: String) -> [String] {
        replace(row, #"^\||\|\z"#, "").components(separatedBy: "|").map { trim(replace($0, #"(\*\*|__)((DOT)+?)\1"#, "$2")) }
    }

    /// One table row for the ear: "MARKUS: Price 299 dollars, Color dark gray."
    private static func tableRow(_ row: [String], _ header: [String]?) -> String {
        let head = row.first ?? ""
        let rest = Array(row.dropFirst())
        var line: String
        if let header, !rest.isEmpty {
            let said = rest.enumerated().map { k, v -> String in
                guard !v.isEmpty else { return "" }
                let name = k + 1 < header.count ? header[k + 1] : ""
                return "\(name.isEmpty ? "" : "\(name) ")\(v)"
            }.filter { !$0.isEmpty }
            line = head.isEmpty ? said.joined(separator: ", ") : "\(head): \(said.joined(separator: ", "))"
        } else {
            line = row.filter { !$0.isEmpty }.joined(separator: ", ")
        }
        return test(line, #"[.!?…:;。！？]\z"#) ? line : "\(line)."
    }

    /// Markdown (an answer) → plain text a voice can read (speechText).
    static func text(_ markdown: String) -> String {
        var text = replace(markdown, #"\r\n?"#, "\n")
        text = replace(text, #"```(?s:.)*?(```|\z)"#, "\n")
        text = replace(text, #"</?mark>"#, "")
        text = replace(text, #"<[^>\n]{1,40}>"#, "")
        text = replace(text, #"!\[([^\]]*)\]\([^)]*\)"#, "$1")
        text = replace(text, #"\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)"#, "$1")
        text = replace(text, #"\[[0-9]+(?:\s*[,–-]\s*[0-9]+)*\]"#, "")
        text = replace(text, #"https?://\S+"#, "")
        text = replace(text, #"`([^`\n]+)`"#, "$1")
        var lines: [String] = []
        let rawLines = text.components(separatedBy: "\n")
        var i = 0
        while i < rawLines.count {
            var line = trim(rawLines[i])
            if line.isEmpty {
                lines.append("")
                i += 1
                continue
            }
            if isTableRow(line) {
                var block: [[String]] = []
                var header: [String]?
                while i < rawLines.count, isTableRow(trim(rawLines[i])) {
                    let row = trim(rawLines[i])
                    if test(row, tableRule) {
                        if block.count == 1, header == nil { header = block.removeLast() }
                    } else {
                        block.append(cells(row))
                    }
                    i += 1
                }
                for row in block { lines.append(tableRow(row, header)) }
                continue
            }
            line = replaceFirst(line, #"^#{1,6}\s+"#, "")
            line = replaceFirst(line, #"^>\s?"#, "")
            line = replaceFirst(line, #"^(?:[-*+•]|[0-9]{1,3}[.)])\s+"#, "")
            line = replaceFirst(line, #"^[-*_]{3,}\z"#, "")
            line = replace(line, #"(\*\*|__)((DOT)+?)\1"#, "$2")
            line = replace(line, #"(^|[^\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?=\z|[^\p{L}\p{N}*_])"#, "$1$2")
            line = replace(line, #"~~((DOT)+?)~~"#, "$1")
            line = trim(line)
            i += 1
            if line.isEmpty { continue }
            if !test(line, #"[.!?…:;。！？؟।]\z"#) { line += "." }
            lines.append(line)
        }
        text = replace(lines.joined(separator: "\n"), #"\n{3,}"#, "\n\n")
        text = trim(replace(text, #"[ \t]{2,}"#, " "))
        let ns = text as NSString
        return ns.length > maxChars ? ns.substring(to: maxChars) : text
    }

    // MARK: speechParts

    private static let sentenceEnd = #"[.!?…。！？؟।]["'»”)\]]*\s+|\n+"#

    /// Cuts the text into parts at sentence ends: a short first one, then up to `size` each (speechParts).
    static func parts(_ text: String, first: Int = firstPartChars, size: Int = partChars) -> [String] {
        let ns = text as NSString
        var sentences: [String] = []
        var last = 0
        for match in re(sentenceEnd).matches(in: text, range: all(text)) {
            let end = match.range.location + match.range.length
            sentences.append(ns.substring(with: NSRange(location: last, length: end - last)))
            last = end
        }
        if last < ns.length { sentences.append(ns.substring(from: last)) }

        var parts: [String] = []
        var current = ""
        func push() {
            let part = trim(current)
            if !part.isEmpty { parts.append(part) }
            current = ""
        }
        for sentence in sentences.flatMap({ splitLong($0, size) }) {
            let limit = parts.isEmpty ? first : size
            if !current.isEmpty, length(current) + length(sentence) > limit { push() }
            current += sentence
            // The first part ends after its first sentence once that's long enough to say something.
            if parts.isEmpty, Double(length(current)) >= Double(first) * 0.5 { push() }
        }
        push()
        return parts
    }

    /// A "sentence" longer than a part (no stops): cut at spaces.
    private static func splitLong(_ sentence: String, _ size: Int) -> [String] {
        var rest = sentence as NSString
        if rest.length <= size { return [sentence] }
        var out: [String] = []
        while rest.length > size {
            // lastIndexOf(" ", size): the last space at or before `size`.
            let found = rest.range(of: " ", options: [.backwards, .literal], range: NSRange(location: 0, length: min(size + 1, rest.length)))
            var cut = found.location == NSNotFound ? -1 : found.location
            if Double(cut) < Double(size) / 2 { cut = size }
            out.append(rest.substring(to: cut + 1))
            rest = rest.substring(from: cut + 1) as NSString
        }
        if rest.length > 0 { out.append(rest as String) }
        return out
    }

    // MARK: needsScript, scriptChunks

    /// Whether an answer is written for the ear before the voice reads it (needsScript).
    static func needsScript(_ markdown: String) -> Bool {
        let text = markdown
        if test(text, #"^\s*\|(DOT)*\|\s*$"#, .anchorsMatchLines) && test(text, #"^\s*\|?\s*:?-{2,}"#, .anchorsMatchLines) { return true }
        if text.contains("```") { return true }
        let items = count(text, #"^\s*(?:[-*+•]|[0-9]{1,3}[.)])\s+"#, .anchorsMatchLines)
        if items >= 4 || test(text, #"^\s{2,}(?:[-*+•]|[0-9]{1,3}[.)])\s+"#, .anchorsMatchLines) { return true }
        if count(text, #"^#{1,6}\s"#, .anchorsMatchLines) >= 2 { return true }
        if count(text, #"https?://|\]\("#) >= 2 { return true }
        if count(text, #"[→←↔×÷±≈≤≥≠∑√∞°%‰€$£¥₽]|(?<![A-Za-z0-9_])[0-9]+\s*[–-]\s*[0-9]+(?![A-Za-z0-9_])|`[^`]+`"#) >= 6 { return true }
        return false
    }

    /// A long text for /api/v2/speak-script in pieces of at most `size` characters, cut between paragraphs (scriptChunks).
    static func scriptChunks(_ text: String, size: Int = 5000) -> [String] {
        var out: [String] = []
        var current = ""
        // text.split(/\n{2,}/)
        let ns = text as NSString
        var paragraphs: [String] = []
        var last = 0
        for match in re(#"\n{2,}"#).matches(in: text, range: all(text)) {
            paragraphs.append(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            last = match.range.location + match.range.length
        }
        paragraphs.append(ns.substring(from: last))
        for paragraph in paragraphs {
            let pieces = length(paragraph) > size ? parts(paragraph, first: size, size: size) : [paragraph]
            for piece in pieces {
                if !current.isEmpty, length(current) + length(piece) + 2 > size {
                    out.append(trim(current))
                    current = ""
                }
                current += (current.isEmpty ? "" : "\n\n") + piece
            }
        }
        if !trim(current).isEmpty { out.append(trim(current)) }
        return out.filter { !$0.isEmpty }
    }

    // MARK: textLanguage

    private static let latin: [(String, Set<String>, String?)] = [
        ("en", words("the is are what how why who which this that these with about does do can you your of and to in it for"), nil),
        ("de", words("der die das ist sind und was wie warum wer nicht ein eine einen ich du mit für auf über worum geht es den dem des"), "[ßäöü]"),
        ("es", words("el los las es son qué que cómo por y en un una del se está para con sobre trata eso esto"), "[ñ¿¡]"),
        ("fr", words("le les est sont et que quoi comment pourquoi un une des du ce cet cette il elle pour dans avec sur qui parle"), "[œêâîôûëïç]"),
        ("it", words("il lo gli è sono che cosa come perché di e un una del della per con su questo questa parla"), nil),
        ("pt_BR", words("o os é são que como por e um uma do da não para com sobre isso este esta fala"), "[ãõ]"),
        ("vi", words("là của và có không gì này những một các cho được trong về như thế nào sao bài trang tôi bạn với để khi đây đó nói"), #"[ăđơưẠ-ỹ]"#)
    ]
    private static func words(_ list: String) -> Set<String> { Set(list.components(separatedBy: " ")) }
    private static let traditional = "這個們說麼時為會來嗎頁點與對關還讓價樣從種寫問題單開東車書長經現發學國總結網體請應該變處過實動頭義區記錄認識讀聽買賣錢氣電話視備帶獲據歡"
    private static let simplified = "这个们说么时为会来吗页点与对关还让价样从种写问题单开东车书长经现发学国总结网体请应该变处过实动头义区记录认识读听买卖钱气电话视备带获据欢"

    /// The language of a text, when it's clear: a locale code ("ru", "pt_BR"…) (textLanguage).
    static func language(_ given: String) -> String? {
        let text = replace(given, #"(https?://|www\.)\S+"#, " ", .caseInsensitive)
        let chinese = count(text, "[\(traditional)]") > count(text, "[\(simplified)]") ? "zh_TW" : "zh_CN"
        let ukrainian = test(text, #"[іїєґ]|(^|[^а-яё])(що|це|ця|цей|чому|який|яка|яке)(?![а-яё])"#, .caseInsensitive)
        let scripts: [(String?, Int)] = [
            ("ko", count(text, #"[가-힯]"#)),
            (count(text, #"[぀-ヿ]"#) > 0 ? "ja" : chinese, count(text, #"[぀-ヿ一-鿿]"#)),
            ("ar", count(text, #"[؀-ۿݐ-ݿ]"#)),
            (ukrainian ? "uk" : "ru", count(text, "[а-яёіїєґ]", .caseInsensitive)),
            (nil, count(text, #"[a-zà-ÿœăđĩũơưẠ-ỹ]"#, .caseInsensitive))
        ]
        var best = scripts[0]
        for script in scripts.dropFirst() where script.1 > best.1 { best = script }
        if best.1 < 3 { return nil }
        if let script = best.0 { return script }

        let lower = text.lowercased()
        let found = re(#"[a-zà-ÿœăđĩũơưẠ-ỹ]+"#).matches(in: lower, range: all(lower)).map { (lower as NSString).substring(with: $0.range) }
        var scores = latin.enumerated().map { index, entry in
            (index, entry.0, found.filter { entry.1.contains($0) }.count + ((entry.2.map { test(lower, $0) } ?? false) ? 2 : 0))
        }
        // A stable sort, as JavaScript's: a tie keeps the list's order.
        scores.sort { $0.2 != $1.2 ? $0.2 > $1.2 : $0.0 < $1.0 }
        return scores[0].2 >= 2 && scores[0].2 > scores[1].2 ? scores[0].1 : nil
    }

    /// The panel's own language when a text's isn't clear (its strings' langCode: "en", "pt-BR", "zh-Hans"…): the one of
    /// the 14 the device's languages pick, as Safari picks the extension's.
    static var uiLanguage: String {
        let picked = Bundle.main.preferredLocalizations.first ?? "en"
        if picked.hasPrefix("zh") { return picked.contains("Hant") || picked.hasSuffix("TW") || picked.hasSuffix("HK") ? "zh-Hant" : "zh-Hans" }
        if picked.hasPrefix("pt") { return "pt-BR" }
        let code = String(picked.prefix { $0 != "-" && $0 != "_" })
        return ["en", "ru", "uk", "de", "es", "fr", "it", "ja", "ko", "vi", "ar"].contains(code) ? code : "en"
    }
}

/// Text written for the ear as it streams in, cut into parts as soon as each is complete (src/shared/speech.ts
/// PartSplitter). Build 95: the first part ends at its first sentence end that says something (at least `min`
/// characters), however the text came: streamed the first time, whole from this device or iCloud the next. Before, a
/// text that came whole was cut differently, so a replay was new parts: made and counted again.
nonisolated final class PartSplitter {
    private var buffer = ""
    private var first: Bool
    private let min: Int
    private static let sentenceEnd = try! NSRegularExpression(pattern: #"[.!?…。！？؟।]["'»”)\]]*[\t\n\u000B\f\r    -     　﻿]+|\n+"#)

    init(first: Bool = true, min: Int = 40) {
        self.first = first
        self.min = min
    }

    func push(_ text: String) -> [String] {
        buffer += text
        var out: [String] = []
        while true {
            let limit = first ? SpeechText.firstPartChars : SpeechText.partChars
            let ns = buffer as NSString
            var cut = -1
            var firstEnd = -1
            var early = -1
            for match in Self.sentenceEnd.matches(in: buffer, range: NSRange(location: 0, length: ns.length)) {
                let end = match.range.location + match.range.length
                if firstEnd < 0 { firstEnd = end }
                if first, early < 0, end >= min, end <= limit { early = end }
                if end <= limit { cut = end } else { break }
            }
            if first, early >= 0 { cut = early }
            if cut < 0, firstEnd >= 0, ns.length > limit { cut = firstEnd }
            guard cut >= 0, ns.length >= limit || (first && cut >= min) else { break }
            let part = SpeechText.trim(ns.substring(to: cut))
            buffer = ns.substring(from: cut)
            if !part.isEmpty {
                out.append(part)
                first = false
            }
        }
        return out
    }

    func end() -> [String] {
        let rest = SpeechText.parts(SpeechText.trim(buffer), first: first ? SpeechText.firstPartChars : SpeechText.partChars)
        buffer = ""
        if !rest.isEmpty { first = false }
        return rest
    }
}
