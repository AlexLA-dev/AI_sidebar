import Foundation
import UserNotifications

/// Page watch (2.5). The extension checks pages while Safari runs (src/background/watch.ts) and keeps its
/// watches; this side has two jobs:
/// - the notification when a watch's condition comes true: a local one, right away, on this device (no
///   server, no push), id `cf.watch.<id>`, `userInfo["watch"]` and `["open"]` (the page);
/// - a copy of this device's watches for the app's list of reminders. A watch stopped in the app is gone from
///   the list at once and from the extension on its next exchange (`sync` hands the stops back).
/// Compiled into the app and the extension (App Group `group.com.contextflow.shared`).
struct WatchEntry: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var url: String
    /// What is watched, a few words ("Size 42").
    var label: String
    var condition: String
    /// 2.6 (97): the person's own note on it, optional (src/shared/watch/types.ts `note`). Older entries have none.
    var note: String?
    /// What it waits for with the value now, ready to show ("when the price drops below 35 € · now 40 €"): the
    /// extension writes it in the person's language. Older entries have none.
    var line: String?
    var what: String
    /// "bg": the extension checks it in the background; "live": when the page is opened.
    var mode: String
    /// The last check (ms since 1970).
    var checkedAt: Double
    /// When the condition came true (ms), and the value then.
    var metAt: Double?
    var metValue: String?
}

enum WatchStore {
    static let prefix = "cf.watch."
    private static let listKey = "cf.watches"
    private static let stoppedKey = "cf.watchesStopped"
    private static var defaults: UserDefaults { UserDefaults(suiteName: "group.com.contextflow.shared") ?? .standard }

    // MARK: The list

    /// The extension's watches now; back to it, the ones stopped in the app since its last exchange.
    static func sync(_ raw: [[String: Any]]) -> [String] {
        let stopped = defaults.stringArray(forKey: stoppedKey) ?? []
        let entries = raw.compactMap(entry).filter { !stopped.contains($0.id) }
        if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: listKey) }
        defaults.removeObject(forKey: stoppedKey)
        return stopped
    }

    static func entries() -> [WatchEntry] {
        guard let data = defaults.data(forKey: listKey) else { return [] }
        return (try? JSONDecoder().decode([WatchEntry].self, from: data)) ?? []
    }

    /// Stopped in the app.
    static func stop(_ id: String) {
        var stopped = defaults.stringArray(forKey: stoppedKey) ?? []
        if !stopped.contains(id) { stopped.append(id) }
        defaults.set(stopped, forKey: stoppedKey)
        if let data = try? JSONEncoder().encode(entries().filter { $0.id != id }) { defaults.set(data, forKey: listKey) }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [prefix + id])
    }

    private static func entry(_ d: [String: Any]) -> WatchEntry? {
        guard let id = d["id"] as? String, let url = d["url"] as? String else { return nil }
        func ms(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
        return WatchEntry(
            id: id, title: d["title"] as? String ?? "", url: url, label: d["label"] as? String ?? "",
            condition: d["condition"] as? String ?? "", note: (d["note"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            line: d["line"] as? String, what: d["what"] as? String ?? "page",
            mode: d["mode"] as? String ?? "bg", checkedAt: ms(d["checkedAt"]) ?? 0,
            metAt: ms(d["metAt"]), metValue: d["metValue"] as? String
        )
    }

    // MARK: The notification

    enum Permission: String {
        case ok
        // Notifications are off for ContextFlow: the panel says so and how to turn them on.
        case denied
        // Never asked (the question wasn't shown or was dismissed).
        case notAsked = "not-asked"
    }

    /// `ask`: on "Watch", the system question is shown right there in Safari, as for a reminder.
    static func permission(ask: Bool = false) async -> Permission {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined, ask {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        switch status {
        case .authorized, .provisional, .ephemeral: return .ok
        case .notDetermined: return .notAsked
        default: return .denied
        }
    }

    /// "Changed: …", shown right away.
    static func notify(id: String, title: String, body: String, open page: URL?) async -> Permission {
        let allowed = await permission()
        guard allowed == .ok else { return allowed }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "cf.watch"
        var info: [String: Any] = ["watch": id]
        if let page, page.scheme == "https" || page.scheme == "http" { info["open"] = page.absoluteString }
        content.userInfo = info
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: prefix + id, content: content, trigger: nil))
        return .ok
    }
}
