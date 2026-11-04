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
