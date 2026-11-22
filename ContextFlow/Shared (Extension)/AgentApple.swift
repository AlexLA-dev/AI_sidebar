import EventKit
import Foundation

/// The agent's Calendar and Reminders (2.7.1, the owner: «Календарь и напоминания для агента делаем в 2.7.1»; design in
/// ~/ContextFlow-work/agent-28/design-calendar.md). Run on the device by the extension's handler; the extension can't
/// ask for access, the app does (AppleItems.askFull).
/// - Reminders: the lists (with their open count) and the open reminders that match the task's words or a list, all of
///   the person's lists, shared ones and ones others made included; at most 25 of them, title, list and due date, never
///   the notes. A new reminder (never a second open one of the same title in that list), one marked done.
/// - Calendar: free times worked out here from every calendar (only the times leave the device, never an event's
///   title), whether a given time is free, and a new event in the default calendar.
/// What leaves the device goes in the agent's next step and isn't kept by our server.
enum AgentApple {
    static let maxItems = 25

    // MARK: - Access

    /// "yes": readable and writable; "none": not asked yet (the app asks); "denied": Settings; "unavailable": too old.
    static func access(_ entity: EKEntityType) -> String {
        guard #available(iOS 17.0, macOS 14.0, *) else { return "unavailable" }
        switch EKEventStore.authorizationStatus(for: entity) {
        case .fullAccess: return "yes"
        case .notDetermined: return "none"
        case .writeOnly: return entity == .event ? "none" : "denied"
        default: return "denied"
        }
    }

    static func status() -> [String: Any] {
        ["reminders": access(.reminder), "calendar": access(.event)]
    }

    // MARK: - Reminders

    private static func reminders(_ store: EKEventStore, in calendars: [EKCalendar]?) async -> [EKReminder] {
        await withCheckedContinuation { done in
            let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
            store.fetchReminders(matching: predicate) { done.resume(returning: $0 ?? []) }
        }
    }

    private static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// Words of the query (two letters and more), matched against the start of a title's words; a list by its name.
    static func find(query: String, list: String) async -> [String: Any] {
        guard access(.reminder) == "yes" else { return ["access": access(.reminder)] }
        let store = EKEventStore()
        let all = store.calendars(for: .reminder)
        let open = await reminders(store, in: nil)
        var counts: [String: Int] = [:]
        for r in open { counts[r.calendar.calendarIdentifier, default: 0] += 1 }
        let lists: [[String: Any]] = all.prefix(40).map { ["name": $0.title, "open": counts[$0.calendarIdentifier] ?? 0] }
        let wantedList = fold(list.trimmingCharacters(in: .whitespaces))
        let inList = wantedList.isEmpty ? nil : all.first { fold($0.title) == wantedList } ?? all.first { fold($0.title).contains(wantedList) }
        let words = fold(query).split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count >= 2 }
        var found: [EKReminder] = []
        if inList != nil || !words.isEmpty {
            found = open.filter { r in
                if let inList, r.calendar.calendarIdentifier != inList.calendarIdentifier { return false }
                if words.isEmpty { return true }
                let title = fold(r.title ?? "").split { !$0.isLetter && !$0.isNumber }.map(String.init)
                return words.contains { w in title.contains { $0.hasPrefix(w) || (w.count >= 4 && $0.hasPrefix(String(w.prefix(w.count - 1)))) } }
            }
            found.sort { ($0.dueDateComponents?.date ?? .distantFuture) < ($1.dueDateComponents?.date ?? .distantFuture) }
        }
        var out: [String: Any] = [
            "access": "yes",
            "lists": lists,
            "items": found.prefix(maxItems).map(item)
        ]
        if let d = store.defaultCalendarForNewReminders() { out["defaultList"] = d.title }
        if !wantedList.isEmpty && inList == nil { out["noList"] = list }
        if found.count > maxItems { out["more"] = found.count - maxItems }
        return out
    }

    private static func item(_ r: EKReminder) -> [String: Any] {
        var d: [String: Any] = ["ref": r.calendarItemIdentifier, "title": String((r.title ?? "").prefix(200)), "list": r.calendar.title]
        if let due = r.dueDateComponents {
            d["due"] = String(format: "%04d-%02d-%02d", due.year ?? 0, due.month ?? 0, due.day ?? 0) + (due.hour.map { String(format: " %02d:%02d", $0, due.minute ?? 0) } ?? "")
        }
        return d
    }

    /// A new reminder in `list` (by name; the default list when none fits). An open one of the same title in that list
    /// is left as it is: "exists". `noAlarm`: due, without its own alert (a deferred task rings with our notification).
    static func add(title: String, list: String, date: String, time: String, notes: String = "", key: String? = nil, noAlarm: Bool = false) async -> [String: Any] {
        guard access(.reminder) == "yes" else { return ["access": access(.reminder)] }
        let store = EKEventStore()
        let wanted = fold(list.trimmingCharacters(in: .whitespaces))
        let writable = store.calendars(for: .reminder).filter { $0.allowsContentModifications }
        let calendar = (wanted.isEmpty ? nil : writable.first { fold($0.title) == wanted } ?? writable.first { fold($0.title).contains(wanted) }) ?? store.defaultCalendarForNewReminders()
        guard let calendar else { return ["outcome": "failed"] }
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return ["outcome": "failed"] }
        if let same = await reminders(store, in: [calendar]).first(where: { fold($0.title ?? "") == fold(clean) }) {
            return ["outcome": "exists", "ref": same.calendarItemIdentifier, "list": calendar.title]
        }
        var item = AppleItems.Item(kind: .reminder, title: clean)
        item.date = date
        item.time = time
        item.notes = notes
        item.list = calendar.calendarIdentifier
        item.noAlarm = noAlarm
        do {
            _ = try AppleItems.save(item, key: key, store: store)
            return ["outcome": "saved", "list": calendar.title]
        } catch {
            AppleItems.log("agent reminder failed: \(error)")
            return ["outcome": "failed"]
        }
    }

    static func complete(ref: String) -> [String: Any] {
        guard access(.reminder) == "yes" else { return ["access": access(.reminder)] }
        let store = EKEventStore()
        guard let r = store.calendarItem(withIdentifier: ref) as? EKReminder else { return ["outcome": "missing"] }
        if r.isCompleted { return ["outcome": "saved", "title": r.title ?? ""] }
        r.isCompleted = true
        do {
            try store.save(r, commit: true)
            return ["outcome": "saved", "title": r.title ?? ""]
        } catch {
            return ["outcome": "failed"]
        }
    }

    // MARK: - Calendar

    private static func day(_ date: String) -> Date? {
        AppleItems.Item.components(date, "", zone: .current).flatMap { Calendar.current.date(from: $0) }
    }

    private static func minutes(_ time: String) -> Int? {
        let t = time.split(separator: ":").compactMap { Int($0) }
        guard t.count == 2, (0...24).contains(t[0]), (0...59).contains(t[1]) else { return nil }
        return t[0] * 60 + t[1]
    }

    /// Free times of `length` minutes from `date` on, for `days` days, each day between `from` and `until` (by default
    /// 08:00–21:00): up to 5, the earliest first. With `from` and `until` that hold exactly one such time: free or busy.
    /// `pad` minutes are kept free around each event (a booking's rule, 2.7.1: time to get there), `padPlace` around one
    /// that has a place. Only times leave here, never an event's title or place.
    static func free(date: String, from: String, until: String, length: Int, days: Int, pad: Int = 0, padPlace: Int = 0) -> [String: Any] {
        guard access(.event) == "yes" else { return ["access": access(.event)] }
        guard let first = day(date) else { return ["error": "date"] }
        let span = max(1, min(days, 14))
        let len = max(5, min(length, 12 * 60))
        let start = minutes(from) ?? 8 * 60
        let end = max(start + len, minutes(until) ?? 21 * 60)
        let cal = Calendar.current
        let store = EKEventStore()
        let last = cal.date(byAdding: .day, value: span, to: first)!
        let busy = store.events(matching: store.predicateForEvents(withStart: first, end: last, calendars: nil))
            .filter { !$0.isAllDay && $0.availability != .free && $0.status != .canceled }
            .map { e -> (Date, Date) in
                let p = Double(max(0, min(240, (e.location ?? "").isEmpty ? pad : max(pad, padPlace))) * 60)
                return (e.startDate!.addingTimeInterval(-p), e.endDate!.addingTimeInterval(p))
            }
            .sorted { $0.0 < $1.0 }
        let now = Date()
        let fmt = { (d: Date) -> String in
            let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
            return String(format: "%04d-%02d-%02d %02d:%02d", c.year!, c.month!, c.day!, c.hour!, c.minute!)
        }
        // One exact time asked: whether it's free.
        if minutes(from) != nil && minutes(until) != nil && end - start <= len {
            let a = cal.date(byAdding: .minute, value: start, to: first)!
            let b = cal.date(byAdding: .minute, value: end, to: first)!
            let n = busy.filter { $0.0 < b && $0.1 > a }.count
            return ["access": "yes", "exact": true, "free": n == 0, "busy": n, "from": fmt(a), "until": fmt(b)]
        }
        var slots: [[String: String]] = []
        for i in 0..<span where slots.count < 5 {
            let base = cal.date(byAdding: .day, value: i, to: first)!
            var cursor = cal.date(byAdding: .minute, value: start, to: base)!
            let close = cal.date(byAdding: .minute, value: end, to: base)!
            if cursor < now {
                // Today: from the next quarter hour.
                let q = cal.dateComponents([.minute], from: now).minute ?? 0
                cursor = cal.date(byAdding: .minute, value: (15 - q % 15) % 15, to: now)!
                cursor = cal.date(bySetting: .second, value: 0, of: cursor) ?? cursor
            }
            for (bs, be) in busy where be > cursor && bs < close {
                if bs.timeIntervalSince(cursor) >= Double(len * 60) {
                    slots.append(["from": fmt(cursor), "until": fmt(bs)])
                    if slots.count >= 5 { break }
                }
                cursor = max(cursor, be)
            }
            if slots.count < 5 && close.timeIntervalSince(cursor) >= Double(len * 60) {
                slots.append(["from": fmt(cursor), "until": fmt(close)])
            }
        }
        return ["access": "yes", "free": slots]
    }

    static func addEvent(title: String, date: String, time: String, length: Int, place: String, url: String = "") -> [String: Any] {
        let status = access(.event)
        // Write-only access (a Mac that gave it for «В Календарь») is enough to add one.
        let canWrite: Bool = {
            guard #available(iOS 17.0, macOS 14.0, *) else { return false }
            let s = EKEventStore.authorizationStatus(for: .event)
            return s == .fullAccess || s == .writeOnly
        }()
        guard canWrite else { return ["access": status] }
        var item = AppleItems.Item(kind: .event, title: title.trimmingCharacters(in: .whitespacesAndNewlines))
        item.date = date
        item.time = time
        item.location = place
        item.url = url
        if let s = item.start, !time.isEmpty {
            let end = s.addingTimeInterval(Double(max(5, min(length > 0 ? length : 60, 24 * 60)) * 60))
            let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: end)
            item.endDate = String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
            item.endTime = String(format: "%02d:%02d", c.hour!, c.minute!)
        }
        guard !item.title.isEmpty, item.start != nil else { return ["outcome": "failed"] }
        do {
            let place = try AppleItems.save(item)
            return ["outcome": "saved", "calendar": place]
        } catch {
            AppleItems.log("agent event failed: \(error)")
            return ["outcome": "failed"]
        }
    }

    // MARK: - The handler's commands

    static func handle(_ message: [String: Any]) async -> [String: Any] {
        let s = { (key: String, max: Int) in String((message[key] as? String ?? "").prefix(max)) }
        let n = { (key: String) in (message[key] as? NSNumber)?.intValue ?? 0 }
        switch s("op", 20) {
        case "status": return status()
        case "reminders": return await find(query: s("query", 200), list: s("list", 120))
        case "reminder_add": return await add(title: s("title", 200), list: s("list", 120), date: s("date", 10), time: s("time", 5), notes: s("notes", 1000), key: (message["key"] as? String).map { String($0.prefix(200)) }, noAlarm: message["noAlarm"] as? Bool ?? false)
        case "reminder_done": return complete(ref: s("ref", 200))
        case "calendar": return free(date: s("date", 10), from: s("time", 5), until: s("until", 5), length: n("minutes"), days: n("days"), pad: n("pad"), padPlace: n("padPlace"))
        case "event_add": return addEvent(title: s("title", 200), date: s("date", 10), time: s("time", 5), length: n("minutes"), place: s("place", 200), url: s("url", 500))
        default: return ["error": "op"]
        }
    }
}
