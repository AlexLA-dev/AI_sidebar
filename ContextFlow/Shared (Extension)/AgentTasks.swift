import Foundation
import UserNotifications

/// A deferred agent task (2.7.1, «Сделай позже»): the person's words, the page, and when it's due: at a time
/// (`at`, ms), or when a page watch's condition comes true (`watch`, the watch's id). The extension keeps the tasks;
/// this copy is for the app's list ("Later") and for the notification. No page text, nothing on a server.
struct AgentTaskEntry: Codable, Equatable {
    var id: String
    var request: String
    var url: String
    var title: String
    var at: Double?
    var watch: String?
    var createdAt: Double
}

/// Deferred agent tasks on this device. Due at a time: a local notification set here (it comes even with Safari
/// closed). Due on a change: the extension's page watch calls `notify` when the condition came true. A tap opens the
/// page in Safari with `#cf-task=<id>`; the panel takes the mark out and offers «Начать» (or starts at once on a
/// site where the person switched that tap off). Every step there is the agent's usual one, with the person.
enum AgentTasks {
    static let prefix = "cf.agent."
    private static let listKey = "cf_agent_tasks"
    private static let stoppedKey = "cf_agent_tasks_stopped"
    static let mark = "cf-task"

    static var defaults: UserDefaults { UserDefaults(suiteName: SharedDefaults.suiteName) ?? .standard }

    /// The extension's tasks for the app's list; back, the ones cancelled in the app since.
    static func sync(_ raw: [[String: Any]]) -> [String] {
        let stopped = defaults.stringArray(forKey: stoppedKey) ?? []
        let entries = raw.compactMap(entry).filter { !stopped.contains($0.id) }
        if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: listKey) }
        defaults.removeObject(forKey: stoppedKey)
        return stopped
    }

    static func entries() -> [AgentTaskEntry] {
        guard let data = defaults.data(forKey: listKey) else { return [] }
        return (try? JSONDecoder().decode([AgentTaskEntry].self, from: data)) ?? []
    }

    /// Cancelled in the app: its notification goes, and the extension hears it on its next exchange.
    static func cancelInApp(_ id: String) {
        var stopped = defaults.stringArray(forKey: stoppedKey) ?? []
        if !stopped.contains(id) { stopped.append(id) }
        defaults.set(stopped, forKey: stoppedKey)
        if let data = try? JSONEncoder().encode(entries().filter { $0.id != id }) { defaults.set(data, forKey: listKey) }
        cancel(id)
        // Its reminder in Apple Reminders («Также в Напоминания»), when it has one, goes with it.
        AppleItems.remove(key: "cf.agent.\(id)")
    }

    static func cancel(_ id: String) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [prefix + id])
        center.removeDeliveredNotifications(withIdentifiers: [prefix + id])
    }

    private static let validId = try? NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,80}$")

    static func isId(_ s: String) -> Bool {
        validId?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func entry(_ d: [String: Any]) -> AgentTaskEntry? {
        guard let id = d["id"] as? String, isId(id), let url = d["url"] as? String, URL(string: url)?.scheme?.hasPrefix("http") == true else { return nil }
        return AgentTaskEntry(
            id: id, request: String((d["request"] as? String ?? "").prefix(600)), url: url, title: String((d["title"] as? String ?? "").prefix(200)),
            at: (d["at"] as? NSNumber)?.doubleValue, watch: d["watch"] as? String,
            createdAt: (d["createdAt"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
        )
    }

    private static func content(id: String, title: String, body: String, page: URL) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "cf.agent"
        content.userInfo = ["agentTask": id, "open": page.absoluteString]
        return content
    }

    /// Not with quiet permission: that's the setup reminders' only (2.8).
    private static func allowed(_ status: UNAuthorizationStatus) -> Bool { NotifyStatus.on(status) }

    /// A task due at a time: its notification, set on this device (moved when set again).
    static func schedule(id: String, at: Date, title: String, body: String, open page: URL) async -> MessageReminders.Outcome {
        guard isId(id), page.scheme == "https" || page.scheme == "http" else { return .failed }
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        if NotifyStatus.notAsked(status) { return .notAsked }
        guard allowed(status) else { return .denied }
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: at)
        let request = UNNotificationRequest(identifier: prefix + id, content: content(id: id, title: title, body: body, page: page),
                                            trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false))
        do {
            try await center.add(request)
            return .scheduled
        } catch {
            return .failed
        }
    }

    /// A task due on a change: the watch's condition came true, the notification now.
    static func notify(id: String, title: String, body: String, open page: URL) async -> MessageReminders.Outcome {
        guard isId(id), page.scheme == "https" || page.scheme == "http" else { return .failed }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard allowed(status) else { return NotifyStatus.notAsked(status) ? .notAsked : .denied }
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: prefix + id, content: content(id: id, title: title, body: body, page: page), trigger: nil))
        return .scheduled
    }

    /// The page a task's notification opens, with `#cf-task=<id>` (the panel takes the mark out at once). A page with an
    /// address fragment of its own keeps it; the panel then finds the task by its address.
    static func opened(_ info: [AnyHashable: Any]) -> URL? {
        guard let id = info["agentTask"] as? String, isId(id),
              let page = (info["open"] as? String).flatMap(URL.init(string:)), page.scheme == "https" || page.scheme == "http" else { return nil }
        guard var parts = URLComponents(url: page, resolvingAgainstBaseURL: false), (parts.fragment ?? "").isEmpty else { return page }
        parts.fragment = "\(mark)=\(id)"
        return parts.url ?? page
    }
}
