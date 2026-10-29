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
/// - `syncThreads` → sends the extension's chat changes to the user's iCloud and returns the other
///   devices' changes (see ChatSync); `available: false` without an iCloud account or connection.
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
        case "getSettings":
            let stored = SharedDefaults.shared.readSettings()
            var data: [String: Any] = ["updatedAt": stored?.updatedAt ?? 0]
            data["settings"] = stored.map { $0.settings as Any } ?? NSNull()
            Self.reply(context, ["success": true, "data": data])
        case "setSettings":
            let settings = message["settings"] as? [String: Any] ?? [:]
            let updatedAt = (message["updatedAt"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
            let stored = SharedDefaults.shared.writeSettings(settings, updatedAt: updatedAt)
            Self.reply(context, ["success": true, "data": ["stored": stored]])
        case "reviewMoment":
            SharedDefaults.shared.recordReviewMoment((message["count"] as? NSNumber)?.intValue ?? 0)
            Self.reply(context, ["success": true, "data": ["recorded": true]])
        case "syncThreads":
            let token = message["token"] as? String
            let changes: [ChatSync.Change] = (message["changes"] as? [[String: Any]] ?? []).compactMap { item in
                guard let id = item["id"] as? String else { return nil }
                if item["deleted"] as? Bool == true { return .delete(id) }
                guard let updatedAt = (item["updatedAt"] as? NSNumber)?.int64Value, let data = item["data"] as? String else { return nil }
                return .save(ChatSync.Snapshot(id: id, updatedAt: updatedAt, data: data))
            }
            Task {
                let result = await Self.withTimeout(seconds: 18) { try await ChatSync.sync(token: token, changes: changes) }
                guard case .success(let synced) = result else {
                    Self.reply(context, ["success": true, "data": ["available": false]])
                    return
                }
                Self.reply(context, ["success": true, "data": [
                    "available": true,
                    "token": synced.token ?? NSNull(),
                    "changed": synced.changed.map { ["id": $0.id, "updatedAt": $0.updatedAt, "data": $0.data] },
                    "deleted": synced.deleted
                ] as [String: Any]])
            }
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

    /// Runs `work`, giving up after `seconds` (the extension waits a little longer than that).
    private static func withTimeout<T>(seconds: Double, _ work: @escaping () async throws -> T) async -> Result<T, Error> {
        await withTaskGroup(of: Result<T, Error>?.self) { group in
            group.addTask {
                do { return .success(try await work()) } catch { return .failure(error) }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? .failure(CancellationError())
        }
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
