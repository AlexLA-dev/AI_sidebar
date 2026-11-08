import SafariServices
import StoreKit
import UserNotifications
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
/// - `mirrorThreads` → keeps the app's copy of the chats (see ChatMirror) and returns the app's changes.
/// - `syncTemplates` → quick insert's templates: the extension's changes into the store the app shares,
///   iCloud both ways (see TemplateStore), and the merged set back.
/// - `pdfText` → the text of a PDF (by address, or the bytes the extension fetched), see PdfText.
/// - `renewalAsked` → the panel asked a Pro user with auto-renew off what was missing: not again this period
///   (the app checks the same mark).
/// - `byokRefused` / `byokOfferShown` → an Own key subscriber's first refusal of the period, and the discount shown
///   (the app offers Pro at a discount a day after the refusal, once per period, like the panel).
/// - `remind` / `unremind` → a reminder on an answer or a note: a local notification on this device that
///   opens the app on the message (see MessageReminders); answers `outcome` (scheduled, denied, not-asked).
/// - `watch_notify` / `watch_permission` / `watch_sync` → page watch: the local notification when a watch's
///   condition came true, whether notifications are allowed, this device's watches for the app's list (back:
///   the ones stopped in the app), see WatchStore.
/// - `listen` → read aloud on iPhone and iPad (2.6, Ultra): the text's parts go to the app through the App Group;
///   answers the request's `id`, and the page opens contextflow://listen?id=… (the app plays it with the screen locked).
/// - `tipClip` → a Tips clip for the panel (2.6 (91)): `name`, `lang` (en|ru), `offset`; answers `ok`, the clip's
///   `total` size and up to 256 KB of it from `offset` (base64), read from the app's copy in the App Group.
/// - `ping` → health check.
///
/// Every message also tells the app that the extension is switched on (and, for `getEntitlement`, which
/// the panel sends when it opens, that it is in use), so the app can drop its setup guide and reminders.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    /// The plans' prices from the App Store, into the App Group (at most 4 s; nothing when it can't answer).
    static func loadPrices() async {
        let load = Task { try? await Product.products(for: PlanProducts.all) }
        let timeout = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            load.cancel()
        }
        let products = await load.value ?? []
        timeout.cancel()
        if !products.isEmpty { SharedDefaults.shared.writePrices(PlanProducts.priceTable(products)) }
    }

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let command = message["command"] as? String ?? ""
        if SharedDefaults.shared.recordExtensionSeen(used: command == "getEntitlement", installId: message["installId"] as? String) {
            // Switched on: the reminders to finish setup the app scheduled are no longer needed.
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: SharedDefaults.setupReminderIds)
            center.removeDeliveredNotifications(withIdentifiers: SharedDefaults.setupReminderIds)
        }

        switch command {
        case "getEntitlement":
            Task {
                // No prices from the app yet (it hasn't loaded its plans since the update): the extension asks the
                // App Store itself, so the panel's plans sheet has its prices and savings (build 91).
                if SharedDefaults.shared.readPrices().isEmpty { await Self.loadPrices() }
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
        case "byokRefused":
            // An Own key subscriber was refused something in the panel: the first refusal of the period counts.
            if let period = message["period"] as? String {
                let at = (message["at"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
                SharedDefaults.shared.markByokRefused(period, at: at)
            }
            Self.reply(context, ["success": true])
        case "byokOfferShown":
            // The panel showed Pro at a discount: not again this period, here or in the app.
            if let period = message["period"] as? String { SharedDefaults.shared.markByokOfferShown(period) }
            Self.reply(context, ["success": true])
        case "renewalAsked":
            // The question about turning auto-renew off was answered or put off in the panel: not again this period.
            if let period = message["period"] as? String { SharedDefaults.shared.markRenewalAsked(period) }
            Self.reply(context, ["success": true])
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
        case "mirrorThreads":
            // The extension's chats for the app's Chats screen; the app's changes and "Open in Safari" back.
            var saves: [String: ChatMirror.Item] = [:]
            var deletes: [String] = []
            for item in message["changes"] as? [[String: Any]] ?? [] {
                guard let id = item["id"] as? String else { continue }
                if item["deleted"] as? Bool == true {
                    deletes.append(id)
                } else if let updatedAt = (item["updatedAt"] as? NSNumber)?.int64Value, let data = item["data"] as? String {
                    saves[id] = ChatMirror.Item(updatedAt: updatedAt, data: data)
                }
            }
            if !saves.isEmpty || !deletes.isEmpty { ChatMirror.apply(saves: saves, deletes: deletes) }
            if let ack = (message["ack"] as? NSNumber)?.doubleValue { ChatMirror.confirmAppChanges(upTo: ack) }
            let pending = ChatMirror.pendingAppChanges()
            var data: [String: Any] = ["appChanges": pending.changes.map(\.dictionary)]
            if let at = pending.at { data["at"] = at }
            // Only the panel opening takes the app's "continue this chat" (not a background start).
            if message["takeOpen"] as? Bool == true, let open = ChatMirror.takeOpenRequest() { data["open"] = open }
            Self.reply(context, ["success": true, "data": data])
        case "syncTemplates":
            // Quick insert's templates: the extension's changes into this device's store (the app sees them
            // there), then iCloud; the merged set goes back (see TemplateStore).
            let incoming = (message["changes"] as? [[String: Any]] ?? []).compactMap { TemplateRecord.decode($0["data"] as? String) }
            TemplateStore.merge(incoming)
            // iCloud only with "Sync chats with iCloud" on (the extension sends the switch).
            let cloud = message["cloud"] as? Bool ?? true
            Task {
                var available = false
                if cloud {
                    let result = await Self.withTimeout(seconds: 15) { try await TemplateSync.sync() }
                    if case .success = result { available = true }
                }
                Self.reply(context, ["success": true, "data": [
                    "available": available,
                    "templates": TemplateStore.all().map { ["id": $0.id, "updatedAt": $0.updatedAt, "data": $0.json] as [String: Any] }
                ] as [String: Any]])
            }
        case "pdfText":
            let url = message["url"] as? String
            let data = message["data"] as? String
            Task {
                let result = await Self.withTimeout(seconds: 35) { await PdfText.read(url: url, base64: data) }
                guard case .success(let pdf) = result else {
                    Self.reply(context, ["success": true, "data": ["ok": false, "error": "network"]])
                    return
                }
                Self.reply(context, ["success": true, "data": pdf])
            }
        case "remind":
            // A reminder on an answer or a note, set in the panel: a local notification on this device (2.5).
            guard let chat = message["chat"] as? String, let key = message["message"] as? String,
                  let at = (message["at"] as? NSNumber)?.doubleValue else {
                Self.reply(context, ["success": false, "error": "remind: chat, message and at"])
                return
            }
            let title = message["title"] as? String ?? "ContextFlow"
            let body = message["body"] as? String ?? ""
            let page = (message["url"] as? String).flatMap(URL.init(string:))
            Task {
                let outcome = await MessageReminders.schedule(chat: chat, message: key, at: Date(timeIntervalSince1970: at / 1000),
                                                              title: title, body: body, open: page, ask: message["ask"] as? Bool ?? false)
                Self.reply(context, ["success": true, "data": ["outcome": outcome.rawValue]])
            }
        case "unremind":
            if let chat = message["chat"] as? String, let key = message["message"] as? String {
                MessageReminders.cancel(chat: chat, message: key)
            }
            Self.reply(context, ["success": true])
        case "watch_notify":
            // Page watch (2.5): a watch's condition came true; "Changed: …" right away (WatchStore).
            guard let id = message["id"] as? String else {
                Self.reply(context, ["success": false, "error": "watch_notify: id"])
                return
            }
            let page = (message["url"] as? String).flatMap(URL.init(string:))
            Task {
                let outcome = await WatchStore.notify(id: id, title: message["title"] as? String ?? "ContextFlow",
                                                      body: message["body"] as? String ?? "", open: page)
                Self.reply(context, ["success": true, "data": ["outcome": outcome.rawValue]])
            }
        case "watch_permission":
            let ask = message["ask"] as? Bool ?? false
            Task { Self.reply(context, ["success": true, "data": ["outcome": await WatchStore.permission(ask: ask).rawValue]]) }
        case "watch_sync":
            // This device's watches for the app's list; back, the ones stopped in the app.
            let stopped = WatchStore.sync(message["watches"] as? [[String: Any]] ?? [])
            Self.reply(context, ["success": true, "data": ["cancelled": stopped]])
        case "listen":
            let parts = (message["parts"] as? [String] ?? []).prefix(80).map { String($0.prefix(4000)) }
            guard !parts.isEmpty else {
                Self.reply(context, ["success": false, "error": "no text"])
                return
            }
            let id = SharedDefaults.shared.writeListenRequest([
                "parts": Array(parts),
                // The raw text, and whether the app writes it for the ear first (tables, lists, a page…).
                "text": String((message["text"] as? String ?? "").prefix(24_000)),
                "script": message["script"] as? Bool ?? false,
                "lang": String((message["lang"] as? String ?? "").prefix(16)),
                "what": message["what"] as? String == "page" ? "page" : "answer",
                "title": String((message["title"] as? String ?? "").prefix(200)),
                "url": String((message["url"] as? String ?? "").prefix(2000))
            ], id: message["id"] as? String)
            Self.reply(context, ["success": true, "data": ["id": id]])
        case "tipClip":
            // A Tips clip for the panel, from the app's copy in the App Group (2.6 (91)), in parts of 256 KB (a multiple of 3 bytes, so the parts' base64 joins as is).
            let name = message["name"] as? String ?? ""
            let lang = message["lang"] as? String ?? "en"
            let offset = (message["offset"] as? NSNumber)?.intValue ?? 0
            guard let part = TipClipShare.read(name: name, lang: lang, offset: offset, length: 262_143) else {
                Self.reply(context, ["success": true, "data": ["ok": false]])
                return
            }
            Self.reply(context, ["success": true, "data": ["ok": true, "total": part.total, "offset": offset, "length": part.data.count, "data": part.data.base64EncodedString()]])
        case "ping":
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
            Self.reply(context, ["success": true, "data": ["pong": true, "version": version, "build": build]])
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
        let products = PlanProducts.all
        var best: (entitlement: SharedEntitlement, transaction: StoreKit.Transaction)?
        for await result in StoreKit.Transaction.currentEntitlements {
            // An Own key subscription upgraded to Pro (or Pro to Ultra) stays listed until it ends: the higher plan
            // counts from the purchase.
            guard case .verified(let transaction) = result,
                  products.contains(transaction.productID),
                  transaction.revocationDate == nil, !transaction.isUpgraded else { continue }
            if (best?.entitlement.expiresAt ?? .distantPast) <= (transaction.expirationDate ?? .distantPast) {
                best = (SharedEntitlement(
                    active: true,
                    productId: transaction.productID,
                    expiresAt: transaction.expirationDate,
                    jws: result.jwsRepresentation,
                    updatedAt: Date()
                ), transaction)
            }
        }
        guard var entitlement = best?.entitlement, let transaction = best?.transaction else { return nil }
        // Whether it renews: the panel asks a Pro user who turned auto-renew off what was missing.
        entitlement.autoRenew = await SharedEntitlement.autoRenew(of: transaction)
        return entitlement
    }
}
