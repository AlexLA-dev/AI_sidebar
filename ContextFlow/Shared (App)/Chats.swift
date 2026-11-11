import Combine
import Foundation
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// MARK: - A chat, as the Safari extension writes it

/// One message of a chat (src/shared/conversation.ts `Entry`). Unknown fields are ignored here and kept
/// as they are when the app renames or pins a chat (the JSON is edited, not re-encoded).
struct ChatEntry: Decodable, Hashable {
    struct Page: Decodable, Hashable {
        var url: String
        var title: String
        /// The page's readable text, kept with the chat by the extension (2.4: the first question or note
        /// on the page, and again when it changed; never from Private Browsing).
        var text: String?
        /// When the question or note was written (ms since 1970); missing before 2.4.
        var at: Double?

        /// "1 Nov (2 days ago)", the same day "3 Nov (3 hours ago)": when the chat came to this page, shown
        /// by its title. Nil before 2.4.
        func when(now: Date = Date()) -> String? {
            guard let at else { return nil }
            let date = Date(timeIntervalSince1970: at / 1000)
            let calendar = Calendar.current
            let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0)
            let style = calendar.component(.year, from: date) == calendar.component(.year, from: now)
                ? Date.FormatStyle.dateTime.day().month(.abbreviated)
                : Date.FormatStyle.dateTime.day().month(.abbreviated).year()
            let relative = RelativeDateTimeFormatter()
            relative.dateTimeStyle = .named
            // The same day in hours, minutes or "now" (another device's clock may run a bit ahead).
            let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
            let ago = days > 0 ? DateComponents(day: -days)
                : minutes < 1 ? DateComponents(second: 0)
                : minutes < 60 ? DateComponents(minute: -minutes)
                : DateComponents(hour: -(minutes / 60))
            return "\(date.formatted(style)) (\(relative.localizedString(from: ago)))"
        }
    }

    struct Source: Decodable, Hashable {
        var title: String
        var url: String
    }

    struct Grounding: Decodable, Hashable {
        var sources: [Source]
    }

    /// A video transcript or PDF a question went with (or why it couldn't be read).
    struct Read: Decodable, Hashable {
        var kind: String
        var ok: Bool
        var name: String
        var detail: String?
        var reason: String?
    }

    var role: String
    var content: String
    var label: String?
    var mode: String?
    var note: Bool?
    /// A note made from a page selection: its text starts with the quote.
    var quote: Bool?
    /// 2.6 (97): such a note's selected text as it was quoted (src/shared/conversation.ts `cite`): the chat shows it as a
    /// quote and the rest of the text as the person's own words. Older notes have none and look as they did.
    var cite: String?
    var page: Page?
    var pageChanged: Bool?
    var grounding: Grounding?
    var sources: [Read]?
    /// The user's tags on an answer or a note.
    var tags: [String]?
    /// An answer from the app in a chat without page texts (it says so once, under this answer).
    var noPages: Bool?
    /// 2.5: the message's id and when it was written (ms); older messages have neither.
    var id: String?
    var t: Double?
    /// Moved here from another chat (organizing): which one, and when.
    var from: From?
    /// Organizing suggestions turned down here (moving its block; these tags), and suggested tags taken.
    var dismissed: Dismissed?
    var accepted: Accepted?
    /// Chat UX (2.5): the user's highlights in an answer, pinned (ms), a reminder (ChatUX.swift).
    var marks: [ChatMark]?
    var pinned: Double?
    var remind: ChatRemind?
    /// Find similar (2.6): on the question, the condition asked and where it looked; on the answer, the whole list
    /// (build 95: the app draws the panel's cards from it, SimilarCards.swift).
    var similarAsk: String?
    var similarRegion: String?
    var similarCountry: String?
    var similar: SimilarAnswerData?

    struct From: Decodable, Hashable {
        var chat: String
        var at: Double
    }

    struct Dismissed: Decodable, Hashable {
        var move: Bool?
        var tags: [String]?
    }

    struct Accepted: Decodable, Hashable {
        var tags: [String]?
    }

    var isUser: Bool { role == "user" }
    var isNote: Bool { note == true }

    /// Where a cited note's quote ends in its text (after the closing mark), or nil when the text doesn't start with it
    /// (src/shared/conversation.ts citeEnd: the opening mark is “ « „ 「 or « with a space).
    private var citeEnd: String.Index? {
        guard let cite, !cite.isEmpty, let found = content.range(of: cite, options: .literal),
              content.utf16.distance(from: content.startIndex, to: found.lowerBound) <= 3 else { return nil }
        return content.range(of: "\n\n", options: .literal, range: found.upperBound..<content.endIndex)?.lowerBound ?? content.endIndex
    }

    /// A note made from a selection, apart (citedNote): its quote and the person's own words ("" for none); nil for any
    /// other message, shown as its text.
    var cited: (cite: String, note: String)? {
        guard let end = citeEnd, let cite else { return nil }
        return (cite, String(content[end...]).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// What its reminder's notification says (src/shared/reminders.ts reminderNotice): a note on a selection's own words
    /// when it has some, else its text, as before.
    var reminderText: String {
        guard let cited, !cited.note.isEmpty else { return content }
        return cited.note
    }

    /// The person's own words on a reminder made with Remind on a selection or a page, as its window shows them to change
    /// (remindWords): a cited note's after its quote; a page's note its text unless that's the page's name. Nil for any
    /// other reminder.
    var remindWords: String? {
        guard isNote, remind?.page == true else { return nil }
        if let cited { return cited.note }
        if quote == true { return nil }
        let names = [page?.title, page?.url].compactMap { $0 }.filter { !$0.isEmpty }
        return names.contains(content.trimmingCharacters(in: .whitespacesAndNewlines)) ? "" : content
    }

    /// The text with the person's new words (withRemindWords): the quote and its marks stay; a page's note without words
    /// says the page's name. Nil when the reminder has no words to change.
    func withRemindWords(_ words: String) -> String? {
        guard remindWords != nil else { return nil }
        let own = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if let end = citeEnd { return String(content[..<end]) + (own.isEmpty ? "" : "\n\n\(own)") }
        if !own.isEmpty { return own }
        return [page?.title, page?.url].compactMap { $0 }.first { !$0.isEmpty } ?? content
    }
}

/// A chat (src/shared/threads.ts `Thread`), from its iCloud form `{title?, a?, pin?, m}`.
struct ChatThread: Identifiable, Hashable {
    let id: String
    /// Last change (ms): the newest copy wins between devices.
    let updatedAt: Int64
    /// The JSON the extension and iCloud store.
    let data: String
    let title: String?
    /// The name the AI gave it (2.6, src/shared/threads.ts `aiTitle`, stored as "ait"): while `title` is still this one,
    /// the AI may name it again; a name the user typed differs, and the AI never touches it.
    let aiTitle: String?
    /// Last message (ms): the list order.
    let lastAt: Int64
    let pin: Double?
    let entries: [ChatEntry]
    /// "Ask your chats" (Pro): questions about all the other chats.
    let isHistory: Bool
    /// The chat's own tags (answers and notes have theirs on the entry).
    let ownTags: [String]
    /// In Recently Deleted since then (ms), or nil (src/shared/threads.ts `trashed`, 2.5 (83)): hidden everywhere,
    /// deleted for good `ChatLibrary.trashDays` later.
    let trashedAt: Int64?
    /// What organizing suggested for it, kept with it so every device shows it at once and knows what was turned down
    /// (2.6 (93), "org").
    let org: OrgState?

    /// A part read on its own: one that doesn't make sense is nil, the chat still reads.
    private struct Lenient<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    private struct Stored: Decodable {
        var title: String?
        var ait: String?
        var a: Int64?
        var pin: Double?
        var k: String?
        var tags: [String]?
        var trashed: Double?
        var org: Lenient<OrgState>?
        var m: [ChatEntry]
    }

    init?(id: String, updatedAt: Int64, data: String) {
        guard let raw = data.data(using: .utf8) else { return nil }
        let stored: Stored
        if let object = try? JSONDecoder().decode(Stored.self, from: raw) {
            stored = object
        } else if let list = try? JSONDecoder().decode([ChatEntry].self, from: raw) {
            // 2.3 (build 56) stored just the messages.
            stored = Stored(m: list)
        } else {
            return nil
        }
        self.id = id
        self.updatedAt = updatedAt
        self.data = data
        title = stored.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        aiTitle = stored.ait?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        lastAt = stored.a ?? updatedAt
        pin = stored.pin
        isHistory = stored.k == "history"
        ownTags = Tags.clean(stored.tags ?? [])
        trashedAt = stored.trashed.flatMap { $0.isFinite && abs($0) < 9e15 ? Int64($0) : nil }
        org = stored.org?.value
        entries = stored.m
    }

    var isTrashed: Bool { trashedAt != nil }

    /// Days until it's deleted for good, in Recently Deleted: 30 just after, never less than 1 while it's there.
    func daysLeft(now: Date = Date()) -> Int {
        guard let trashedAt else { return ChatLibrary.trashDays }
        let left = Double(trashedAt) + Double(ChatLibrary.trashDays) * 86_400_000 - now.timeIntervalSince1970 * 1000
        return min(ChatLibrary.trashDays, max(1, Int((left / 86_400_000).rounded(.up))))
    }

    /// The chat's tags and those of its answers and notes, without repeats.
    var tags: [String] { Tags.clean(ownTags + entries.flatMap { $0.tags ?? [] }) }

    func has(tag: String) -> Bool { tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } }

    var isPinned: Bool { pin != nil }

    /// The user's name for it (or the AI's), or its first question (or quick action and its page).
    var name: String { title ?? Self.title(of: entries) }

    /// The user named it themselves: the AI never renames it (src/shared/threads.ts `namedByUser`).
    var namedByUser: Bool { title != nil && title != aiTitle }

    /// A name for these messages, as a chat is named after its first question (src/shared/threads.ts `threadTitle`).
    static func title(of entries: [ChatEntry]) -> String {
        guard let first = entries.first(where: \.isUser) else { return "" }
        if let label = first.label {
            return oneLine(first.page.map { "\(label) · \($0.title)" } ?? label, 80)
        }
        return oneLine(first.content, 80)
    }

    /// The last answer's first line.
    var snippet: String {
        guard let last = entries.last(where: { !$0.isUser }) ?? entries.last else { return "" }
        let plain = RowMarks.unlinked(last.content)
            .replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[#>|]+"#, with: " ", options: .regularExpression)
        return oneLine(plain, 140)
    }

    /// The pages the chat was on, in the order it came to them.
    var pages: [ChatEntry.Page] {
        var seen = Set<String>()
        return entries.compactMap { entry in
            guard entry.isUser, let page = entry.page, seen.insert(page.url).inserted else { return nil }
            return page
        }
    }

    var lastPage: ChatEntry.Page? { entries.last(where: { $0.page != nil })?.page }

    /// The page texts kept in the chat (src/shared/conversation.ts `savedPages`): the latest of each
    /// page, the most recent page first.
    var savedPages: [ChatEntry.Page] {
        var out: [ChatEntry.Page] = []
        for entry in entries.reversed() {
            if let page = entry.page, page.text?.isEmpty == false, !out.contains(where: { $0.url == page.url }) { out.append(page) }
        }
        return out
    }

    var notes: Int { entries.filter(\.isNote).count }

    var lastActivity: Date { Date(timeIntervalSince1970: TimeInterval(lastAt) / 1000) }

    /// The same chat with its name and pin changed, as of `updatedAt`. For each: nil keeps it,
    /// `.some(nil)` removes it, `.some(value)` sets it. `trashed` the same: in Recently Deleted since then, or out of it.
    /// Every other field stays as it is in the JSON, those this version doesn't know too.
    func edited(title: String??, aiTitle: String?? = nil, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil, trashed: Int64?? = nil, org: OrgState?? = nil, updatedAt: Int64) -> ChatMirror.Item? {
        let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8))
        guard var object = (parsed as? [String: Any]) ?? (parsed as? [Any]).map({ ["m": $0] }) else { return nil }
        switch title {
        case .none: break
        case .some(.none): object.removeValue(forKey: "title")
        case .some(.some(let value)): object["title"] = value
        }
        switch aiTitle {
        case .none: break
        case .some(.none): object.removeValue(forKey: "ait")
        case .some(.some(let value)): object["ait"] = value
        }
        switch pin {
        case .none: break
        case .some(.none): object.removeValue(forKey: "pin")
        case .some(.some(let value)): object["pin"] = value
        }
        if let tags {
            if tags.isEmpty { object.removeValue(forKey: "tags") } else { object["tags"] = tags }
        }
        if let entryTags, var list = object["m"] as? [[String: Any]], list.indices.contains(entryTags.index) {
            if entryTags.tags.isEmpty { list[entryTags.index].removeValue(forKey: "tags") } else { list[entryTags.index]["tags"] = entryTags.tags }
            object["m"] = list
        }
        switch trashed {
        case .none: break
        case .some(.none): object.removeValue(forKey: "trashed")
        case .some(.some(let value)): object["trashed"] = value
        }
        switch org {
        case .none: break
        case .some(.none): object.removeValue(forKey: "org")
        case .some(.some(let value)): object["org"] = value.json
        }
        // Renaming, pinning, tagging, deleting or restoring keeps the chat's place by its last message.
        if object["a"] == nil { object["a"] = lastAt }
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return nil }
        return ChatMirror.Item(updatedAt: updatedAt, data: text)
    }

    /// The chat as Organize works on it (its stored JSON).
    var organized: OrganizeThread? { OrganizeThread(id: id, u: updatedAt, data: data) }

    /// The same chat with `entries` (src/shared/conversation.ts `Entry` objects) after its messages,
    /// written at `updatedAt`: it moves to the top of the list like a chat continued in Safari.
    func appending(_ entries: [[String: Any]], updatedAt: Int64) -> ChatMirror.Item? {
        let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8))
        guard var object = (parsed as? [String: Any]) ?? (parsed as? [Any]).map({ ["m": $0] }),
              let list = object["m"] as? [Any] else { return nil }
        object["m"] = list + entries
        object["a"] = updatedAt
        // Written in: out of Recently Deleted, as in the Safari panel (src/shared/threads.ts withMessages).
        object.removeValue(forKey: "trashed")
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return nil }
        return ChatMirror.Item(updatedAt: updatedAt, data: text)
    }
}

// MARK: - Copy and share (src/shared/share.ts)

/// What Copy and Share give for an answer, a note or the picked messages of a chat, the same text as
/// in the Safari panel: plain text that keeps the links in the answers, the Google sources and the
/// pages asked about, and ends with the link to ContextFlow. Its labels ("You", "Source"…) are in the
/// language the chat's questions were typed in, else the app's. It never starts with "word:" (apps that
/// parse it as a URL would save it as one link).
enum ShareText {
    struct Labels {
        let you, note, sources, source, madeWith: String
    }

    static let appLink = "https://apps.apple.com/app/contextflow-ai-web-assistant/id6759115793"

    private static let byLanguage: [String: Labels] = [
        "ar": Labels(you: "أنت", note: "ملاحظة", sources: "المصادر", source: "المصدر", madeWith: "صُنع باستخدام ContextFlow"),
        "de": Labels(you: "Du", note: "Notiz", sources: "Quellen", source: "Quelle", madeWith: "Erstellt mit ContextFlow"),
        "en": Labels(you: "You", note: "Note", sources: "Sources", source: "Source", madeWith: "Made with ContextFlow"),
        "es": Labels(you: "Tú", note: "Nota", sources: "Fuentes", source: "Fuente", madeWith: "Hecho con ContextFlow"),
        "fr": Labels(you: "Vous", note: "Note", sources: "Sources", source: "Source", madeWith: "Créé avec ContextFlow"),
        "it": Labels(you: "Tu", note: "Nota", sources: "Fonti", source: "Fonte", madeWith: "Creato con ContextFlow"),
        "ja": Labels(you: "あなた", note: "メモ", sources: "出典", source: "出典", madeWith: "ContextFlowで作成"),
        "ko": Labels(you: "나", note: "메모", sources: "출처", source: "출처", madeWith: "ContextFlow로 작성"),
        "pt_BR": Labels(you: "Você", note: "Nota", sources: "Fontes", source: "Fonte", madeWith: "Feito com o ContextFlow"),
        "ru": Labels(you: "Вы", note: "Заметка", sources: "Источники", source: "Источник", madeWith: "Сделано в ContextFlow"),
        "uk": Labels(you: "Ви", note: "Нотатка", sources: "Джерела", source: "Джерело", madeWith: "Зроблено в ContextFlow"),
        "vi": Labels(you: "Bạn", note: "Ghi chú", sources: "Nguồn", source: "Nguồn", madeWith: "Tạo bằng ContextFlow"),
        "zh_CN": Labels(you: "你", note: "笔记", sources: "来源", source: "来源", madeWith: "由 ContextFlow 生成"),
        "zh_TW": Labels(you: "你", note: "筆記", sources: "來源", source: "來源", madeWith: "用 ContextFlow 製作")
    ]

    /// The labels in the chat's language, or the app's.
    static func labels(for entries: [ChatEntry]) -> Labels {
        if let language = chatLanguage(entries), let labels = byLanguage[language] { return labels }
        let app = Bundle.main.preferredLocalizations.first ?? "en"
        let code = app == "pt-BR" ? "pt_BR" : app == "zh-Hant" ? "zh_TW" : app.hasPrefix("zh") ? "zh_CN" : String(app.prefix(2))
        return byLanguage[code] ?? byLanguage["en"]!
    }

    /// Plain text: Markdown syntax gone, structure and links kept.
    static func plain(_ text: String) -> String {
        var out = replace(RowMarks.unlinked(text), #"[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)"#, "")
        out = replace(out, #"```[a-z]*\n?"#, "", caseless: true)
        out = replace(out, #"(?m)^#{1,6}\s+"#, "")
        out = replace(out, #"\*\*([^*]+)\*\*"#, "$1")
        out = replace(out, #"__([^_]+)__"#, "$1")
        out = replace(out, #"(^|\W)\*([^*\n]+)\*"#, "$1$2")
        out = replace(out, #"`([^`]+)`"#, "$1")
        // [label](url) → "label: url" (just the url when they're the same).
        let links = try! NSRegularExpression(pattern: #"\[([^\]]+)\]\((https?:[^)]+)\)"#)
        for match in links.matches(in: out, range: NSRange(out.startIndex..., in: out)).reversed() {
            guard let whole = Range(match.range, in: out), let label = Range(match.range(at: 1), in: out), let url = Range(match.range(at: 2), in: out) else { continue }
            out.replaceSubrange(whole, with: out[label] == out[url] ? String(out[url]) : "\(out[label]): \(out[url])")
        }
        out = replace(out, #"(?m)^\s*[-*+]\s+"#, "• ")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One answer: its text and sources, the page it was about, and where it was made.
    static func answer(_ entries: [ChatEntry], _ index: Int, _ labels: Labels) -> String {
        signed(answerText(entries[index], labels), page: pageOf(entries, index), labels)
    }

    /// A note to copy: its text; one made from a selection also the page the quote is from.
    static func noteCopy(_ entry: ChatEntry) -> String {
        guard entry.quote == true, let page = entry.page else { return entry.content }
        return "\(entry.content)\n\n\(link(page.title, page.url))"
    }

    /// One note: its text, the page it was written on, and where it was made.
    static func note(_ entries: [ChatEntry], _ index: Int, _ labels: Labels) -> String {
        signed(entries[index].content, page: pageOf(entries, index), labels)
    }

    /// The messages at `picked`: one answer alone shares like an answer, anything else like a chat.
    static func picked(_ entries: [ChatEntry], _ picked: Set<Int>, name: String, _ labels: Labels) -> String {
        if picked.count == 1, let only = picked.first, entries.indices.contains(only), !entries[only].isUser {
            return answer(entries, only, labels)
        }
        return chat(entries, name: name, labels, only: picked)
    }

    /// The chat under its name: questions, answers and notes (all, or those in `only`), the pages they
    /// were about, and where it was made.
    static func chat(_ entries: [ChatEntry], name: String, _ labels: Labels, only: Set<Int>? = nil) -> String {
        var lines: [String] = []
        var pages: [(url: String, title: String)] = []
        func add(_ page: ChatEntry.Page) {
            if let i = pages.firstIndex(where: { $0.url == page.url }) { pages[i].title = page.title } else { pages.append((page.url, page.title)) }
        }
        for (i, entry) in entries.enumerated() where only?.contains(i) ?? true {
            if entry.isUser {
                if let page = entry.page { add(page) }
                lines.append(entry.isNote ? "\(labels.note): \(entry.content)" : "\(labels.you): \(entry.label ?? entry.content)")
            } else {
                if let page = pageOf(entries, i) { add(page) }
                lines += ["ContextFlow: \(answerText(entry, labels))", ""]
            }
        }
        var parts = name.isEmpty ? [] : [name, ""]
        parts.append(lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
        if !pages.isEmpty { parts += ["", "\(labels.source):\n" + pages.map { link($0.title, $0.url) }.joined(separator: "\n")] }
        parts += ["", "\(labels.madeWith): \(appLink)"]
        return notALink(parts.joined(separator: "\n"))
    }

    /// The language of the chat's questions, when it's clear (quick actions don't count: they're in the
    /// device's language).
    static func chatLanguage(_ entries: [ChatEntry]) -> String? {
        textLanguage(entries.filter { $0.isUser && $0.label == nil }.map(\.content).joined(separator: "\n"))
    }

    // Words that mark a language written in Latin letters, and letters only it uses.
    private static let latin: [(String, Set<String>, String?)] = [
        ("en", Set("the is are what how why who which this that these with about does do can you your of and to in it for".split(separator: " ").map(String.init)), nil),
        ("de", Set("der die das ist sind und was wie warum wer nicht ein eine einen ich du mit für auf über worum geht es den dem des".split(separator: " ").map(String.init)), "[ßäöü]"),
        ("es", Set("el los las es son qué que cómo por y en un una del se está para con sobre trata eso esto".split(separator: " ").map(String.init)), "[ñ¿¡]"),
        ("fr", Set("le les est sont et que quoi comment pourquoi un une des du ce cet cette il elle pour dans avec sur qui parle".split(separator: " ").map(String.init)), "[œêâîôûëïç]"),
        ("it", Set("il lo gli è sono che cosa come perché di e un una del della per con su questo questa parla".split(separator: " ").map(String.init)), nil),
        ("pt_BR", Set("o os é são que como por e um uma do da não para com sobre isso este esta fala".split(separator: " ").map(String.init)), "[ãõ]"),
        ("vi", Set("là của và có không gì này những một các cho được trong về như thế nào sao bài trang tôi bạn với để khi đây đó nói".split(separator: " ").map(String.init)), "[ăđơư\\u1ea0-\\u1ef9]")
    ]
    // The letters of Latin-script words: Vietnamese adds ă đ ĩ ũ ơ ư and its tone marks to French and German's.
    private static let word = "[a-zà-ÿœăđĩũơư\\u1ea0-\\u1ef9]"

    // Characters written one way in Traditional Chinese and another in Simplified (這/这, 們/们, 說/说…): which of the
    // two a text uses more tells zh_TW from zh_CN (src/shared/share.ts has the same lists).
    static let traditional = "這個們說麼時為會來嗎頁點與對關還讓價樣從種寫問題單開東車書長經現發學國總結網體請應該變處過實動頭義區記錄認識讀聽買賣錢氣電話視備帶獲據歡"
    static let simplified = "这个们说么时为会来吗页点与对关还让价样从种写问题单开东车书长经现发学国总结网体请应该变处过实动头义区记录认识读听买卖钱气电话视备带获据欢"

    /// The language of a text, when it's clear: a locale code ("ru", "pt_BR"…).
    static func textLanguage(_ raw: String) -> String? {
        let text = replace(raw, #"(https?://|www\.)\S+"#, " ", caseless: true)
        let count = { (pattern: String) in matches(text, pattern) }
        let scripts: [(String?, Int)] = [
            ("ko", count(#"[\uac00-\ud7af]"#)),
            (count(#"[\u3040-\u30ff]"#) > 0 ? "ja" : count("[\(traditional)]") > count("[\(simplified)]") ? "zh_TW" : "zh_CN", count(#"[\u3040-\u30ff\u4e00-\u9fff]"#)),
            ("ar", count(#"[\u0600-\u06ff\u0750-\u077f]"#)),
            (matches(text, #"[іїєґ]|(^|[^а-яё])(що|це|ця|цей|чому|який|яка|яке)(?![а-яё])"#, caseless: true) > 0 ? "uk" : "ru", matches(text, #"[а-яёіїєґ]"#, caseless: true)),
            (nil, matches(text, word, caseless: true))
        ]
        let (script, letters) = scripts.dropFirst().reduce(scripts[0]) { $1.1 > $0.1 ? $1 : $0 }
        guard letters >= 3 else { return nil }
        if let script { return script }
        let lower = text.lowercased()
        let words = (try! NSRegularExpression(pattern: word + "+")).matches(in: lower, range: NSRange(lower.startIndex..., in: lower)).compactMap { Range($0.range, in: lower).map { String(lower[$0]) } }
        let scores = latin.map { language, common, letters in
            (language, words.filter { common.contains($0) }.count + (letters.map { matches(lower, $0) > 0 } == true ? 2 : 0))
        }
        // Stable, like the panel's sort: the first of equal scores wins.
        let sorted = scores.enumerated().sorted { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1 : $0.offset < $1.offset }.map(\.element)
        return sorted[0].1 >= 2 && sorted[0].1 > sorted[1].1 ? sorted[0].0 : nil
    }

    // MARK: Parts

    private static func signed(_ text: String, page: ChatEntry.Page?, _ labels: Labels) -> String {
        var parts = [text]
        if let page { parts += ["", "\(labels.source): \(page.url)"] }
        parts += ["", "\(labels.madeWith): \(appLink)"]
        return notALink(parts.joined(separator: "\n"))
    }

    /// An answer as text, with the Google sources it came with.
    private static func answerText(_ entry: ChatEntry, _ labels: Labels) -> String {
        let text = plain(entry.content)
        guard let sources = entry.grounding?.sources, !sources.isEmpty else { return text }
        return "\(text)\n\n\(labels.sources):\n" + sources.map { "• \(link($0.title, $0.url))" }.joined(separator: "\n")
    }

    /// The page the message at `index` was about (its question's page, or an earlier one).
    private static func pageOf(_ entries: [ChatEntry], _ index: Int) -> ChatEntry.Page? {
        entries[...index].last { $0.isUser && $0.page != nil }?.page
    }

    private static func link(_ title: String, _ url: String) -> String {
        !title.isEmpty && title != url ? "\(title) — \(url)" : url
    }

    /// Text that doesn't parse as a URL: a leading "word:" (a URL scheme to parsers) becomes "word —".
    static func notALink(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"^([a-z][a-z0-9+.-]*):(?!//)"#, options: .caseInsensitive),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let whole = Range(match.range, in: text), let scheme = Range(match.range(at: 1), in: text) else { return text }
        return text.replacingCharacters(in: whole, with: "\(text[scheme]) —")
    }

    private static func replace(_ text: String, _ pattern: String, _ template: String, caseless: Bool = false) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: caseless ? .caseInsensitive : []) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func matches(_ text: String, _ pattern: String, caseless: Bool = false) -> Int {
        (try? NSRegularExpression(pattern: pattern, options: caseless ? .caseInsensitive : []))?.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)) ?? 0
    }
}

enum Clipboard {
    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

#if os(iOS)
/// The share sheet for text, with a call when it closes (shared or not).
@MainActor
enum ShareSheet {
    static func present(_ text: String, done: @escaping () -> Void) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else { return done() }
        while let shown = top.presentedViewController { top = shown }
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in done() }
        if let popover = sheet.popoverPresentationController {
            // iPad: from the bar at the bottom.
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.maxX - 80, y: top.view.bounds.maxY - 40, width: 1, height: 1)
            popover.permittedArrowDirections = .down
        }
        top.present(sheet, animated: true)
    }
}
#endif

func host(of url: String) -> String {
    guard let host = URL(string: url)?.host else { return "" }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

private func oneLine(_ text: String, _ max: Int) -> String {
    let line = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return line.count > max ? String(line.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : line
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - The chats

/// The chats for the app's Chats screen: the copy the Safari extension keeps in the App Group (this
/// device's chats, and those iCloud brought), plus, when iCloud sync is on, the newest from iCloud
/// itself (a chat continued on the Mac shows up on the iPhone without opening Safari first).
/// Renaming, pinning and deleting go to iCloud and to the extension (it applies them next time).
@MainActor
final class ChatLibrary: ObservableObject {
    static let shared = ChatLibrary()
    #if DEBUG
    /// -CFDebugRemoteRename is done once per launch.
    private static var remoteRenameScheduled = false
    #endif

    enum Cloud: Equatable {
        /// Sync is switched off (here or in the extension's settings).
        case off
        /// No iCloud account, or iCloud isn't reachable right now.
        case unavailable
        case syncing
        case ok
    }

    /// The chats the user has: not in Recently Deleted. The list, search, Ask your chats, tags and reminders use these.
    @Published private(set) var threads: [ChatThread] = []
    /// Recently Deleted (2.5 (83)), the last one deleted first.
    @Published private(set) var trashed: [ChatThread] = []
    @Published private(set) var cloud: Cloud = .off
    @Published private(set) var loaded = false

    /// How long a deleted chat stays in Recently Deleted (src/shared/threads.ts TRASH_DAYS).
    static let trashDays = 30

    private static let tokenKey = "cf_chats_cloud_token"
    private var cloudTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var pulledAt = Date.distantPast

    private init() {
        reload()
        // Until the first refresh: not "off" when sync is on, or the Chats screen flashes the sync-off card.
        cloud = syncOn ? .syncing : .off
    }

    /// iCloud sync of chats (the extension's setting, shared through the App Group; on by default).
    var syncOn: Bool {
        SharedDefaults.shared.readSettings()?.settings["syncChats"] as? Bool ?? true
    }

    /// Re-reads the extension's copy, then asks iCloud for anything newer.
    func refresh() {
        #if DEBUG
        // Screenshots of a chat (build 90, Listen under an answer): -CFDebugSeedChat YES puts one sample chat here.
        if UserDefaults.standard.bool(forKey: "CFDebugSeedChat"), ChatMirror.chats()["debug-seed"] == nil {
            let at = Int64(Date().timeIntervalSince1970 * 1000)
            let thread: [String: Any] = ["title": "Electric trains", "a": at, "m": [
                ["role": "user", "content": "How do electric trains save energy?"],
                ["role": "assistant", "content": "Electric trains draw power from overhead lines or a third rail, and modern ones return energy to the grid when they brake. That is why a high-speed line can use less energy per passenger than a short flight."]
            ]]
            if let data = try? JSONSerialization.data(withJSONObject: thread), let text = String(data: data, encoding: .utf8) {
                _ = ChatMirror.apply(saves: ["debug-seed": ChatMirror.Item(updatedAt: at, data: text)])
            }
            // Build 94: a chat named after its first page, its last answer from another page (neutral pages, like
            // the other seeds: build 95, no data of the owner's in the code).
            let first: [String: Any] = ["url": "https://bikes.example/city-e3", "title": "City E3 – Bikes Example | Ride Further", "at": at - 60_000]
            let second: [String: Any] = ["url": "https://dashboard.example/report", "title": "Monthly report — Dashboard Example", "at": at]
            let pages: [String: Any] = ["title": "Google · City E3 – Bikes Example | Ride Further", "a": at + 1, "m": [
                ["role": "user", "content": "Is the City E3 a good bike?", "id": "dp1", "t": at - 60_000, "page": first],
                ["role": "assistant", "content": "The City E3 is a comfortable electric bike with a long range.", "id": "dp2", "t": at - 55_000],
                ["role": "user", "content": "What does 03.04 mean here?", "id": "dp3", "t": at, "page": second, "mode": "google"],
                ["role": "assistant", "content": "Most likely a date: the third of April, or the fourth of March where the month comes first.", "id": "dp4", "t": at + 1]
            ]]
            if let data = try? JSONSerialization.data(withJSONObject: pages), let text = String(data: data, encoding: .utf8) {
                _ = ChatMirror.apply(saves: ["debug-seed-pages": ChatMirror.Item(updatedAt: at + 1, data: text)])
            }
        }
        // 2.6 (98) (messages jumped in a chat): -CFDebugSeedLong YES puts a chat with long answers here (paragraphs,
        // bullets, bold), on a neutral page.
        if UserDefaults.standard.bool(forKey: "CFDebugSeedLong"), ChatMirror.chats()["debug-long"] == nil {
            let at = Int64(Date().timeIntervalSince1970 * 1000)
            let page: [String: Any] = ["url": "https://trains.example/energy", "title": "How electric trains use energy", "at": at - 600_000]
            let answer = "**In short:** electric trains are efficient because they draw power from the grid and give some of it back when they brake.\n\n- **Regenerative braking** returns energy to the line, often a fifth of what the train used.\n- **Light, long trains** carry many people per unit of energy.\n- **Steel wheels on steel rails** roll with little friction, so the train coasts far.\n\nA high-speed line can use less energy per passenger than a short flight, and less still when the grid is clean. The gain shrinks on lines with many stops, where the train keeps speeding up and slowing down, and on old lines that can't take energy back.\n\n**What to watch:** the share of renewables on the grid, the age of the rolling stock, and how full the trains run."
            var m: [[String: Any]] = []
            for i in 0..<6 {
                m.append(["role": "user", "content": "Question \(i + 1): how do electric trains save energy?", "id": "lq\(i)", "t": at - 600_000 + Int64(i) * 60_000, "page": page])
                m.append(["role": "assistant", "content": answer, "id": "la\(i)", "t": at - 590_000 + Int64(i) * 60_000])
            }
            let thread: [String: Any] = ["title": "Electric trains and energy", "a": at, "m": m]
            if let data = try? JSONSerialization.data(withJSONObject: thread), let text = String(data: data, encoding: .utf8) {
                _ = ChatMirror.apply(saves: ["debug-long": ChatMirror.Item(updatedAt: at, data: text)])
            }
        }
        // A big library (2.6 (92): the app hung opening chats with hundreds of them): -CFDebugSeedChats 300 puts that
        // many chats here, 40 topics over their sites, with page texts, notes and the user's tags.
        DebugHangLog.start()
        let many = UserDefaults.standard.integer(forKey: "CFDebugSeedChats")
        if many > 0, ChatMirror.chats()["debug-many-0"] == nil {
            var saves: [String: ChatMirror.Item] = [:]
            var at = Int64(Date().timeIntervalSince1970 * 1000) - Int64(many) * 3_600_000
            let topics = ["electric cars", "sourdough baking", "marathon training", "home espresso", "kyoto travel", "index funds", "react hooks", "kubernetes", "houseplants", "photography"]
            let pageText = String(repeating: "A page about the topic, with the details a reader would ask about. ", count: 110)
            for c in 0..<many {
                let topic = topics[c % topics.count]
                var m: [[String: Any]] = []
                for t in 0..<(3 + c % 9) {
                    at += 60_000
                    let page: [String: Any] = ["url": "https://site\(c % 40).example/\(topic.replacingOccurrences(of: " ", with: "-"))/\(t % 3)", "title": "\(topic.capitalized), part \(t % 3)", "at": at, "text": t % 3 == 0 ? pageText : ""]
                    m.append(["role": "user", "content": "Question \(t + 1) about \(topic): what matters most here, and why?", "id": "dq\(c)-\(t)", "t": at, "page": page])
                    var answer: [String: Any] = ["role": "assistant", "content": "About \(topic): the main points are the basics, the common mistakes and what to try first.", "id": "da\(c)-\(t)", "t": at + 4000]
                    if (c + t) % 6 == 0 { answer["tags"] = [topic.split(separator: " ").first.map(String.init) ?? "later"] }
                    // 2.6 (97): chat 13 has an answer pinned (the pinned bar over the bar of suggestions).
                    if c == 13, t == 3 { answer["pinned"] = Double(at) }
                    m.append(answer)
                    if t == 1 { m.append(["role": "user", "content": "Remember to come back to \(topic) later", "note": true, "id": "dn\(c)", "t": at + 8000, "page": page]) }
                }
                var object: [String: Any] = ["a": at, "m": m]
                // 2.6 (93): chat 3 comes with organizing's record from "another device" (a name it suggests), shown
                // at once when it opens and counted in the list without asking anything.
                if c == 3, let last = m.last {
                    object["org"] = OrgState(n: m.count, k: Organize.entryKey(last), nm: .init(k: "seeded", t: "Espresso at home, from another device")).json
                }
                // 2.6 (94): chat 4 comes with a merge into chat 14 (same topic) suggested.
                if c == 4, many > 14, let last = m.last {
                    object["org"] = OrgState(n: m.count, k: Organize.entryKey(last), mv: .init(s: 0, e: m.count - 1, to: "debug-many-14", why: .merge, mt: 88)).json
                }
                // 2.6 (97): and suggestions deep in it: two tags and its second page to chat 23 (the same topic). The bar
                // at the top of the chat lists them.
                if c == 13, many > 23, m.count > 10, let last = m.last {
                    object["org"] = OrgState(n: m.count, k: Organize.entryKey(last), mv: .init(s: 2, e: 4, to: "debug-many-23", why: .topic, mt: 86),
                                             tg: [.init(key: Organize.entryKey(m[1]), tag: "coffee"), .init(key: Organize.entryKey(m[10]), tag: "grinders")]).json
                }
                // 2.6 (95): and chat 14, the newer one, shows it too: chat 4 joins it here.
                if c == 14, let last = m.last {
                    object["org"] = OrgState(n: m.count, k: Organize.entryKey(last), mv: .init(s: m.count - 1, e: m.count - 1, to: "debug-many-14", why: .merge, mt: 88, fr: "debug-many-4")).json
                }
                if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
                    saves["debug-many-\(c)"] = ChatMirror.Item(updatedAt: at, data: text)
                }
            }
            _ = ChatMirror.apply(saves: saves)
        }
        // Build 94 (the chats list's rows and "Ask your chats" links): -CFDebugSeedRows YES puts four chats here, one on
        // a watched page (RowMarks.debugWatched), one with a reminder ahead, one whose question was just asked in Safari,
        // and an "Ask your chats" answer that names them.
        if UserDefaults.standard.bool(forKey: "CFDebugSeedRows"), ChatMirror.chats()["debug-row-mug"] == nil {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let page = { (url: String, title: String, at: Int64) -> [String: Any] in ["url": url, "title": title, "at": at] }
            let chats: [String: [String: Any]] = [
                "debug-row-mug": ["title": "Price of the mug", "a": now - 7_000_000, "m": [
                    ["role": "user", "content": "How much is the mug?", "id": "rq1", "t": now - 7_200_000, "page": page("https://shop.example/mug", "ContextFlow mug", now - 7_200_000)],
                    ["role": "assistant", "content": "The mug is €24 and in stock.", "id": "ra1", "t": now - 7_190_000],
                    ["role": "user", "content": "What do the reviews say?", "id": "rq2", "t": now - 7_000_000, "page": page("https://shop.example/mug/reviews", "Reviews", now - 7_000_000)],
                    ["role": "assistant", "content": "People like the size; a few say the print fades.", "id": "ra2", "t": now - 6_990_000]]],
                "debug-row-rome": ["title": "Trip to Rome", "a": now - 5_000_000, "m": [
                    ["role": "user", "content": "What to see in Rome in three days?", "id": "rq3", "t": now - 5_000_000, "page": page("https://rome.example/three-days", "Rome in three days", now - 5_000_000)],
                    ["role": "assistant", "content": "The Colosseum, the Forum, the Vatican, and Trastevere in the evening.", "id": "ra3", "t": now - 4_990_000, "remind": ["at": Double(now + 86_400_000)]]]],
                "debug-row-phones": ["title": "Headphones like Aero 2", "a": now - 10_000, "m": [
                    ["role": "user", "content": "Find similar", "label": "Find similar", "similarAsk": "", "id": "rq4", "t": now - 10_000, "page": page("https://headphones.example/aero-2", "Aero 2", now - 10_000)]]],
                "debug-row-history": ["k": "history", "a": now - 20_000_000, "m": [
                    ["role": "user", "content": "What did I read this week?", "id": "rq5", "t": now - 20_010_000],
                    ["role": "assistant", "content": "**From your chats (3):**\n- **[Trip to Rome](chat:debug-row-rome)**: three days, the Colosseum first\n- **[Price of the mug](chat:debug-row-mug)**: €24, in stock\n- **Headphones like Aero 2**: Find similar is still looking", "id": "ra5", "t": now - 20_000_000]]]
            ]
            var saves: [String: ChatMirror.Item] = [:]
            for (id, object) in chats {
                if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
                    saves[id] = ChatMirror.Item(updatedAt: (object["a"] as? Int64) ?? now, data: text)
                }
            }
            _ = ChatMirror.apply(saves: saves)
        }
        // Build 97 (a note on a selection as a quote with the person's words): -CFDebugSeedNotes YES puts a chat here with a
        // reminder on a selection with words, one without, a page reminder with words, and a note on a selection made
        // before (no cite: its text as it was).
        if UserDefaults.standard.bool(forKey: "CFDebugSeedNotes"), ChatMirror.chats()["debug-notes"] == nil {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let page: [String: Any] = ["url": "https://desk.example/standing-140", "title": "Standing desk 140", "at": now - 3_600_000]
            let object: [String: Any] = ["title": "Standing desk", "a": now - 60_000, "m": [
                ["role": "user", "content": "“Width 140 cm, depth 70 cm, oak top”\n\nMeasure the wall by the window first", "note": true, "quote": true,
                 "cite": "Width 140 cm, depth 70 cm, oak top", "id": "dn1", "t": now - 3_600_000, "page": page,
                 "remind": ["at": Double(now + 86_400_000), "page": true]],
                ["role": "user", "content": "“Delivery in 5–7 working days”", "note": true, "quote": true,
                 "cite": "Delivery in 5–7 working days", "id": "dn2", "t": now - 3_000_000, "page": page],
                ["role": "user", "content": "Ask whether the oak top comes in white", "note": true, "id": "dn3", "t": now - 2_000_000, "page": page,
                 "remind": ["at": Double(now + 3 * 86_400_000), "page": true]],
                ["role": "user", "content": "“Assembly takes about an hour”\n\ntwo people", "note": true, "quote": true, "id": "dn4", "t": now - 60_000, "page": page]]]
            if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
                _ = ChatMirror.apply(saves: ["debug-notes": ChatMirror.Item(updatedAt: now, data: text)])
            }
        }
        // Build 95 (a name taken on another device stayed offered here): -CFDebugRemoteRename <id>
        // -CFDebugRemoteRenameAfter <s>: after so many seconds that chat gets the name its record suggests, as another
        // device that took it writes it (the title, and the record without the suggestion), and the library reloads as
        // after a pull from iCloud.
        if let id = UserDefaults.standard.string(forKey: "CFDebugRemoteRename"), !Self.remoteRenameScheduled {
            Self.remoteRenameScheduled = true
            let after = max(1, UserDefaults.standard.double(forKey: "CFDebugRemoteRenameAfter"))
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                guard let item = ChatMirror.chats()[id], var object = (try? JSONSerialization.jsonObject(with: Data(item.data.utf8))) as? [String: Any],
                      var org = OrgState(object["org"]), let name = org.nm?.t else { return }
                org.nm = OrgState.Name(k: org.nm!.k, t: nil, no: org.nm!.no)
                object["title"] = name
                object["aiTitle"] = name
                object["org"] = org.json
                guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
                _ = ChatMirror.apply(saves: [id: ChatMirror.Item(updatedAt: item.updatedAt + 1, data: text)])
                DebugHangLog.mark("renamed \(id) elsewhere")
                self?.reload()
            }
        }
        // Build 95 (Find similar's cards in the app): -CFDebugSeedSimilar YES puts a real answer here (SimilarDebugSeed).
        if UserDefaults.standard.bool(forKey: "CFDebugSeedSimilar"), ChatMirror.chats()[SimilarDebugSeed.id] == nil,
           var object = (try? JSONSerialization.jsonObject(with: Data(SimilarDebugSeed.json.utf8))) as? [String: Any],
           var m = object["m"] as? [[String: Any]], m.count == 2 {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            m[0]["t"] = now - 60_000
            if var page = m[0]["page"] as? [String: Any] {
                page["at"] = now - 60_000
                m[0]["page"] = page
            }
            m[1]["t"] = now
            if var similar = m[1]["similar"] as? [String: Any] {
                similar["at"] = now
                m[1]["similar"] = similar
            }
            object["m"] = m
            object["a"] = now
            if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
                _ = ChatMirror.apply(saves: [SimilarDebugSeed.id: ChatMirror.Item(updatedAt: now, data: text)])
            }
        }
        // -CFDebugOpenChat <id> -CFDebugOpenAfter <s>: that chat opens after so many seconds (its first answer), as a tap
        // on it would; the hang log has when it was asked for and when it showed.
        if let id = UserDefaults.standard.string(forKey: "CFDebugOpenChat"), !DebugHangLog.openScheduled {
            DebugHangLog.openScheduled = true
            let after = max(1, UserDefaults.standard.double(forKey: "CFDebugOpenAfter"))
            DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                DebugHangLog.mark("request \(id)")
                ChatLinks.shared.pending = (id, id.replacingOccurrences(of: "debug-many-", with: "da") + "-0")
            }
        }
        #endif
        reload()
        guard syncOn else {
            cloud = .off
            return
        }
        cloudTask?.cancel()
        cloudTask = Task { await syncCloud([]) }
        keepPolling()
    }

    /// 2.6 (94): while the app is in front, iCloud is asked every 20 s. A chat renamed on one device kept its old name
    /// on another for minutes: the app asked only at launch, back in front, when its list showed again (never on an
    /// iPad, where the list stays) and after its own changes.
    private func keepPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self else { return }
                if self.syncOn, Self.inFront, Date().timeIntervalSince(self.pulledAt) >= 15 { await self.syncCloud([], quiet: true) }
            }
        }
    }

    /// A chat opened: what iCloud has for it now, unless just asked.
    func pull() async {
        guard syncOn, Date().timeIntervalSince(pulledAt) >= 3 else { return }
        await syncCloud([], quiet: true)
    }

    private static var inFront: Bool {
        #if os(iOS)
        UIApplication.shared.applicationState == .active
        #else
        NSApplication.shared.isActive
        #endif
    }

    /// Waits for the refresh from iCloud (pull to refresh).
    func refreshNow() async {
        refresh()
        await cloudTask?.value
    }

    private func reload() {
        let items = ChatMirror.chats()
        let all = items.compactMap { id, item in ChatThread(id: id, updatedAt: item.updatedAt, data: item.data) }
            .filter { !$0.entries.isEmpty }
        threads = all.filter { !$0.isTrashed }.sorted(by: Self.listOrder)
        trashed = all.filter(\.isTrashed).sorted { a, b in a.trashedAt != b.trashedAt ? a.trashedAt! > b.trashedAt! : a.id < b.id }
        loaded = true
        // No chats left ("Delete all chats" in Safari): the messages' vectors (organizing) go with them, and what was
        // read aloud (2.6) once there had been chats (a page heard with no chats at all keeps its audio).
        let hadChats = UserDefaults.standard.bool(forKey: "cf_listen_had_chats")
        if threads.isEmpty && trashed.isEmpty {
            OrganizeModel.shared.forget()
            if hadChats {
                SpeechCache.clear()
                HeardCover.clear()
                // And from the user's iCloud (2.6), for every device.
                Task.detached(priority: .utility) { await SpeechSync.deleteAll() }
            }
        }
        UserDefaults.standard.set(!threads.isEmpty || !trashed.isEmpty, forKey: "cf_listen_had_chats")
        // 30 days in Recently Deleted: deleted for good, as on any device that sees it first.
        let cutoff = now - Int64(Self.trashDays) * 86_400_000
        let expired = trashed.filter { $0.trashedAt! <= cutoff }
        if !expired.isEmpty { deleteNow(expired) }
    }

    /// Pinned chats first in their order, then the others, the latest first (the extension's order); the same pin or
    /// time, by id: the chats come from a dictionary, in no set order, and the list mustn't change between reloads.
    private static func listOrder(_ a: ChatThread, _ b: ChatThread) -> Bool {
        switch (a.pin, b.pin) {
        case let (x?, y?): return x != y ? x < y : a.id < b.id
        case (.some, nil): return true
        case (nil, .some): return false
        default: return a.lastAt != b.lastAt ? a.lastAt > b.lastAt : a.id < b.id
        }
    }

    /// `quiet`: asked by itself (2.6 (94)), every 20 s or as a chat opens: offline, the Chats screen's note about iCloud
    /// doesn't blink with each ask.
    private func syncCloud(_ changes: [ChatSync.Change], quiet: Bool = false) async {
        if cloud != .ok, !quiet { cloud = .syncing }
        pulledAt = Date()
        let token = UserDefaults.standard.string(forKey: Self.tokenKey)
        do {
            let result = try await ChatSync.sync(token: token, changes: changes)
            guard !Task.isCancelled else { return }
            var saves: [String: ChatMirror.Item] = [:]
            for snapshot in result.changed { saves[snapshot.id] = ChatMirror.Item(updatedAt: snapshot.updatedAt, data: snapshot.data) }
            if ChatMirror.apply(saves: saves, deletes: result.deleted) {
                reload()
                sweepMoved()
            }
            UserDefaults.standard.set(result.token, forKey: Self.tokenKey)
            cloud = .ok
        } catch {
            if !Task.isCancelled, !quiet || cloud != .ok { cloud = .unavailable }
        }
    }

    // MARK: Changes

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Stores a changed chat here, for the extension, and in iCloud.
    /// `soft` (2.6 (94)): a change to organizing's record only, which never replaces a copy another device wrote since
    /// this one (ChatSync.Snapshot `base`).
    private func save(_ thread: ChatThread, title: String??, aiTitle: String?? = nil, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil, org: OrgState?? = nil, soft: Bool = false) {
        // Always later than the copy it replaces, whatever the clocks say.
        let at = max(now, thread.updatedAt + 1)
        guard let item = thread.edited(title: title, aiTitle: aiTitle, pin: pin, tags: tags, entryTags: entryTags, org: org, updatedAt: at) else { return }
        store(thread, item, base: soft ? thread.updatedAt : nil)
    }

    /// What organizing worked out for a chat (2.6 (93), src/content/store.ts `setOrgState`): kept with it, and so on
    /// every device, when it says something new and the chat is still as it was then (a message since: the next run
    /// keeps the new one).
    func keepOrg(_ id: String, _ org: OrgState) {
        guard let current = threads.first(where: { $0.id == id }), current.org != org, org.n == current.entries.count else { return }
        save(current, title: nil, pin: nil, org: .some(org), soft: true)
    }

    /// A suggested name taken or turned down (src/content/store.ts `settleNameSuggestion`): it goes from the chat's
    /// state; turned down, it joins the names never suggested again for it, on any device.
    func settleName(_ id: String, taken: Bool) {
        guard let current = threads.first(where: { $0.id == id }), var org = current.org, let nm = org.nm, let t = nm.t else { return }
        let no = taken ? nm.no : Array((nm.no.filter { $0.lowercased() != t.lowercased() } + [t]).suffix(20))
        // Taken: the check is about the chat under its new name (2.6 (95)), so no device asks again until the chat
        // changes (else taking a name started a check of it, and renames followed one another). The name as nameByAI keeps it.
        let named = String(t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces).prefix(80))
        let key = taken ? current.organized.map { Organize.nameCheckKey($0, title: named) } ?? nm.k : nm.k
        org.nm = OrgState.Name(k: key, t: nil, no: no)
        save(current, title: nil, pin: nil, org: .some(org), soft: taken ? false : true)
    }

    /// A merge into chat `to` turned down (2.6 (94), src/content/store.ts `refuseMerge`): kept with the chat, never
    /// suggested again, on any device.
    func refuseMerge(_ id: String, into to: String) {
        guard let current = threads.first(where: { $0.id == id }) else { return }
        var org = current.org ?? OrgState(n: current.entries.count, k: Organize.lastKey(current.organized?.entries ?? []))
        guard !org.mx.contains(to) else { return }
        org.mx = Array((org.mx + [to]).suffix(20))
        if org.mv?.why == .merge { org.mv = nil }
        save(current, title: nil, pin: nil, org: .some(org), soft: true)
    }

    /// Adds messages at the end of a chat (a question asked in the app and its answer, or a note).
    func append(_ thread: ChatThread, _ entries: [[String: Any]]) {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard let item = current.appending(entries, updatedAt: max(now, current.updatedAt + 1)) else { return }
        store(current, item)
    }

    private func store(_ thread: ChatThread, _ item: ChatMirror.Item, base: Int64? = nil) {
        ChatMirror.apply(saves: [thread.id: item])
        ChatMirror.queue(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data, deleted: nil, at: Double(now), base: base))
        reload()
        if syncOn {
            Task { await syncCloud([.save(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data, base: base))]) }
        }
    }

    /// Names a chat; an empty name goes back to its first question.
    func rename(_ thread: ChatThread, to name: String) {
        let clean = String(name.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces).prefix(80))
        guard clean != (thread.title ?? "") else { return }
        save(thread, title: .some(clean.nilIfEmpty), pin: nil)
    }

    /// The AI's name for a chat (2.6): it becomes its name. By itself (its topic changed) never over a name the user
    /// typed; asked for ("Name by topic"), over any. What the names were before, for Undo (nil: nothing changed).
    func nameByAI(_ thread: ChatThread, _ name: String, asked: Bool = false) -> (title: String?, aiTitle: String?)? {
        let current = threads.first { $0.id == thread.id } ?? thread
        let clean = String(name.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces).prefix(80))
        guard !clean.isEmpty, asked || !current.namedByUser, clean != current.title else { return nil }
        save(current, title: .some(clean), aiTitle: .some(clean), pin: nil)
        return (current.title, current.aiTitle)
    }

    /// Undo for nameByAI: the names as they were, if the chat still has the AI's one.
    func unname(_ id: String, _ name: String, before: (title: String?, aiTitle: String?)) {
        guard let current = threads.first(where: { $0.id == id }), current.title == name else { return }
        save(current, title: .some(before.title), aiTitle: .some(before.aiTitle), pin: nil)
    }

    /// Pins a chat at the top of the list, or unpins it.
    func setPinned(_ thread: ChatThread, _ pinned: Bool) {
        guard pinned != thread.isPinned else { return }
        let top = threads.compactMap(\.pin).min()
        save(thread, title: nil, pin: .some(pinned ? (top.map { $0 - 1 } ?? 0) : nil))
    }

    /// The chat's own tags.
    func setTags(_ thread: ChatThread, _ tags: [String]) {
        let clean = Tags.clean(tags)
        guard clean != thread.ownTags else { return }
        save(thread, title: nil, pin: nil, tags: clean)
    }

    /// The tags of one answer or note of the chat.
    func setTags(_ thread: ChatThread, entry index: Int, _ tags: [String]) {
        let clean = Tags.clean(tags)
        guard thread.entries.indices.contains(index), clean != Tags.clean(thread.entries[index].tags ?? []) else { return }
        save(thread, title: nil, pin: nil, entryTags: (index, clean))
    }

    /// Every tag in use, the most used first.
    var allTags: [String] {
        var counts: [String: (tag: String, count: Int)] = [:]
        for thread in threads {
            for tag in thread.tags { counts[tag.lowercased(), default: (tag, 0)].count += 1 }
        }
        return counts.values.sorted { $0.count != $1.count ? $0.count > $1.count : $0.tag.localizedCompare($1.tag) == .orderedAscending }.map(\.tag)
    }

    /// The chat list in groups by tag, like folders (the extension's setting, shared with the app).
    var groupByTags: Bool {
        get { SharedDefaults.shared.readSettings()?.settings["groupByTags"] as? Bool ?? false }
        set {
            var stored = SharedDefaults.shared.readSettings()?.settings ?? [:]
            stored["groupByTags"] = newValue
            SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
            objectWillChange.send()
        }
    }

    // MARK: Organizing (2.5)

    /// Moves messages `start`…`end` of a chat (a page block) to another chat, or to a new one (nil), as
    /// the Safari panel does (Organize.swift). Returns what "Undo" needs.
    @discardableResult
    func move(_ thread: ChatThread, _ start: Int, _ end: Int, to targetId: String?) -> Organize.MoveUndo? {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard let source = current.organized else { return nil }
        let target = targetId.flatMap { id in threads.first { $0.id == id } }?.organized
        if targetId != nil, target == nil { return nil }
        let id = targetId ?? UUID().uuidString.lowercased()
        guard let moved = Organize.move(source: source, start: start, end: end, target: target, targetId: id, now: now) else { return nil }
        storeOrganized(saves: [moved.target] + (moved.source.map { [$0] } ?? []), deletes: moved.source == nil ? [source.id] : [])
        return moved.undo
    }

    /// "Undo" on the bar after a move.
    func undo(_ undo: Organize.MoveUndo) {
        let source = threads.first { $0.id == undo.source }?.organized
        let target = threads.first { $0.id == undo.target }?.organized
        guard let back = Organize.undo(undo, source: source, target: target, now: now) else { return }
        storeOrganized(saves: [back.source] + (back.target.map { [$0] } ?? []), deletes: back.target == nil ? [undo.target] : [])
    }

    /// After iCloud brought chats: a moved message the chat it came from got back (from a device that hadn't
    /// heard of the move, or one still on 2.4) is removed there again.
    private func sweepMoved() {
        // Recently Deleted's chats too: one may hold a stale copy of a moved message.
        let swept = Organize.sweep((threads + trashed).compactMap(\.organized), now: now)
        guard !swept.changed.isEmpty || !swept.emptied.isEmpty else { return }
        storeOrganized(saves: swept.changed, deletes: swept.emptied)
    }

    /// Changes messages of a chat as stored (organizing: a suggestion turned down, a suggested tag taken), keeping
    /// every other field; the chat keeps its place in the list.
    func editEntries(_ thread: ChatThread, _ change: (inout [[String: Any]]) -> Void) {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard var organized = current.organized else { return }
        var entries = organized.entries
        change(&entries)
        organized = organized.with(u: max(now, current.updatedAt + 1), a: organized.activity, m: entries)
        storeOrganized(saves: [organized], deletes: [])
    }

    /// Stores organized chats here, for the extension and in iCloud, and drops the emptied ones.
    private func storeOrganized(saves: [OrganizeThread], deletes: [String]) {
        var items: [String: ChatMirror.Item] = [:]
        for thread in saves {
            guard let json = try? JSONSerialization.data(withJSONObject: thread.object), let data = String(data: json, encoding: .utf8) else { continue }
            items[thread.id] = ChatMirror.Item(updatedAt: thread.u, data: data)
        }
        ChatMirror.apply(saves: items, deletes: deletes)
        for (id, item) in items { ChatMirror.queue(.init(id: id, updatedAt: item.updatedAt, data: item.data, deleted: nil, at: Double(now))) }
        for id in deletes { ChatMirror.queue(.init(id: id, updatedAt: nil, data: nil, deleted: true, at: Double(now))) }
        reload()
        if syncOn {
            let changes = items.map { ChatSync.Change.save(.init(id: $0.key, updatedAt: $0.value.updatedAt, data: $0.value.data)) } + deletes.map { ChatSync.Change.delete($0) }
            Task { await syncCloud(changes) }
        }
    }

    // MARK: Recently Deleted (2.5 (83), the owner: «надо сделать … Trash, где до 30 дней пусть хранятся удаленные чаты»)

    /// Deleting a chat (a swipe, its menu, Delete in the chat) moves it to Recently Deleted: `trashed` in its JSON, its
    /// time bumped like any edit, so the extension and iCloud take it to the other devices. Its place by last message
    /// stays; its reminders here are off until it's restored.
    func trash(_ thread: ChatThread) {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard !current.isTrashed else { return }
        let at = max(now, current.updatedAt + 1)
        guard let item = current.edited(title: nil, pin: nil, trashed: .some(at), updatedAt: at) else { return }
        pauseReminders(current)
        store(current, item)
    }

    /// Back from Recently Deleted, to its place by its last real message (not to the top: the owner hates chats
    /// jumping), its reminders set here on again.
    func restore(_ thread: ChatThread) {
        let current = trashed.first { $0.id == thread.id } ?? thread
        guard current.isTrashed, let item = current.edited(title: nil, pin: nil, trashed: .some(nil), updatedAt: max(now, current.updatedAt + 1)) else { return }
        store(current, item)
        if let back = threads.first(where: { $0.id == current.id }) { resumeReminders(back) }
    }

    /// Delete Now, Delete All, and 30 days in Recently Deleted: deleted for good, here, for the extension and in
    /// iCloud (the usual deletion, as "Delete" was before 2.5 (83)).
    func deleteNow(_ gone: [ChatThread]) {
        guard !gone.isEmpty else { return }
        let ids = gone.map(\.id)
        ChatMirror.apply(saves: [:], deletes: ids)
        for id in ids { ChatMirror.queue(.init(id: id, updatedAt: nil, data: nil, deleted: true, at: Double(now))) }
        reload()
        if syncOn {
            Task { await syncCloud(ids.map { .delete($0) }) }
        }
    }

    // MARK: Safari

    // MARK: Ask your chats

    /// Stores an "Ask your chats" chat (questions and answers only) here, for the extension and in iCloud.
    func saveHistory(id: String, messages: [[String: String]]) {
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        let previous = threads.first { $0.id == id }
        // The stored JSON with the new messages: its name, pin, tags and the fields a newer version wrote stay.
        var object = previous.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.data.utf8))) as? [String: Any] } ?? [:]
        object["k"] = "history"
        object["a"] = at
        object["m"] = messages
        object.removeValue(forKey: "trashed")
        guard let json = try? JSONSerialization.data(withJSONObject: object), let data = String(data: json, encoding: .utf8) else { return }
        let updatedAt = max(at, (previous?.updatedAt ?? 0) + 1)
        ChatMirror.apply(saves: [id: ChatMirror.Item(updatedAt: updatedAt, data: data)])
        ChatMirror.queue(.init(id: id, updatedAt: updatedAt, data: data, deleted: nil, at: Double(at)))
        reload()
        if syncOn {
            Task { await syncCloud([.save(.init(id: id, updatedAt: updatedAt, data: data))]) }
        }
    }

    /// Opens a page of a chat in Safari (not another default browser). 2.6 (98), the owner: «Если новая страница
    /// открывается по клику/тапу в расширении или приложении - надо чтобы сайдбар открывался там сразу и на том чате и
    /// месте, где кликнули на страницу»: with `chat` (and `at`, its message: the id, else "i<index>") the page opens with
    /// the panel on that chat, at that message (SimilarAway.pageOpening).
    func open(_ url: String, chat: String? = nil, at: String? = nil) {
        guard var link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") else { return }
        if let chat { link = SimilarAway.pageOpening(link, thread: chat, at: at, mark: "cf-chat") }
        let address = link.absoluteString
        #if os(iOS)
        if #available(iOS 17, *), let safari = URL(string: "x-safari-\(address)") {
            UIApplication.shared.open(safari) { opened in
                if !opened { UIApplication.shared.open(link) }
            }
        } else {
            UIApplication.shared.open(link)
        }
        #else
        if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
            NSWorkspace.shared.open([link], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(link)
        }
        #endif
    }

    /// Opens the chat's last page in Safari and has the panel continue this chat there.
    func continueInSafari(_ thread: ChatThread) {
        guard let page = thread.lastPage else { return }
        ChatMirror.requestOpen(thread.id)
        open(page.url)
    }
}

// MARK: - Search

/// Chats with every word of a query (in the name, messages, notes or page titles), as in the Safari
/// panel (src/shared/threads.ts `searchThreads`): case and accents ignored, chats named after it first.
enum ChatSearch {
    struct Hit: Hashable {
        /// The message's index in the chat, or nil for a page it was on.
        let index: Int?
        let excerpt: AttributedString
    }

    struct Result: Identifiable {
        let thread: ChatThread
        let hits: [Hit]
        var id: String { thread.id }
    }

    private static let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]

    /// The query's words; quotes keep a phrase together.
    static func words(_ query: String) -> [String] {
        var out: [String] = []
        let pattern = try? NSRegularExpression(pattern: #""([^"]+)"|(\S+)"#)
        let text = query as NSString
        for match in pattern?.matches(in: query, range: NSRange(location: 0, length: text.length)) ?? [] {
            let range = match.range(at: 1).location != NSNotFound ? match.range(at: 1) : match.range(at: 2)
            let word = text.substring(with: range).trimmingCharacters(in: .whitespaces)
            if !word.isEmpty { out.append(word) }
        }
        return out
    }

    static func search(_ threads: [ChatThread], _ query: String, maxHits: Int = 2) -> [Result] {
        let words = words(query)
        guard !words.isEmpty else { return [] }
        var scored: [(Result, Int)] = []
        for thread in threads {
            let name = thread.name
            var fields: [(index: Int?, text: String)] = thread.entries.enumerated().map { index, entry in
                (index, plain(entry.label.map { "\($0) \(entry.content)" } ?? entry.content))
            }
            fields += thread.pages.map { (nil, "\($0.title) \($0.url)") }
            let all = [name] + fields.map(\.text)
            guard words.allSatisfy({ word in all.contains { $0.range(of: word, options: options) != nil } }) else { continue }
            let named = words.filter { name.range(of: $0, options: options) != nil }.count
            var together = words.count == named
            var hits: [Hit] = []
            for field in fields {
                let present = words.filter { field.text.range(of: $0, options: options) != nil }
                guard !present.isEmpty else { continue }
                if present.count == words.count { together = true }
                // The first question is already the chat's name in the list.
                if hits.count < maxHits, oneLine(field.text) != name {
                    hits.append(Hit(index: field.index, excerpt: excerpt(field.text, present)))
                }
            }
            scored.append((Result(thread: thread, hits: hits), named * 100 + (together ? 10 : 0)))
        }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.thread.lastAt > $1.0.thread.lastAt }.map(\.0)
    }

    private static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: #"\s*\[\d{1,2}\]\(https?:[^)\s]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#>|]+"#, with: "", options: .regularExpression)
    }

    private static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    /// About 120 characters around the first matched word, the words highlighted.
    private static func excerpt(_ text: String, _ words: [String], size: Int = 120) -> AttributedString {
        let line = oneLine(text)
        let first = words.compactMap { line.range(of: $0, options: options)?.lowerBound }.min() ?? line.startIndex
        let offset = line.distance(from: line.startIndex, to: first)
        let from = max(0, min(offset - size / 3, line.count - size))
        let start = line.index(line.startIndex, offsetBy: from)
        let end = line.index(start, offsetBy: min(size, line.distance(from: start, to: line.endIndex)))
        var piece = (from > 0 ? "…" : "") + line[start..<end] + (end < line.endIndex ? "…" : "")
        piece = piece.replacingOccurrences(of: "\n", with: " ")
        var out = AttributedString(piece)
        for word in words {
            var search = piece.startIndex..<piece.endIndex
            while let range = piece.range(of: word, options: options, range: search) {
                if let lower = AttributedString.Index(range.lowerBound, within: out), let upper = AttributedString.Index(range.upperBound, within: out) {
                    out[lower..<upper].backgroundColor = .yellow.opacity(0.35)
                    out[lower..<upper].foregroundColor = .primary
                }
                search = range.upperBound..<piece.endIndex
            }
        }
        return out
    }
}

// MARK: - Tags

/// Tags as the extension keeps them (src/shared/threads.ts): no leading #, one space between words,
/// at most 24 characters, no repeats whatever the case, at most 8.
enum Tags {
    static func clean(_ tag: String) -> String {
        var text = tag.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        while text.hasPrefix("#") { text.removeFirst() }
        return String(text.trimmingCharacters(in: .whitespaces).prefix(24)).trimmingCharacters(in: .whitespaces)
    }

    static func clean(_ tags: [String]) -> [String] {
        var out: [String] = []
        for raw in tags {
            let tag = clean(raw)
            if !tag.isEmpty, !out.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { out.append(tag) }
        }
        return Array(out.prefix(8))
    }

    /// One of 8 colours, the same as in Safari for the same name.
    static func color(_ tag: String) -> Color {
        var hash: UInt32 = 0
        for scalar in tag.lowercased().unicodeScalars { hash = hash &* 31 &+ scalar.value }
        let palette: [(Double, Double, Double)] = [(37, 99, 235), (13, 148, 136), (202, 138, 4), (219, 39, 119), (124, 58, 237), (22, 163, 74), (234, 88, 12), (71, 85, 105)]
        let c = palette[Int(hash % 8)]
        return Color(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255)
    }
}
