import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Page watch (2.5) in the app: a tap on "Changed: …" opens the watched page in Safari. Counted in the
/// analytics registry's words (`use`: `notif.tap what=watch`, then `page_open via=watch`; no page, no text).
/// The watches themselves live in the extension (see WatchStore).
enum WatchOpen {
    /// At launch: the watches join Reminders. Notifications are asked about in Safari at "Watch", by the
    /// extension's handler, as Remind asks (one path: the app doesn't ask on its own).
    @MainActor
    static func start() {
        LaterCenter.shared.register(WatchSource())
    }

    @MainActor
    static func handle(_ info: [AnyHashable: Any]) {
        guard info["watch"] is String else { return }
        ChatAI.reportOrganize("use", ["f": "notif", "a": "tap", "what": "watch", "s": "notif"])
        guard let open = info["open"] as? String, let page = URL(string: open) else { return }
        ChatAI.reportOrganize("use", ["f": "page_open", "a": "tap", "via": "watch", "s": "notif"])
        #if os(iOS)
        UIApplication.shared.open(page)
        #else
        _ = NSWorkspace.shared.open(page)
        #endif
    }
}

/// This device's watches in "Reminders" (chat UX's list): "Watching: … · checked …", or "Changed: …" once the
/// condition came true. A tap opens the page; Stop goes back to the extension on its next exchange.
struct WatchSource: LaterSource {
    func items() async -> [LaterItem] {
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .short
        return WatchStore.entries().map { w in
            let label = w.label.isEmpty ? w.title : w.label
            let status: String
            if let met = w.metAt {
                let when = relative.localizedString(for: Date(timeIntervalSince1970: met / 1000), relativeTo: Date())
                if let value = w.metValue, !value.isEmpty {
                    status = String(localized: "Changed: \(label), now \(value) · \(when)")
                } else {
                    status = String(localized: "Changed: \(label) · \(when)")
                }
            } else if w.mode == "live" {
                status = String(localized: "Watching: \(label) · I'll check when you open the page")
            } else if w.checkedAt > 0 {
                let when = relative.localizedString(for: Date(timeIntervalSince1970: w.checkedAt / 1000), relativeTo: Date())
                status = String(localized: "Watching: \(label) · checked \(when)")
            } else {
                status = String(localized: "Watching: \(label)")
            }
            return LaterItem(id: "watch:\(w.id)", kind: .watch, title: w.title.isEmpty ? label : w.title, url: URL(string: w.url),
                             status: status, sortAt: Date(timeIntervalSince1970: (w.metAt ?? w.checkedAt) / 1000))
        }
    }

    func cancel(_ id: String) async {
        let watch = id.hasPrefix("watch:") ? String(id.dropFirst("watch:".count)) : id
        WatchStore.stop(watch)
    }
}
