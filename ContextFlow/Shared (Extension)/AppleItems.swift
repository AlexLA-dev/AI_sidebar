import EventKit
import Foundation

/// Calendar and Reminders (2.7, plan section 3; src/shared/appleItems.ts on the panel's side). Written on the device
/// through EventKit, by the extension's handler when access is already given, else by the app: an extension can't show
/// the system's question. Nothing here reaches our server, and nothing is read from Calendar or Reminders but the
/// reminder lists' names (with full access, for the card) and the items we wrote ourselves (to move or take back).
/// - Reminders need full access (there is no write-only access for them).
/// - Events: on iPhone and iPad the app opens the system's event editor, which needs no access; on a Mac, write-only
///   access (and the Calendars entitlement).
/// Free for everyone; iOS 17 and macOS 14 and later only (the owner: not on iOS 16 and macOS 13).
enum AppleItems {
    static let groupId = "group.com.contextflow.shared"
    /// A request handed from the extension to the app (contextflow://add?id=…), by its id.
    private static let requestsKey = "cf_apple_requests"
    /// «Также в Напоминания»: our reminder's key (chat and message) → the Apple reminder it made on this device.
    private static let keysKey = "cf_apple_keys"

    /// «Также в Напоминания» on or off in the app's Remind sheet (its own defaults; the panel keeps its own choice).
    static let alsoKey = "cf_also_reminders"

    /// A moment's wall-clock date and time on this device ("2026-11-14", "09:00").
    static func wall(_ at: Date) -> (date: String, time: String) {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: at)
        return (String(format: "%04d-%02d-%02d", c.year ?? 2000, c.month ?? 1, c.day ?? 1), String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0))
    }

    static var available: Bool {
        if #available(iOS 17.0, macOS 14.0, *) { return true }
        return false
    }

    #if os(iOS)
    static let platform = "ios"
    #else
    static let platform = "macos"
    #endif

    // MARK: - Access

    enum Access: String {
        /// Reminders: full access. Events: write-only or full access.
        case write
        /// Not asked yet: only the app can ask.
        case none
        /// Turned down (or not allowed on this device): Settings.
        case denied
        /// Events on iPhone and iPad: the system's editor in the app, which needs no access.
        case editor
    }

    static func access(_ kind: Item.Kind) -> Access {
        guard #available(iOS 17.0, macOS 14.0, *) else { return .denied }
        let status = EKEventStore.authorizationStatus(for: kind == .reminder ? .reminder : .event)
        switch status {
        case .fullAccess: return .write
        case .writeOnly: return kind == .event ? .write : .none
        case .notDetermined:
            #if os(iOS)
            return kind == .event ? .editor : .none
            #else
            return .none
            #endif
        default:
            #if os(iOS)
            return kind == .event ? .editor : .denied
            #else
            return .denied
            #endif
        }
    }

    /// For the panel: whether it can add here, how, and the reminder lists (only with full access to Reminders).
    static func status() -> [String: Any] {
        guard available else { return ["available": false] }
        var out: [String: Any] = ["available": true, "platform": platform,
                                  "reminders": access(.reminder).rawValue, "events": access(.event).rawValue]
        if access(.reminder) == .write {
            let store = EKEventStore()
            let lists = store.calendars(for: .reminder).filter { $0.allowsContentModifications }
            out["lists"] = lists.prefix(30).map { ["id": $0.calendarIdentifier, "title": $0.title] }
            if let list = store.defaultCalendarForNewReminders() { out["defaultList"] = list.calendarIdentifier }
        }
        return out
    }

    /// The system's question, from the app only: full access to Reminders, write-only access to Calendar.
    static func ask(_ kind: Item.Kind) async -> Bool {
        guard #available(iOS 17.0, macOS 14.0, *) else { return false }
        let store = EKEventStore()
        do {
            return kind == .reminder ? try await store.requestFullAccessToReminders() : try await store.requestWriteOnlyAccessToEvents()
        } catch {
            log("ask \(kind.rawValue) failed: \(error)")
            return false
        }
    }

    // MARK: - What to add

    struct Item {
        enum Kind: String { case reminder, event }
        var kind: Kind
        var title: String
        /// The item's notes, the page and the chat link already in them (the panel's itemNotes).
        var notes: String = ""
        var url: String = ""
        var date: String = ""
        var time: String = ""
        var endDate: String = ""
        var endTime: String = ""
        var tz: String = ""
        var location: String = ""
        /// A reminder list chosen in the card (its calendarIdentifier); the default list otherwise.
        var list: String = ""

        init(kind: Kind, title: String) {
            self.kind = kind
            self.title = title
        }

        init?(_ d: [String: Any]) {
            guard let kind = Kind(rawValue: d["kind"] as? String ?? ""),
                  let title = (d["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return nil }
            self.kind = kind
            self.title = String(title.prefix(200))
            let s = { (key: String, max: Int) in String((d[key] as? String ?? "").prefix(max)) }
            notes = s("notes", 2_000)
            url = s("url", 2_000)
            date = s("date", 10)
            time = s("time", 5)
            endDate = s("endDate", 10)
            endTime = s("endTime", 5)
            tz = s("tz", 64)
            location = s("location", 200)
            list = s("list", 200)
            if kind == .event && start == nil { return nil }
        }

        var dictionary: [String: Any] {
            ["kind": kind.rawValue, "title": title, "notes": notes, "url": url, "date": date, "time": time,
             "endDate": endDate, "endTime": endTime, "tz": tz, "location": location, "list": list]
        }

        var zone: TimeZone { tz.isEmpty ? .current : TimeZone(identifier: tz) ?? .current }

        /// The wall-clock date and time as components, in the item's zone when it has a time.
        static func components(_ date: String, _ time: String, zone: TimeZone) -> DateComponents? {
            let d = date.split(separator: "-").compactMap { Int($0) }
            guard d.count == 3 else { return nil }
            var c = DateComponents(year: d[0], month: d[1], day: d[2])
            let t = time.split(separator: ":").compactMap { Int($0) }
            if t.count == 2 {
                c.hour = t[0]
                c.minute = t[1]
                c.timeZone = zone
            }
            return c
        }

        /// When it starts: the date and time in its zone (the system's calendar settles a time the clocks skip).
        var start: Date? {
            guard let c = Self.components(date, time, zone: zone) else { return nil }
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = c.timeZone ?? .current
            return cal.date(from: c)
        }

        var end: Date? {
            guard !endDate.isEmpty, let c = Self.components(endDate, endTime, zone: zone) else { return nil }
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = c.timeZone ?? .current
            return cal.date(from: c)
        }
    }

    enum Outcome: String {
        case saved
        /// Handed to the app (contextflow://add?id=…): it asks for access or shows the editor.
        case app
        case denied
        case failed
        case unavailable
        /// No access yet and the app wasn't opened (iPhone: the panel opens it during the tap).
        case notAsked = "not-asked"
    }

    // MARK: - Writing

    /// Writes the item (access must be given). `key`: «Также в Напоминания» — the reminder made before for the same
    /// key is moved instead of a second one being made. Returns where it went (the list's or calendar's name).
    @discardableResult
    static func save(_ item: Item, key: String? = nil, store: EKEventStore = EKEventStore()) throws -> String {
        switch item.kind {
        case .reminder:
            let reminder = key.flatMap { existingReminder($0, store: store) } ?? EKReminder(eventStore: store)
            reminder.title = item.title
            reminder.notes = item.notes.isEmpty ? nil : item.notes
            if reminder.calendar == nil || !item.list.isEmpty {
                reminder.calendar = (item.list.isEmpty ? nil : store.calendar(withIdentifier: item.list)) ?? store.defaultCalendarForNewReminders()
            }
            guard reminder.calendar != nil else { throw EKError(.calendarDoesNotAllowReminders) }
            if let due = Item.components(item.date, item.time, zone: item.zone) {
                reminder.dueDateComponents = due
                reminder.alarms = item.start.flatMap { item.time.isEmpty ? nil : [EKAlarm(absoluteDate: $0)] }
            } else {
                reminder.dueDateComponents = nil
                reminder.alarms = nil
            }
            try store.save(reminder, commit: true)
            if let key { remember(key, reminder.calendarItemIdentifier) }
            return reminder.calendar.title
        case .event:
            let event = editorEvent(item, store: store)
            event.calendar = store.defaultCalendarForNewEvents
            guard event.calendar != nil else { throw EKError(.noCalendar) }
            try store.save(event, span: .thisEvent, commit: true)
            return event.calendar.title
        }
    }

    /// The event as the system's editor (iPhone, iPad) shows it before the person taps Add, and as the Mac saves it.
    static func editorEvent(_ item: Item, store: EKEventStore) -> EKEvent {
        let event = EKEvent(eventStore: store)
        event.title = item.title
        event.notes = item.notes.isEmpty ? nil : item.notes
        event.location = item.location.isEmpty ? nil : item.location
        event.url = URL(string: item.url).flatMap { ["http", "https"].contains($0.scheme ?? "") ? $0 : nil }
        let start = item.start ?? Date()
        if item.time.isEmpty {
            event.isAllDay = true
            event.startDate = start
            event.endDate = item.end.map { max($0, start) } ?? start
        } else {
            event.timeZone = item.zone
            event.startDate = start
            // No end given: an hour (a flight's arrival or a meeting's length comes with the text when it says so).
            event.endDate = item.end.flatMap { $0 > start ? $0 : nil } ?? start.addingTimeInterval(3600)
        }
        return event
    }

    /// «Также в Напоминания» taken back («Не напоминать», the message deleted): the reminder made for `key` goes, unless
    /// it was already done. Needs full access; nothing happens without it.
    static func remove(key: String, store: EKEventStore = EKEventStore()) {
        guard access(.reminder) == .write, let reminder = existingReminder(key, store: store) else { return }
        if !reminder.isCompleted { try? store.remove(reminder, commit: true) }
        forget(key)
    }

    private static func existingReminder(_ key: String, store: EKEventStore) -> EKReminder? {
        guard let id = keys[key], let reminder = store.calendarItem(withIdentifier: id) as? EKReminder, !reminder.isCompleted else { return nil }
        return reminder
    }

    // MARK: - App Group: keys, and requests for the app

    private static var defaults: UserDefaults { UserDefaults(suiteName: groupId) ?? .standard }

    private static var keys: [String: String] { defaults.dictionary(forKey: keysKey) as? [String: String] ?? [:] }

    private static func remember(_ key: String, _ id: String) {
        var all = keys
        all[key] = id
        // The most recent few hundred are plenty: older reminders have long rung.
        if all.count > 400 { all = Dictionary(uniqueKeysWithValues: Array(all).suffix(300)) }
        defaults.set(all, forKey: keysKey)
    }

    private static func forget(_ key: String) {
        var all = keys
        all.removeValue(forKey: key)
        defaults.set(all, forKey: keysKey)
    }

    /// The extension can't ask for access: the app takes the request (by `id`, which the panel's link names).
    static func handOff(_ item: Item, key: String?, id: String) {
        var all = defaults.dictionary(forKey: requestsKey) as? [String: [String: Any]] ?? [:]
        let now = Date().timeIntervalSince1970
        all = all.filter { now - ($0.value["at"] as? Double ?? 0) < 3600 }
        var stored = item.dictionary
        stored["at"] = now
        if let key { stored["key"] = key }
        all[id] = stored
        defaults.set(all, forKey: requestsKey)
    }

    /// The request with this id (an hour at most), taken: a second link to it finds nothing.
    static func takeRequest(_ id: String) -> (item: Item, key: String?)? {
        var all = defaults.dictionary(forKey: requestsKey) as? [String: [String: Any]] ?? [:]
        guard let stored = all[id], Date().timeIntervalSince1970 - (stored["at"] as? Double ?? 0) < 3600, let item = Item(stored) else { return nil }
        all.removeValue(forKey: id)
        defaults.set(all, forKey: requestsKey)
        return (item, stored["key"] as? String)
    }

    static func validId(_ id: String?) -> String? {
        guard let id = id?.lowercased(), id.range(of: "^[0-9a-z-]{8,64}$", options: .regularExpression) != nil else { return nil }
        return id
    }

    static func log(_ text: String) {
        MessageReminders.log("apple: \(text)")
    }
}
