import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Page watch (2.5) in the app: a tap on "Changed: …" opens the watched page in Safari and is counted
/// (`ux_watch` opened: no page, no text). The watches themselves live in the extension (see WatchStore).
enum WatchOpen {
    @MainActor
    static func handle(_ info: [AnyHashable: Any]) {
        guard info["watch"] is String else { return }
        ChatAI.reportUx("ux_watch", ["action": "opened"])
        guard let open = info["open"] as? String, let page = URL(string: open) else { return }
        #if os(iOS)
        UIApplication.shared.open(page)
        #else
        _ = NSWorkspace.shared.open(page)
        #endif
    }
}
