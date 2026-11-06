import Foundation
import UserNotifications
#if canImport(os)
import os
#endif

/// Reminders on an answer or a note (2.5): a local notification on the device where the reminder was
/// set, from the panel (through the extension's native handler) or in the app. No server. The chat
/// keeps only the mark (`remind` on the message), so every device shows the bell but only this one rings.
/// Tapping the notification opens the app on that message: `contextflow://chat?id=<chat>&m=<message key>`
/// (the key is the message's `entryKey`; the app looks for it in every chat, as messages can move). A page
/// reminder (the bell by a selection) opens its page in Safari instead (`open`).
enum MessageReminders {
    static let prefix = "cf.remind."

    enum Outcome: String {
        case scheduled
        // Notifications are off for ContextFlow (or were never allowed): the panel explains and links to Settings.
        case denied
        // Asked for the first time, from the app only (an extension can't show the system question).
        case notAsked = "not-asked"
        case failed
    }

    static func identifier(chat: String, message: String) -> String { "\(prefix)\(chat).\(message)" }

    static func link(chat: String, message: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "contextflow"
        parts.host = "chat"
        parts.queryItems = [URLQueryItem(name: "id", value: chat), URLQueryItem(name: "m", value: message)]
        return parts.url
    }

    /// Sets (or moves) the reminder for a message. `ask`: may show the system question about notifications
    /// (the app; the extension can't).
    static func schedule(chat: String, message: String, at: Date, title: String, body: String, open page: URL? = nil, ask: Bool) async -> Outcome {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            guard ask else { return .notAsked }
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return .denied }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "cf.remind.\(chat)"
        var info: [String: Any] = [:]
        if let url = link(chat: chat, message: message) { info["link"] = url.absoluteString }
        if let page, page.scheme == "https" || page.scheme == "http" { info["open"] = page.absoluteString }
        content.userInfo = info
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: at)
        let request = UNNotificationRequest(identifier: identifier(chat: chat, message: message), content: content,
                                            trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false))
        do {
            try await center.add(request)
            log("scheduled \(request.identifier) at \(at)")
            return .scheduled
        } catch {
            log("failed \(request.identifier): \(error)")
            return .failed
        }
    }

    static func cancel(chat: String, message: String) {
        let id = identifier(chat: chat, message: message)
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    /// The reminders waiting on this device (identifier → time), for the bell's "on this device".
    static func pending() async -> [String: Date] {
        let requests = await UNUserNotificationCenter.current().pendingNotificationRequests()
        var out: [String: Date] = [:]
        for r in requests where r.identifier.hasPrefix(prefix) {
            if let date = (r.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() { out[r.identifier] = date }
        }
        return out
    }

    static func log(_ text: String) {
        #if canImport(os)
        Logger(subsystem: "com.contextflow.app", category: "reminders").notice("\(text, privacy: .public)")
        #endif
    }
}
