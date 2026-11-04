import Combine
import SwiftUI
#if os(iOS)
import UIKit
typealias PlatformFont = UIFont
typealias PlatformColor = UIColor
private let textColor = UIColor.label
#else
import AppKit
typealias PlatformFont = NSFont
typealias PlatformColor = NSColor
private let textColor = NSColor.labelColor
#endif

// Chat UX (2.5) in the app, as in the Safari panel (src/content/ux, src/shared/marks.ts):
// - highlights in answers: select text, "Highlight"; sent to the model as <mark>, copied and shared in bold;
// - pinned answers and notes: one bar at the top of the chat, as in Telegram;
// - reminders on an answer or a note: a local notification on this device (MessageReminders);
// - swipe a message left to delete it (with Undo), right to pin it.

// MARK: - The data on a message

/// One highlight: `s`…`e` in the answer's shown text (its Markdown without the syntax), and that text.
struct ChatMark: Codable, Hashable {
    var s: Int
    var e: Int
    var q: String
}

/// A reminder on a message (ms); `dev`: the device that rings.
struct ChatRemind: Codable, Hashable {
    var at: Double
    var dev: String?
}

enum ChatMarks {
    /// Adds a highlight; overlapping or touching ones merge (`text`: the answer's shown text).
    static func add(_ marks: [ChatMark], s: Int, e: Int, text: [Character]) -> [ChatMark] {
        guard e > s, e <= text.count else { return marks }
        var start = s, end = e
        var kept: [ChatMark] = []
        for m in marks {
            if m.e >= start && m.s <= end { start = min(start, m.s); end = max(end, m.e) } else { kept.append(m) }
        }
        kept.append(ChatMark(s: start, e: end, q: String(text[start..<end])))
        return Array(kept.sorted { $0.s < $1.s }.prefix(40))
    }

    /// The highlights as they fit `text`: kept where it still matches, else found by their text (nearest).
    static func place(_ marks: [ChatMark], in text: [Character]) -> [ChatMark] {
        var out: [ChatMark] = []
        for m in marks where !m.q.isEmpty {
            let q = Array(m.q)
            if m.s >= 0, m.e <= text.count, m.s < m.e, Array(text[m.s..<m.e]) == q { out.append(m); continue }
            var best: Int?
            if q.count <= text.count {
                for at in 0...(text.count - q.count) where text[at] == q[0] && Array(text[at..<at + q.count]) == q {
                    if best == nil || abs(at - m.s) < abs(best! - m.s) { best = at }
                }
            }
            if let best { out.append(ChatMark(s: best, e: best + q.count, q: m.q)) }
        }
        return out.sorted { $0.s < $1.s }
    }

    /// The answer's Markdown with the highlights wrapped in <mark>…</mark> (src/shared/marks.ts markedContent).
    static func markedContent(_ content: String, _ marks: [ChatMark]) -> String {
        guard !marks.isEmpty else { return content }
        let gap = #"(?:\s|[*_~`|>#]|\[|\]\([^)\s]*\)|(?<=\n\s{0,8})(?:[-+•]|\d+[.)])(?=\s))*?"#
        let ns = content as NSString
        var spots: [NSRange] = []
        for m in marks.sorted(by: { $0.s < $1.s }) {
            let chars = m.q.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            guard !chars.isEmpty else { continue }
            let pattern = chars.map { $0 == " " ? #"\s+"# : NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: gap)
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            var best: NSRange?
            for hit in regex.matches(in: content, range: NSRange(location: 0, length: ns.length)) {
                if spots.contains(where: { NSIntersectionRange($0, hit.range).length > 0 }) { continue }
                if best == nil || abs(hit.range.location - m.s) < abs(best!.location - m.s) { best = hit.range }
            }
            if let best { spots.append(best) }
        }
        var out = content
        for spot in spots.sorted(by: { $0.location > $1.location }) {
            guard let range = Range(spot, in: out) else { continue }
            out.replaceSubrange(range, with: "<mark>\(out[range])</mark>")
        }
        return out
    }

    /// The highlights for a chat digest ("Ask your chats"): «…» · «…».
    static func line(_ marks: [ChatMark], max: Int = 300) -> String {
        let line = marks.map { "«\($0.q.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces))»" }.joined(separator: " · ")
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }
}

// MARK: - Reminders: the presets and what the notification says

enum ReminderTimes {
    enum Preset: String, CaseIterable { case hour, evening, morning, week }

    /// In an hour, this evening at 18:00 (before 17:00), tomorrow at 9, in a week at 9.
    static func presets(now: Date = Date()) -> [(preset: Preset, at: Date)] {
        let cal = Calendar.current
        func at(_ days: Int, _ hour: Int) -> Date {
            let day = cal.date(byAdding: .day, value: days, to: now) ?? now
            return cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        }
        var out: [(Preset, Date)] = [(.hour, now.addingTimeInterval(3600))]
        if cal.component(.hour, from: now) < 17 { out.append((.evening, at(0, 18))) }
        out.append((.morning, at(1, 9)))
        out.append((.week, at(7, 9)))
        return out
    }

    static func title(_ preset: Preset) -> LocalizedStringKey {
        switch preset {
        case .hour: return "In an hour"
        case .evening: return "This evening"
        case .morning: return "Tomorrow morning"
        case .week: return "In a week"
        }
    }

    /// "Today 18:00", "Tomorrow 9:00", "Fri 9:00", "12 Nov 9:00".
    static func label(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: date)).day ?? 0
        if days == 0 { return String(localized: "Today \(time)") }
        if days == 1 { return String(localized: "Tomorrow \(time)") }
        if days > 1 && days < 7 { return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }

    /// A message's text for the notification: plain words, no Markdown, tables or list signs (src/shared/reminders.ts).
    static func text(_ content: String, max: Int = 160) -> String {
        var t = content.replacingOccurrences(of: #"[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
        let rules: [(String, String)] = [
            (#"```[a-z]*\n?"#, ""),
            (#"(?m)^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$"#, ""),
            (#"\|"#, " "),
            (#"(?m)^#{1,6}\s+"#, ""),
            (#"(?m)^\s*(?:[-*+•]|\d+[.)])\s+"#, ""),
            (#"(?m)^\s*>\s?"#, ""),
            (#"\*\*|__|`"#, ""),
            (#"\[([^\]]+)\]\((https?:[^)]+)\)"#, "$1"),
            (#"\s+"#, " ")
        ]
        for (pattern, template) in rules { t = t.replacingOccurrences(of: pattern, with: template, options: .regularExpression) }
        t = t.trimmingCharacters(in: .whitespaces)
        return t.count > max ? String(t.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : t
    }
}

// MARK: - The library: changing messages (through organizing's editEntries, which keeps every other field)

extension ChatLibrary {
    private func key(_ entries: [[String: Any]], _ index: Int) -> String? {
        entries.indices.contains(index) ? Organize.entryKey(entries[index]) : nil
    }

    func setMarks(_ thread: ChatThread, entry index: Int, _ marks: [ChatMark]) {
        editEntries(thread) { entries in
            guard entries.indices.contains(index) else { return }
            if marks.isEmpty { entries[index].removeValue(forKey: "marks") }
            else { entries[index]["marks"] = marks.map { ["s": $0.s, "e": $0.e, "q": $0.q] } }
        }
    }

    func setEntryPinned(_ thread: ChatThread, entry index: Int, _ on: Bool) {
        editEntries(thread) { entries in
            guard entries.indices.contains(index) else { return }
            if on { entries[index]["pinned"] = Date().timeIntervalSince1970 * 1000 } else { entries[index].removeValue(forKey: "pinned") }
        }
    }

    func unpinAll(_ thread: ChatThread) {
        editEntries(thread) { entries in
            for i in entries.indices { entries[i].removeValue(forKey: "pinned") }
        }
    }

    func setRemind(_ thread: ChatThread, entry index: Int, _ remind: ChatRemind?) {
        editEntries(thread) { entries in
            guard entries.indices.contains(index) else { return }
            if let remind {
                var object: [String: Any] = ["at": remind.at]
                if let dev = remind.dev { object["dev"] = dev }
                entries[index]["remind"] = object
            } else {
                entries[index].removeValue(forKey: "remind")
            }
        }
    }

    /// Removes messages (an answer with its question, or a note) and returns them for Undo, with their keys.
    func deleteEntries(_ thread: ChatThread, _ range: ClosedRange<Int>) -> (at: Int, entries: [[String: Any]])? {
        var gone: [[String: Any]] = []
        editEntries(thread) { entries in
            guard entries.indices.contains(range.lowerBound), entries.indices.contains(range.upperBound) else { return }
            gone = Array(entries[range])
            entries.removeSubrange(range)
        }
        return gone.isEmpty ? nil : (range.lowerBound, gone)
    }

    /// Undo: the messages back where they were (those not there again already, by key).
    func restoreEntries(_ thread: ChatThread, at: Int, _ back: [[String: Any]]) {
        editEntries(thread) { entries in
            let keys = Set(entries.map(Organize.entryKey))
            let missing = back.filter { !keys.contains(Organize.entryKey($0)) }
            entries.insert(contentsOf: missing, at: min(at, entries.count))
        }
    }

    /// Where a message is (a reminder's link): by its key in every chat, as messages can move. Two copies (a move
    /// the sweep hasn't tidied yet): the moved one, the latest move first.
    func find(messageKey: String, hint chatId: String?) -> (thread: ChatThread, index: Int)? {
        var found: [(thread: ChatThread, index: Int, from: Double?)] = []
        for thread in threads {
            guard let entries = thread.organized?.entries else { continue }
            for (i, e) in entries.enumerated() where Organize.entryKey(e) == messageKey {
                found.append((thread, i, ((e["from"] as? [String: Any])?["at"] as? NSNumber)?.doubleValue))
            }
        }
        let best = found.max { a, b in
            if (a.from != nil) != (b.from != nil) { return a.from == nil }
            if let fa = a.from, let fb = b.from, fa != fb { return fa < fb }
            return a.thread.id != chatId && b.thread.id == chatId
        }
        return best.map { ($0.thread, $0.index) }
    }
}

/// A reminder's link opens the chat at the message (contextflow://chat?id=…&m=…): ChatsView goes there.
@MainActor
final class ChatLinks: ObservableObject {
    static let shared = ChatLinks()
    @Published var pending: (chat: String?, message: String)?

    func handle(_ url: URL) {
        guard url.host == "chat", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let items = parts.queryItems ?? []
        guard let m = items.first(where: { $0.name == "m" })?.value else { return }
        pending = (items.first { $0.name == "id" }?.value, m)
    }
}

extension ChatAI {
    /// A chat UX count (kind ux_mark / ux_pin / ux_delete / ux_remind): what and how, never text.
    @MainActor
    static func reportUx(_ kind: String, _ fields: [String: String]) {
        reportOrganize(kind, fields)
    }
}

// MARK: - An answer with selectable text and highlights

/// The blocks of an answer, as MarkdownView splits them.
enum AnswerBlocks {
    enum Block: Hashable {
        case heading(String, Int)
        case paragraph(String)
        case bullet(String, String)
        case table([[String]])
        case code(String)
    }

    static func parse(_ text: String) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var table: [[String]] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
            if !table.isEmpty { out.append(.table(table)) }
            table = []
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let lines = code { out.append(.code(lines.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty {
                flush()
            } else if line.hasPrefix("|") {
                if !paragraph.isEmpty { flush() }
                let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                if !cells.allSatisfy({ $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil }) { table.append(cells) }
            } else if let match = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                flush()
                out.append(.heading(String(line[match.upperBound...]), line.prefix(while: { $0 == "#" }).count))
            } else if let match = line.range(of: #"^([-*+]|\d{1,3}[.)])\s+"#, options: .regularExpression) {
                flush()
                let mark = line[match].trimmingCharacters(in: .whitespaces)
                out.append(.bullet(mark.first.map { "-*+".contains($0) } == true ? "•" : mark, String(line[match.upperBound...])))
            } else {
                if !table.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return out
    }

    /// Inline Markdown as attributed text: bold, italic, code and links, in `font`.
    static func inline(_ markdown: String, font: PlatformFont) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard let parsed = try? AttributedString(markdown: markdown, options: options) else {
            return NSMutableAttributedString(string: markdown, attributes: [.font: font, .foregroundColor: textColor, .paragraphStyle: lines])
        }
        for run in parsed.runs {
            let text = String(parsed[run.range].characters)
            var runFont = font
            let intent = run.inlinePresentationIntent ?? []
            #if os(iOS)
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty, let d = font.fontDescriptor.withSymbolicTraits(traits) { runFont = UIFont(descriptor: d, size: font.pointSize) }
            if intent.contains(.code) { runFont = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular) }
            #else
            var traits: NSFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
            if intent.contains(.emphasized) { traits.insert(.italic) }
            if !traits.isEmpty { runFont = NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(traits), size: font.pointSize) ?? font }
            if intent.contains(.code) { runFont = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular) }
            #endif
            var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: textColor, .paragraphStyle: lines]
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: text, attributes: attributes))
        }
        return out
    }

    /// Lines broken as SwiftUI's Text breaks them: no single word left alone on the last line.
    private static let lines: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.lineBreakStrategy = .standard
        return style
    }()

    /// `style` at an exact weight, as SwiftUI's `.title3.weight(.bold)` (a bold trait on a title style is semibold).
    static func font(_ style: PlatformFont.TextStyle, weight: PlatformFont.Weight) -> PlatformFont {
        PlatformFont.systemFont(ofSize: PlatformFont.preferredFont(forTextStyle: style).pointSize, weight: weight)
    }

    static func font(_ style: PlatformFont.TextStyle, bold: Bool = false) -> PlatformFont {
        let base = PlatformFont.preferredFont(forTextStyle: style)
        guard bold else { return base }
        #if os(iOS)
        return base.fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: base.pointSize) } ?? base
        #else
        return NSFont(descriptor: base.fontDescriptor.withSymbolicTraits(.bold), size: base.pointSize) ?? base
        #endif
    }
}

/// The soft marker of a highlight (the panel's --mark).
let markColor = PlatformColor(red: 250 / 255, green: 204 / 255, blue: 21 / 255, alpha: 0.38)

/// An answer: its text selectable with "Highlight" in the menu (and "Remove highlight" on one), code and tables
/// as in MarkdownView. Offsets count the shown text as the panel does (blocks one after another, a paragraph's
/// lines without breaks), so a highlight made on one device lands in the same place on the others.
struct AnswerText: View {
    let text: String
    let marks: [ChatMark]
    var onChange: ([ChatMark]) -> Void
    var onSelecting: (Bool) -> Void = { _ in }
    @Environment(\.displayScale) private var displayScale

    private struct Laid {
        let block: AnswerBlocks.Block
        let attributed: NSMutableAttributedString?
        // Where its shown text starts in the answer's, and the display offsets that are line breaks (not shown).
        let start: Int
        let breaks: [Int]
        let shownCount: Int
    }

    private var laid: (items: [Laid], shown: [Character]) {
        var items: [Laid] = []
        var shown: [Character] = []
        for block in AnswerBlocks.parse(text) {
            var attributed: NSMutableAttributedString?
            var plain: String
            switch block {
            case .heading(let t, let level):
                attributed = AnswerBlocks.inline(t, font: level <= 2 ? AnswerBlocks.font(.title3, weight: .bold) : AnswerBlocks.font(.headline, bold: true))
                plain = attributed!.string
            case .paragraph(let t):
                attributed = AnswerBlocks.inline(t, font: AnswerBlocks.font(.body))
                plain = attributed!.string
            case .bullet(_, let t):
                attributed = AnswerBlocks.inline(t, font: AnswerBlocks.font(.body))
                plain = attributed!.string
            case .table(let rows):
                plain = rows.flatMap { $0 }.map { AnswerBlocks.inline($0, font: AnswerBlocks.font(.footnote)).string }.joined()
            case .code(let code):
                plain = code
            }
            let chars = Array(plain)
            let breaks = chars.indices.filter { chars[$0] == "\n" }
            let visible = chars.filter { $0 != "\n" || attributed == nil }
            items.append(Laid(block: block, attributed: attributed, start: shown.count, breaks: attributed == nil ? [] : breaks, shownCount: attributed == nil ? chars.count : visible.count))
            shown += attributed == nil ? chars : visible
        }
        return (items, shown)
    }

    var body: some View {
        let (items, shown) = laid
        let placed = ChatMarks.place(marks, in: shown)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                switch item.block {
                case .bullet(let mark, _):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(mark).foregroundColor(.secondary)
                        selectable(item, placed, shown)
                    }
                    .padding(.leading, 4)
                case .table(let rows):
                    AnswerTable(rows: rows)
                case .code(let code):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.1)))
                default:
                    selectable(item, placed, shown)
                }
            }
        }
    }

    /// Display offset (UTF-16 in the block) → shown offset (characters, without the paragraph's line breaks).
    private func shownOffset(_ item: Laid, _ display: Int) -> Int {
        let string = item.attributed?.string ?? ""
        let utf16 = string.utf16
        let index = utf16.index(utf16.startIndex, offsetBy: min(display, utf16.count))
        let chars = string[..<index].count
        return item.start + chars - item.breaks.filter { $0 < chars }.count
    }

    /// Shown offset → display range in the block (UTF-16), for drawing a highlight there.
    private func displayRange(_ item: Laid, _ s: Int, _ e: Int) -> NSRange? {
        let from = max(s, item.start) - item.start
        let to = min(e, item.start + item.shownCount) - item.start
        guard to > from, let string = item.attributed?.string else { return nil }
        func display(_ shownChars: Int) -> Int {
            var chars = shownChars
            for b in item.breaks where b <= chars { chars += 1 }
            let idx = string.index(string.startIndex, offsetBy: min(chars, string.count))
            return string[..<idx].utf16.count
        }
        let a = display(from), b = display(to)
        return b > a ? NSRange(location: a, length: b - a) : nil
    }

    @ViewBuilder
    private func selectable(_ item: Laid, _ placed: [ChatMark], _ shown: [Character]) -> some View {
        if let base = item.attributed {
            let ranges = placed.compactMap { displayRange(item, $0.s, $0.e) }
            let drawn = NSMutableAttributedString(attributedString: base)
            let _ = ranges.forEach { drawn.addAttribute(.backgroundColor, value: markColor, range: $0) }
            SelectableText(text: drawn, marked: ranges, onMark: { range in
                let s = shownOffset(item, range.location), e = shownOffset(item, range.location + range.length)
                var trimmedS = s, trimmedE = e
                while trimmedS < trimmedE, shown[trimmedS].isWhitespace { trimmedS += 1 }
                while trimmedE > trimmedS, shown[trimmedE - 1].isWhitespace { trimmedE -= 1 }
                guard trimmedE > trimmedS else { return }
                onChange(ChatMarks.add(placed, s: trimmedS, e: trimmedE, text: shown))
            }, onUnmark: { range in
                let s = shownOffset(item, range.location), e = shownOffset(item, range.location + range.length)
                onChange(placed.filter { !($0.s < max(e, s + 1) && $0.e > s) })
            }, onSelecting: onSelecting)
            #if os(iOS)
            // Drawn where SwiftUI's Text drew it (layout unchanged).
            .offset(y: SelectableText.baselineShift(drawn, scale: displayScale))
            #endif
        }
    }
}

private struct AnswerTable: View {
    let rows: [[String]]

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)).map(Text.init) ?? Text(text)
    }

    var body: some View {
        let columns = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { column in
                            inline(column < row.count ? row[column] : "")
                                .font(index == 0 ? .footnote.weight(.semibold) : .footnote)
                        }
                    }
                    if index == 0 { Divider() }
                }
            }
            .padding(10)
        }
        .background(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
    }
}

#if os(iOS)
/// Selectable text with "Highlight" (and "Remove highlight" on a highlight) at the front of the edit menu.
struct SelectableText: UIViewRepresentable {
    let text: NSAttributedString
    let marked: [NSRange]
    var onMark: (NSRange) -> Void
    var onUnmark: (NSRange) -> Void
    var onSelecting: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        // TextKit 1: it puts a line's gap under the line, as SwiftUI's Text does, and draws every line even when
        // the last one's gap is cut off (TextKit 2 drops a line that doesn't fit whole).
        let view = UITextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = []
        view.adjustsFontForContentSizeCategory = true
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if !view.attributedText.isEqual(to: text) { view.attributedText = text }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        // TextKit gives the last line its line gap too; SwiftUI's Text (the answer before 2.5) ends at the font's
        // line height. Without the gap the answer keeps the same height and spacing.
        var height = size.height
        if text.length > 0, let font = text.attribute(.font, at: text.length - 1, effectiveRange: nil) as? UIFont,
           let pitch = Self.lastLinePitch(uiView), pitch > font.lineHeight {
            height -= pitch - font.lineHeight
        }
        let scale = max(uiView.traitCollection.displayScale, 1)
        return CGSize(width: width, height: ceil(height * scale) / scale)
    }

    /// How far up to draw the text so its lines sit where SwiftUI's Text put them: both put the first baseline at
    /// the font's ascender on a whole pixel, SwiftUI rounding down and TextKit up (a pixel apart unless it's whole).
    static func baselineShift(_ text: NSAttributedString, scale: CGFloat) -> CGFloat {
        guard text.length > 0, let font = text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont else { return 0 }
        let s = max(scale, 1), ascender = font.ascender * s
        return (ascender.rounded(.down) - ascender.rounded(.up)) / s
    }

    /// The height TextKit gives the text's last line, with its line gap.
    private static func lastLinePitch(_ view: UITextView) -> CGFloat? {
        if let layout = view.textLayoutManager {
            var pitch: CGFloat?
            layout.enumerateTextLayoutFragments(from: layout.documentRange.endLocation, options: [.reverse, .ensuresLayout]) { fragment in
                pitch = fragment.textLineFragments.last?.typographicBounds.height
                return false
            }
            return pitch
        }
        let glyphs = view.layoutManager.numberOfGlyphs
        return glyphs > 0 ? view.layoutManager.lineFragmentRect(forGlyphAt: glyphs - 1, effectiveRange: nil).height : nil
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SelectableText
        init(_ parent: SelectableText) { self.parent = parent }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard range.length > 0 else { return nil }
            let onMark = parent.marked.contains { NSIntersectionRange($0, range).length > 0 }
            let action = onMark
                ? UIAction(title: String(localized: "Remove highlight"), image: UIImage(systemName: "highlighter")) { [weak self] _ in
                    self?.parent.onUnmark(range)
                    textView.selectedRange = NSRange(location: range.location, length: 0)
                }
                : UIAction(title: String(localized: "Highlight"), image: UIImage(systemName: "highlighter")) { [weak self] _ in
                    self?.parent.onMark(range)
                    textView.selectedRange = NSRange(location: range.location, length: 0)
                }
            return UIMenu(children: [action] + suggestedActions)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.onSelecting(textView.selectedRange.length > 0)
        }
    }
}
#else
/// Selectable text with "Highlight" (and "Remove highlight" on a highlight) at the top of the right-click menu.
struct SelectableText: NSViewRepresentable {
    let text: NSAttributedString
    let marked: [NSRange]
    var onMark: (NSRange) -> Void
    var onUnmark: (NSRange) -> Void
    var onSelecting: (Bool) -> Void

    final class MarkableView: NSTextView {
        var onMark: (NSRange) -> Void = { _ in }
        var onUnmark: (NSRange) -> Void = { _ in }
        var marked: [NSRange] = []

        override func menu(for event: NSEvent) -> NSMenu? {
            let menu = super.menu(for: event) ?? NSMenu()
            let range = selectedRange()
            guard range.length > 0 else { return menu }
            let onMark = marked.contains { NSIntersectionRange($0, range).length > 0 }
            let item = NSMenuItem(title: onMark ? String(localized: "Remove highlight") : String(localized: "Highlight"), action: #selector(toggleMark), keyEquivalent: "")
            item.target = self
            menu.insertItem(item, at: 0)
            menu.insertItem(.separator(), at: 1)
            return menu
        }

        @objc private func toggleMark() {
            let range = selectedRange()
            if marked.contains(where: { NSIntersectionRange($0, range).length > 0 }) { onUnmark(range) } else { onMark(range) }
            setSelectedRange(NSRange(location: range.location, length: 0))
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: SelectableText
        init(_ parent: SelectableText) { self.parent = parent }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.onSelecting(view.selectedRange().length > 0)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> MarkableView {
        let view = MarkableView()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.delegate = context.coordinator
        return view
    }

    func updateNSView(_ view: MarkableView, context: Context) {
        context.coordinator.parent = self
        view.onMark = onMark
        view.onUnmark = onUnmark
        view.marked = marked
        if view.textStorage?.isEqual(to: text) != true { view.textStorage?.setAttributedString(text) }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: MarkableView, context: Context) -> CGSize? {
        let width = proposal.width ?? 480
        guard let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }
}
#endif

// MARK: - Copy and share with the highlights in bold

enum RichAnswer {
    /// The answer as attributed text, its highlights in bold (for Share and Copy).
    static func bold(_ content: String, marks: [ChatMark]) -> NSAttributedString {
        let marked = ChatMarks.markedContent(content, marks)
        let out = NSMutableAttributedString()
        for (i, block) in AnswerBlocks.parse(marked).enumerated() {
            if i > 0 { out.append(NSAttributedString(string: "\n")) }
            switch block {
            case .heading(let t, _): out.append(boldMarks(t, AnswerBlocks.font(.headline, bold: true)))
            case .paragraph(let t): out.append(boldMarks(t, AnswerBlocks.font(.body)))
            case .bullet(let mark, let t):
                out.append(NSAttributedString(string: "\(mark) ", attributes: [.font: AnswerBlocks.font(.body)]))
                out.append(boldMarks(t, AnswerBlocks.font(.body)))
            case .table(let rows): out.append(NSAttributedString(string: rows.map { $0.joined(separator: " · ") }.joined(separator: "\n"), attributes: [.font: AnswerBlocks.font(.body)]))
            case .code(let code): out.append(NSAttributedString(string: code, attributes: [.font: PlatformFont.monospacedSystemFont(ofSize: 13, weight: .regular)]))
            }
        }
        return out
    }

    /// Inline Markdown with <mark>…</mark> turned into bold.
    private static func boldMarks(_ markdown: String, _ font: PlatformFont) -> NSAttributedString {
        let pieces = markdown.components(separatedBy: "<mark>")
        let out = NSMutableAttributedString()
        for (i, piece) in pieces.enumerated() {
            let parts = i == 0 ? [piece] : piece.components(separatedBy: "</mark>")
            for (j, part) in parts.enumerated() {
                let text = AnswerBlocks.inline(part, font: i > 0 && j == 0 ? AnswerBlocks.font(.body, bold: true) : font)
                if i > 0 && j == 0 { text.addAttribute(.font, value: AnswerBlocks.font(.body, bold: true), range: NSRange(location: 0, length: text.length)) }
                out.append(text)
            }
        }
        return out
    }

    /// Copy: rich text (RTF and HTML) and the plain text together.
    static func copy(_ attributed: NSAttributedString, plain: String) {
        let range = NSRange(location: 0, length: attributed.length)
        let rtf = try? attributed.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        let html = try? attributed.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.html])
        #if os(iOS)
        var item: [String: Any] = ["public.utf8-plain-text": plain]
        if let rtf { item["public.rtf"] = rtf }
        if let html { item["public.html"] = html }
        UIPasteboard.general.items = [item]
        #else
        let board = NSPasteboard.general
        board.clearContents()
        if let rtf { board.setData(rtf, forType: .rtf) }
        if let html { board.setData(html, forType: .html) }
        board.setString(plain, forType: .string)
        #endif
    }

    /// Share: the attributed text (apps that take rich text get the bold) and the plain text.
    @MainActor
    static func share(_ attributed: NSAttributedString, plain: String) {
        #if os(iOS)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
        while let shown = top.presentedViewController { top = shown }
        let sheet = UIActivityViewController(activityItems: [attributed], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 80, width: 1, height: 1)
        }
        top.present(sheet, animated: true)
        #else
        guard let view = NSApp.keyWindow?.contentView else { return }
        let point = view.convert(NSApp.keyWindow?.mouseLocationOutsideOfEventStream ?? .zero, from: nil)
        NSSharingServicePicker(items: [attributed]).show(relativeTo: NSRect(origin: point, size: CGSize(width: 1, height: 1)), of: view, preferredEdge: .minY)
        #endif
    }
}

// MARK: - Pinned messages: one bar at the top of the chat, as in Telegram

struct PinnedBar: View {
    /// The pinned answers and notes in the chat's order (oldest first), with their index in the chat.
    let items: [(index: Int, entry: ChatEntry)]
    /// Which one shows: a position in `items`, kept by the chat (a tap moves it on, scrolling picks it).
    @Binding var at: Int
    var open: (Int) -> Void
    var unpin: (Int) -> Void
    var unpinAll: () -> Void
    @State private var listing = false

    var body: some View {
        let count = items.count
        let shown = min(max(at, 0), count - 1)
        let current = items[shown]
        HStack(spacing: 0) {
            Button {
                open(current.index)
                at = shown > 0 ? shown - 1 : count - 1
            } label: {
                HStack(alignment: .center, spacing: 9) {
                    segments(count, shown)
                    VStack(alignment: .leading, spacing: 1) {
                        (count > 1 ? Text("Pinned #\(shown + 1)") : Text("Pinned message")).font(.caption.weight(.semibold)).foregroundColor(.orange)
                        Text(ReminderTimes.text(current.entry.content, max: 140)).font(.subheadline).foregroundColor(.primary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 7).padding(.leading, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(count > 1 ? Text("Pinned #\(shown + 1)") : Text("Pinned message"))
            .accessibilityValue(Text(ReminderTimes.text(current.entry.content)))
            if count > 1 {
                Button { listing = true } label: {
                    Image(systemName: "list.bullet").frame(width: 44, height: 40)
                }
                .buttonStyle(.plain)
                .foregroundColor(.secondary)
                .accessibilityLabel(Text("All pinned"))
                .popover(isPresented: $listing) { list(shown) }
            }
        }
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func segments(_ count: Int, _ shown: Int) -> some View {
        let first = min(max(0, shown - 3), max(0, count - 4))
        let visible = Array(first..<min(count, first + 4))
        return VStack(spacing: 2) {
            ForEach(visible, id: \.self) { pos in
                Capsule().fill(Color.orange.opacity(pos == shown ? 1 : 0.3)).frame(width: 2.5)
            }
        }
        .frame(height: 34)
    }

    private func list(_ shown: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("All pinned").font(.caption.weight(.semibold)).foregroundColor(.orange).padding(.horizontal, 14).padding(.vertical, 8)
            ForEach(Array(items.enumerated()), id: \.offset) { pos, item in
                HStack {
                    Button {
                        listing = false
                        open(item.index)
                        at = pos > 0 ? pos - 1 : items.count - 1
                    } label: {
                        Text(ReminderTimes.text(item.entry.content, max: 120)).lineLimit(1)
                            .fontWeight(pos == shown ? .semibold : .regular)
                            .foregroundColor(pos == shown ? .orange : .primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    Button { unpin(item.index) } label: { Image(systemName: "xmark").foregroundColor(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("Unpin"))
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                Divider()
            }
            Button(role: .destructive) {
                listing = false
                unpinAll()
            } label: { Text("Unpin all").frame(maxWidth: .infinity, alignment: .leading) }
                .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .frame(minWidth: 280, idealWidth: 340)
        .presentationCompactAdaptation(.popover)
    }
}

// MARK: - Reminders: the sheet and the bell under a message

struct RemindSheet: View {
    var current: Date?
    /// Why the last try didn't set it (notifications off).
    var note: String?
    var pick: (Date, String) -> Void
    var cancel: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var custom = Date().addingTimeInterval(86400)
    @State private var picking = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(ReminderTimes.presets(), id: \.preset) { item in
                    Button {
                        pick(item.at, item.preset.rawValue)
                    } label: {
                        HStack {
                            Text(ReminderTimes.title(item.preset)).foregroundColor(.primary)
                            Spacer()
                            Text(ReminderTimes.label(item.at)).foregroundColor(.secondary)
                        }
                    }
                }
                if picking {
                    DatePicker("Date", selection: $custom, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    Button("Remind") { pick(custom, "custom") }
                        .disabled(custom <= Date())
                } else {
                    Button("Pick a date") { picking = true }
                }
                if current != nil {
                    Button("Don't remind", role: .destructive, action: cancel)
                }
                if let note {
                    Text(note).font(.footnote).foregroundColor(.secondary)
                }
            }
            .navigationTitle("When should I remind you?")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .frame(minWidth: 320, minHeight: 340)
    }
}

/// The bell under a message with a reminder: when (grey once it has rung).
struct RemindChip: View {
    let at: Date
    var tap: () -> Void

    var body: some View {
        let past = at < Date()
        Button(action: tap) {
            Label(ReminderTimes.label(at), systemImage: "bell")
                .font(.caption.weight(.medium))
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(Capsule().fill((past ? Color.secondary : brandBlue).opacity(past ? 0.12 : 0.12)))
                .foregroundColor(past ? .secondary : brandBlue)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Reminder: \(ReminderTimes.label(at))"))
    }
}

// MARK: - Swiping a message: left to delete, right to pin (iPhone and iPad)

struct MessageSwipe: ViewModifier {
    var enabled: Bool
    var pinned: Bool
    var delete: () -> Void
    var pin: () -> Void
    @State private var dx: CGFloat = 0
    @State private var decided: Bool?
    @State private var width: CGFloat = 320

    @ViewBuilder
    func body(content: Content) -> some View {
        #if os(iOS)
        let swiped = content
            .background(GeometryReader { geo in Color.clear.onAppear { width = geo.size.width }.onChange(of: geo.size.width) { width = $0 } })
            .offset(x: dx)
            .background(alignment: dx < 0 ? .trailing : .leading) {
                if dx != 0 {
                    ZStack(alignment: dx < 0 ? .trailing : .leading) {
                        RoundedRectangle(cornerRadius: 14).fill(dx < 0 ? Color.red : Color.orange)
                        Label(dx < 0 ? "Delete" : (pinned ? "Unpin" : "Pin"), systemImage: dx < 0 ? "trash" : (pinned ? "pin.slash" : "pin"))
                            .labelStyle(.iconOnly).foregroundColor(.white).font(.title3)
                            .frame(width: 64)
                    }
                    .frame(width: abs(dx))
                }
            }
        if #available(iOS 18.0, *) {
            // From iOS 18 a SwiftUI drag here, even a simultaneous one, keeps the chat from scrolling: a UIKit pan
            // that starts only when the finger goes sideways leaves every vertical drag to the scroll view.
            swiped.gesture(SidewaysPan(enabled: enabled, changed: { x in
                dx = max(-width * 0.8, min(width * 0.8, x))
            }, ended: { x in
                let share = x / max(width, 1)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { dx = 0 }
                if share <= -0.42 { delete() } else if share >= 0.42 { pin() }
            }))
        } else {
            swiped.simultaneousGesture(drag, including: enabled ? .all : .subviews)
        }
        #else
        content
        #endif
    }

    #if os(iOS)
    /// Before iOS 18: a SwiftUI drag next to the scroll view's own.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { value in
                // From the very edge it's the system's Back; mostly vertical is scrolling.
                if decided == nil {
                    guard value.startLocation.x > 24 else { decided = false; return }
                    let x = abs(value.translation.width), y = abs(value.translation.height)
                    decided = x > y * 1.6
                }
                guard decided == true else { return }
                dx = max(-width * 0.8, min(width * 0.8, value.translation.width))
            }
            .onEnded { value in
                defer { decided = nil }
                guard decided == true else { return }
                let share = value.translation.width / max(width, 1)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { dx = 0 }
                if share <= -0.42 { delete() } else if share >= 0.42 { pin() }
            }
    }
    #endif
}

#if os(iOS)
/// A message's swipe as a UIKit pan (iOS 18 and later). It starts only for a mostly sideways drag, not from the
/// screen's edge (the system's Back) and not on code or a table that scrolls sideways; scroll views wait for it
/// to give up, so a vertical drag anywhere on a message scrolls the chat.
@available(iOS 18.0, *)
private struct SidewaysPan: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var changed: (CGFloat) -> Void
    var ended: (CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.isEnabled = enabled
        return pan
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let x = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .changed: changed(x)
        case .ended: ended(x)
        case .cancelled, .failed: ended(0)
        default: break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let velocity = pan.velocity(in: nil)
            guard abs(velocity.x) > abs(velocity.y) * 1.6 else { return false }
            guard pan.location(in: nil).x - pan.translation(in: nil).x > 28 else { return false }
            var hit = view.hitTest(pan.location(in: view), with: nil)
            while let v = hit, v !== view {
                if let scroll = v as? UIScrollView, scroll.isScrollEnabled, scroll.contentSize.width > scroll.bounds.width + 1 { return false }
                hit = v.superview
            }
            return true
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && other.view is UIScrollView
        }
    }
}
#endif

// MARK: - Small pieces for the chat

/// "…" under an answer or a note: pin, remind, delete.
struct MessageActions {
    var pinned: Bool
    var reminded: Bool
    var pin: () -> Void
    var remind: () -> Void
    var delete: () -> Void
}

/// Where the pinned messages are in the chat's scroll view (their tops), for the bar while scrolling.
struct PinnedTops: PreferenceKey {
    static var defaultValue: [Int: CGFloat] = [:]
    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { $1 }
    }
}

/// "Answer deleted · Undo" (the same bar as after a move).
struct DeletedBar: View {
    let text: LocalizedStringKey
    var undo: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline).foregroundColor(.white).frame(maxWidth: .infinity, alignment: .leading)
            Button("Undo", action: undo).font(.subheadline.weight(.semibold)).padding(.horizontal, 6)
        }
        .tint(Color(red: 0.58, green: 0.77, blue: 0.99))
        .padding(.vertical, 11).padding(.leading, 14).padding(.trailing, 6)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.14, green: 0.13, blue: 0.17)))
        .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        .frame(maxWidth: 560)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
