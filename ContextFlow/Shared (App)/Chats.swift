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

    private struct Stored: Decodable {
        var title: String?
        var ait: String?
        var a: Int64?
        var pin: Double?
        var k: String?
        var tags: [String]?
        var trashed: Double?
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
        let plain = last.content
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
    func edited(title: String??, aiTitle: String?? = nil, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil, trashed: Int64?? = nil, updatedAt: Int64) -> ChatMirror.Item? {
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
        var out = replace(text, #"[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)"#, "")
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
                    m.append(answer)
                    if t == 1 { m.append(["role": "user", "content": "Remember to come back to \(topic) later", "note": true, "id": "dn\(c)", "t": at + 8000, "page": page]) }
                }
                if let data = try? JSONSerialization.data(withJSONObject: ["a": at, "m": m] as [String: Any]), let text = String(data: data, encoding: .utf8) {
                    saves["debug-many-\(c)"] = ChatMirror.Item(updatedAt: at, data: text)
                }
            }
            _ = ChatMirror.apply(saves: saves)
        }
        #endif
        reload()
        guard syncOn else {
            cloud = .off
            return
        }
        cloudTask?.cancel()
        cloudTask = Task { await syncCloud([]) }
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

    private func syncCloud(_ changes: [ChatSync.Change]) async {
        if cloud != .ok { cloud = .syncing }
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
            if !Task.isCancelled { cloud = .unavailable }
        }
    }

    // MARK: Changes

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Stores a changed chat here, for the extension, and in iCloud.
    private func save(_ thread: ChatThread, title: String??, aiTitle: String?? = nil, pin: Double??, tags: [String]? = nil, entryTags: (index: Int, tags: [String])? = nil) {
        // Always later than the copy it replaces, whatever the clocks say.
        let at = max(now, thread.updatedAt + 1)
        guard let item = thread.edited(title: title, aiTitle: aiTitle, pin: pin, tags: tags, entryTags: entryTags, updatedAt: at) else { return }
        store(thread, item)
    }

    /// Adds messages at the end of a chat (a question asked in the app and its answer, or a note).
    func append(_ thread: ChatThread, _ entries: [[String: Any]]) {
        let current = threads.first { $0.id == thread.id } ?? thread
        guard let item = current.appending(entries, updatedAt: max(now, current.updatedAt + 1)) else { return }
        store(current, item)
    }

    private func store(_ thread: ChatThread, _ item: ChatMirror.Item) {
        ChatMirror.apply(saves: [thread.id: item])
        ChatMirror.queue(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data, deleted: nil, at: Double(now)))
        reload()
        if syncOn {
            Task { await syncCloud([.save(.init(id: thread.id, updatedAt: item.updatedAt, data: item.data))]) }
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

    /// Opens a page of a chat in Safari (not another default browser).
    func open(_ url: String) {
        guard let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") else { return }
        #if os(iOS)
        if #available(iOS 17, *), let safari = URL(string: "x-safari-\(url)") {
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
