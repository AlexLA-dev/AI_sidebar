import SafariServices
import StoreKit
#if os(macOS)
import AppKit
#endif

/// Native side of the Safari extension. The extension's background script calls
/// `browser.runtime.sendNativeMessage(…, {command: …})`; replies are
/// `{success: Bool, data: …}`.
///
/// Commands:
/// - `getEntitlement` → the App Store subscription (with Apple's signed JWS) that
///   the extension forwards to the backend. Prefers live StoreKit data so
///   renewals are picked up even if the app hasn't been opened since.
/// - `openApp` (macOS) → opens the ContextFlow app at a deep link.
/// - `ping` → health check.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let command = message["command"] as? String ?? ""

        switch command {
        case "getEntitlement":
            Task {
                let entitlement = await Self.currentEntitlement()
                Self.reply(context, ["success": true, "data": entitlement.dictionary])
            }
        case "openApp":
            #if os(macOS)
            let link = (message["url"] as? String).flatMap(URL.init(string:)) ?? URL(string: "contextflow://open")!
            DispatchQueue.main.async {
                let opened = NSWorkspace.shared.open(link)
                Self.reply(context, ["success": true, "data": ["opened": opened]])
            }
            #else
            // iOS extensions can't open URLs; the page follows the contextflow:// link instead.
            Self.reply(context, ["success": true, "data": ["opened": false]])
            #endif
        case "ping":
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            Self.reply(context, ["success": true, "data": ["pong": true, "version": version]])
        default:
            Self.reply(context, ["success": false, "error": "Unknown command: \(command)"])
        }
    }

    private static func reply(_ context: NSExtensionContext, _ payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Live StoreKit entitlement (bounded to 2.5 s), falling back to what the app last shared.
    private static func currentEntitlement() async -> SharedEntitlement {
        let cached = SharedDefaults.shared.readEntitlement()
        let live = await withTaskGroup(of: SharedEntitlement?.self) { group -> SharedEntitlement? in
            group.addTask { await liveEntitlement() }
            group.addTask {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let live, live.active else { return cached }
        SharedDefaults.shared.writeEntitlement(live)
        return live
    }

    private static func liveEntitlement() async -> SharedEntitlement? {
        let products: Set<String> = ["com.contextflow.pro.monthly", "com.contextflow.pro.yearly", "com.contextflow.byok.monthly"]
        var best: SharedEntitlement?
        for await result in StoreKit.Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  products.contains(transaction.productID),
                  transaction.revocationDate == nil else { continue }
            if (best?.expiresAt ?? .distantPast) <= (transaction.expirationDate ?? .distantPast) {
                best = SharedEntitlement(
                    active: true,
                    productId: transaction.productID,
                    expiresAt: transaction.expirationDate,
                    jws: result.jwsRepresentation,
                    updatedAt: Date()
                )
            }
        }
        return best
    }
}
