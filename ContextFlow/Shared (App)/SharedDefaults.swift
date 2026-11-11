import Foundation
import StoreKit

/// State shared between the ContextFlow app and its Safari extension
/// (App Group `group.com.contextflow.shared`):
/// - the user's current App Store subscription, including Apple's signed
///   transaction (JWS) that the extension forwards to the backend as proof of purchase;
/// - the extension's settings, editable in either place (the newer copy wins);
/// - "moments of value" counted by the extension, after which the app may ask
///   for an App Store rating;
/// - whether the extension is switched on and has been used, for the app's setup guide
///   and its reminders to finish setup.
/// No accounts, no personal data.
///
/// This file is compiled into both the app and the extension targets
/// (two copies: "Shared (App)" and "Shared (Extension)" — keep them identical).
/// The products we sell, by plan (2.6: Ultra, and yearly plans). src/shared/plan.ts and App Store Connect match it.
enum PlanProducts {
    static let ultra = ["com.contextflow.ultra.monthly", "com.contextflow.ultra.yearly"]
    static let pro = ["com.contextflow.pro.monthly", "com.contextflow.pro.yearly"]
    static let byok = ["com.contextflow.byok.monthly", "com.contextflow.byok.yearly"]
    static let all = Set(ultra + pro + byok)

    /// "ultra", "pro", "byok" or "free" (no product, or one we don't sell).
    static func plan(of productId: String?) -> String {
        guard let productId else { return "free" }
        if ultra.contains(productId) { return "ultra" }
        if pro.contains(productId) { return "pro" }
        if byok.contains(productId) { return "byok" }
        return "free"
    }

    /// The panel's price table (2.6): each product's display price, and for each yearly plan a month of it, what it
    /// saves a year and in percent ("<id>#perMonth", "<id>#save", "<id>#percent"), all in the App Store's own format.
    /// Built by the app when it loads the plans, and by the extension itself when the app hasn't yet (build 91: the
    /// panel's plans sheet showed no prices).
    /// Build 93: also the prices' currency ("#currency", e.g. "USD") and, given, the App Store country ("#storefront",
    /// e.g. "UKR"), so the panel's plans event says what the device's App Store gave (the owner saw USD).
    static func priceTable(_ products: [Product], storefront: String? = nil) -> [String: String] {
        var table = Dictionary(products.map { ($0.id, $0.displayPrice) }, uniquingKeysWith: { a, _ in a })
        if let currency = products.first?.priceFormatStyle.currencyCode, !currency.isEmpty { table["#currency"] = currency.uppercased() }
        if let storefront, !storefront.isEmpty { table["#storefront"] = storefront.uppercased() }
        for ids in [ultra, pro, byok] {
            guard let monthly = products.first(where: { $0.id == ids[0] }), let yearly = products.first(where: { $0.id == ids[1] }),
                  monthly.price > 0 else { continue }
            let full = monthly.price * 12
            guard full > yearly.price else { continue }
            let percent = Int((NSDecimalNumber(decimal: (full - yearly.price) / full).doubleValue * 100).rounded())
            guard percent >= 5 else { continue }
            let style = yearly.priceFormatStyle
            table["\(yearly.id)#perMonth"] = (yearly.price / 12).formatted(style)
            table["\(yearly.id)#save"] = (full - yearly.price).formatted(style)
            table["\(yearly.id)#percent"] = String(percent)
        }
        return table
    }
}

struct SharedEntitlement: Equatable {
    var active: Bool
    var productId: String?
    var expiresAt: Date?
    var jws: String?
    var updatedAt: Date
    /// Whether the subscription renews at `expiresAt` (nil: not known).
    var autoRenew: Bool? = nil

    static let none = SharedEntitlement(active: false, productId: nil, expiresAt: nil, jws: nil, updatedAt: .distantPast)

    /// This subscription period: the question about turning auto-renew off is asked once in each.
    var period: String {
        "\(productId ?? "")|\(Int(expiresAt?.timeIntervalSince1970 ?? 0))"
    }

    var dictionary: [String: Any] {
        var result: [String: Any] = ["active": active]
        if let productId { result["productId"] = productId }
        if let expiresAt { result["expiresAt"] = ISO8601DateFormatter().string(from: expiresAt) }
        if let jws { result["jws"] = jws }
        if productId != nil { result["period"] = period }
        if let autoRenew {
            result["autoRenew"] = autoRenew
            result["renewalAsked"] = SharedDefaults.shared.renewalAsked(period)
        }
        // The App Store's prices on this device, for the panel's plans sheet (2.6).
        let prices = SharedDefaults.shared.readPrices()
        if !prices.isEmpty { result["prices"] = prices }
        // The last plan that started on this device (bought, upgraded): the panel's onboarding for it (build 90).
        if let change = SharedDefaults.shared.readPlanChange() { result["planChange"] = change }
        if PlanProducts.byok.contains(productId ?? "") {
            if let at = SharedDefaults.shared.byokRefusedAt(period) { result["byokRefusedAt"] = Int64(at.timeIntervalSince1970 * 1000) }
            result["byokOfferShown"] = SharedDefaults.shared.byokOfferShown(period)
        }
        return result
    }

    /// Whether the subscription of `transaction` renews, from StoreKit (nil when it can't tell).
    static func autoRenew(of transaction: StoreKit.Transaction) async -> Bool? {
        guard let group = transaction.subscriptionGroupID,
              let statuses = try? await Product.SubscriptionInfo.status(for: group) else { return nil }
        for status in statuses {
            guard case .verified(let renewal) = status.renewalInfo,
                  renewal.originalTransactionID == transaction.originalID else { continue }
            return renewal.willAutoRenew
        }
        return nil
    }
}

final class SharedDefaults {
    static let shared = SharedDefaults()
    static let suiteName = "group.com.contextflow.shared"

    private let defaults: UserDefaults
    private let entitlementKey = "cf_entitlement_v2"
    private let settingsKey = "cf_settings_v1"
    private let reviewMomentKey = "cf_review_moment_v1"
    private let reviewAskedKey = "cf_review_asked_v1"
    private let appAnswersKey = "cf_app_answers_v1"
    private let extensionKey = "cf_extension_v1"
    private let appKey = "cf_app_v1"
    private let renewalAskedKey = "cf_renewal_asked_v1"
    private let byokRefusedKey = "cf_byok_refused_v1"
    private let byokOfferShownKey = "cf_byok_offer_shown_v1"
    private let pricesKey = "cf_prices_v1"
    private let planChangeKey = "cf_plan_change_v1"
    private let listenKey = "cf_listen_v1"
    private let listenTakenKey = "cf_listen_taken"
    private let listenReturnKey = "cf_listen_return"
    private let voicedKey = "cf_voiced"

    /// Local notifications the app schedules on a new install until the extension is switched on.
    static let setupReminderIds = ["cf.setup.15m", "cf.setup.24h"]

    private init() {
        defaults = UserDefaults(suiteName: SharedDefaults.suiteName) ?? .standard
    }

    func writeEntitlement(_ value: SharedEntitlement) {
        var stored: [String: Any] = [
            "active": value.active,
            "updatedAt": value.updatedAt.timeIntervalSince1970
        ]
        if let productId = value.productId { stored["productId"] = productId }
        if let expiresAt = value.expiresAt { stored["expiresAt"] = expiresAt.timeIntervalSince1970 }
        if let jws = value.jws { stored["jws"] = jws }
        if let autoRenew = value.autoRenew { stored["autoRenew"] = autoRenew }
        defaults.set(stored, forKey: entitlementKey)
    }

    func readEntitlement() -> SharedEntitlement {
        guard let stored = defaults.dictionary(forKey: entitlementKey) else { return .none }
        let expires = (stored["expiresAt"] as? Double).map { Date(timeIntervalSince1970: $0) }
        var active = stored["active"] as? Bool ?? false
        // A cached subscription that lapsed long ago is not trusted locally;
        // the backend re-checks renewals via App Store Server Notifications.
        if let expires, expires.addingTimeInterval(7 * 24 * 3600) < Date() { active = false }
        return SharedEntitlement(
            active: active,
            productId: stored["productId"] as? String,
            expiresAt: expires,
            jws: stored["jws"] as? String,
            updatedAt: Date(timeIntervalSince1970: stored["updatedAt"] as? Double ?? 0),
            autoRenew: stored["autoRenew"] as? Bool
        )
    }

    // MARK: Prices (2.6)

    /// The display prices the app last loaded from the App Store (product id → "$12.99"), for the panel.
    func writePrices(_ prices: [String: String]) {
        defaults.set(prices, forKey: pricesKey)
    }

    func readPrices() -> [String: String] {
        defaults.dictionary(forKey: pricesKey) as? [String: String] ?? [:]
    }

    // MARK: Plan changes (build 90)

    /// A plan started (bought, upgraded, or changed at renewal): from, to ("free", "byok", "pro", "ultra"), the product
    /// and when (ms). StoreKitManager writes it and posts .cfPlanChanged; the panel gets it with the entitlement.
    func writePlanChange(from: String, to: String, productId: String) {
        defaults.set(["from": from, "to": to, "productId": productId, "at": Int64(Date().timeIntervalSince1970 * 1000)] as [String: Any], forKey: planChangeKey)
    }

    func readPlanChange() -> [String: Any]? {
        defaults.dictionary(forKey: planChangeKey)
    }

    // MARK: Read aloud on iPhone and iPad (2.6)

    /// The panel's Listen: the text in parts, its language, title and page, for the app to play (WebKit stops a
    /// page's audio when the screen locks). Only the latest one is kept; answers its id for contextflow://listen.
    /// `id`: the panel's own (build 91: it follows the link before this is written), else a new one.
    func writeListenRequest(_ request: [String: Any], id given: String? = nil) -> String {
        let id = given.flatMap { $0.range(of: "^[0-9a-fA-F-]{8,64}$", options: .regularExpression) != nil ? $0.lowercased() : nil } ?? UUID().uuidString.lowercased()
        var stored = request
        stored["id"] = id
        stored["at"] = Date().timeIntervalSince1970
        defaults.set(stored, forKey: listenKey)
        return id
    }

    /// The request with this id, if it's still the latest and fresh (an hour).
    func readListenRequest(_ id: String) -> [String: Any]? {
        guard let stored = defaults.dictionary(forKey: listenKey), stored["id"] as? String == id,
              let at = stored["at"] as? Double, Date().timeIntervalSince1970 - at < 3600 else { return nil }
        return stored
    }

    /// Read aloud playing in the panel (iPhone, iPad; 2.6): its parts as spoken and where it is, merged into the request
    /// with this id (kept fresh while it plays). False: that request isn't the latest any more.
    @discardableResult
    func updateListenRequest(_ id: String, _ changes: [String: Any]) -> Bool {
        guard var stored = defaults.dictionary(forKey: listenKey), stored["id"] as? String == id else { return false }
        for (key, value) in changes { stored[key] = value }
        stored["at"] = Date().timeIntervalSince1970
        defaults.set(stored, forKey: listenKey)
        return true
    }

    /// The app carried on the panel's read aloud (its notification was tapped): the panel doesn't play it again.
    func markListenTaken(_ id: String) {
        defaults.set(id, forKey: listenTakenKey)
    }

    func listenTaken(_ id: String) -> Bool {
        defaults.string(forKey: listenTakenKey) == id
    }

    /// The app sends the person back to the page in Safari for this text (build 93): "Back to Safari" (the panel opens
    /// again if it was open), or notifications just turned on (`play`: the panel plays the text itself).
    func markListenReturn(_ id: String, play: Bool) {
        defaults.set(["id": id, "play": play, "at": Date().timeIntervalSince1970], forKey: listenReturnKey)
    }

    /// Read once by the panel coming back (within 3 minutes of the app sending the person back): whether it was sent back
    /// for this text, and to play it there.
    func takeListenReturn(_ id: String) -> (back: Bool, play: Bool) {
        guard let stored = defaults.dictionary(forKey: listenReturnKey), stored["id"] as? String == id,
              let at = stored["at"] as? Double, Date().timeIntervalSince1970 - at < 180 else { return (false, false) }
        defaults.removeObject(forKey: listenReturnKey)
        return (true, stored["play"] as? Bool ?? false)
    }

    // MARK: Already voiced (build 94)

    /// The texts heard to their end on this device, in the app or the panel (src/shared/voiced.ts ids), the newest
    /// first: Listen shows that replaying them costs no minutes.
    func voicedIds() -> [String] {
        let stored = defaults.dictionary(forKey: voicedKey) as? [String: Double] ?? [:]
        return stored.sorted { $0.value > $1.value }.prefix(400).map(\.key)
    }

    /// Adds texts heard to their end (the newest 400 kept); false when they were all there already.
    @discardableResult
    func markVoiced(_ ids: [String]) -> Bool {
        var stored = defaults.dictionary(forKey: voicedKey) as? [String: Double] ?? [:]
        let now = Date().timeIntervalSince1970 * 1000
        var added = false
        for id in ids where id.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil && stored[id] == nil {
            stored[id] = now
            added = true
        }
        guard added else { return false }
        if stored.count > 400 {
            stored = Dictionary(uniqueKeysWithValues: stored.sorted { $0.value > $1.value }.prefix(400).map { ($0.key, $0.value) })
        }
        defaults.set(stored, forKey: voicedKey)
        return true
    }

    /// "Delete all chats": the list goes with what was read aloud.
    func clearVoiced() {
        defaults.removeObject(forKey: voicedKey)
    }

    // MARK: The question when auto-renew is off

    /// Asked (answered or put off) in the app or the panel for this subscription period.
    func renewalAsked(_ period: String) -> Bool {
        defaults.string(forKey: renewalAskedKey) == period
    }

    func markRenewalAsked(_ period: String) {
        defaults.set(period, forKey: renewalAskedKey)
    }

    // MARK: Own key → Pro

    /// The Own key subscriber's first refusal in this period (a limit, or a Pro-only feature), in the app or the
    /// panel: a day later Pro at a discount is offered.
    func byokRefusedAt(_ period: String) -> Date? {
        guard let stored = defaults.dictionary(forKey: byokRefusedKey), stored["period"] as? String == period,
              let at = stored["at"] as? Double else { return nil }
        return Date(timeIntervalSince1970: at)
    }

    /// Keeps the first refusal of the period.
    func markByokRefused(_ period: String, at: Date = Date()) {
        guard byokRefusedAt(period) == nil else { return }
        defaults.set(["period": period, "at": at.timeIntervalSince1970], forKey: byokRefusedKey)
    }

    /// The discount was shown (in the app or the panel) in this period: not again.
    func byokOfferShown(_ period: String) -> Bool {
        defaults.string(forKey: byokOfferShownKey) == period
    }

    func markByokOfferShown(_ period: String) {
        defaults.set(period, forKey: byokOfferShownKey)
    }

    // MARK: Settings shared with the extension

    /// The extension's settings (JSON-like dictionary) and when they last changed, in ms since 1970.
    func readSettings() -> (settings: [String: Any], updatedAt: Double)? {
        guard let stored = defaults.dictionary(forKey: settingsKey),
              let settings = stored["settings"] as? [String: Any] else { return nil }
        return (settings, stored["updatedAt"] as? Double ?? 0)
    }

    /// Stores settings unless the stored copy is newer. Returns whether they were written.
    @discardableResult
    func writeSettings(_ settings: [String: Any], updatedAt: Double) -> Bool {
        if let current = readSettings(), current.updatedAt >= updatedAt { return false }
        // Only property-list values can be stored; JSON null has no meaning here.
        let clean = settings.filter { !($0.value is NSNull) }
        defaults.set(["settings": clean, "updatedAt": updatedAt], forKey: settingsKey)
        return true
    }

    // MARK: App Store rating

    /// The extension reached the `count`-th good answer: a moment the app may ask for a rating.
    func recordReviewMoment(_ count: Int) {
        defaults.set(["count": count, "at": Date().timeIntervalSince1970], forKey: reviewMomentKey)
    }

    /// The latest moment of value the app hasn't asked about yet.
    func pendingReviewMoment() -> Int? {
        guard let count = defaults.dictionary(forKey: reviewMomentKey)?["count"] as? Int else { return nil }
        return count > defaults.integer(forKey: reviewAskedKey) ? count : nil
    }

    func markReviewAsked(_ count: Int) {
        defaults.set(count, forKey: reviewAskedKey)
    }

    /// Counts an answer the app gave in a chat; true on the 3rd, 10th, 30th, 100th and 300th: a moment to
    /// ask for a rating (the extension's answers are counted in Safari).
    func countAppAnswer() -> Bool {
        let count = defaults.integer(forKey: appAnswersKey) + 1
        defaults.set(count, forKey: appAnswersKey)
        return [3, 10, 30, 100, 300].contains(count)
    }

    // MARK: Setup

    struct ExtensionStatus {
        /// The extension first talked to the app: it is switched on in Safari.
        var firstSeen: Date?
        /// The panel first opened on a page (so Safari let it run there).
        var firstUsed: Date?
        /// The extension's anonymous install id (what the server counts answers by).
        var installId: String?
    }

    /// Called by the extension's native handler on every message; `used` when the panel asks for the
    /// subscription, which it does whenever it opens. Returns whether the extension was never seen before.
    @discardableResult
    func recordExtensionSeen(used: Bool, installId: String?) -> Bool {
        let before = defaults.dictionary(forKey: extensionKey) ?? [:]
        var stored = before
        let now = Date().timeIntervalSince1970
        let first = stored["firstSeen"] == nil
        if first { stored["firstSeen"] = now }
        if used, stored["firstUsed"] == nil { stored["firstUsed"] = now }
        if let installId, UUID(uuidString: installId) != nil { stored["installId"] = installId.lowercased() }
        if !(stored as NSDictionary).isEqual(to: before) { defaults.set(stored, forKey: extensionKey) }
        return first
    }

    func readExtensionStatus() -> ExtensionStatus {
        let stored = defaults.dictionary(forKey: extensionKey) ?? [:]
        let date = { (key: String) in (stored[key] as? Double).map { Date(timeIntervalSince1970: $0) } }
        var status = ExtensionStatus(firstSeen: date("firstSeen"), firstUsed: date("firstUsed"), installId: stored["installId"] as? String)
        // Versions before 2.4 didn't record this; answers counted for the rating prompt prove use.
        if status.firstUsed == nil, defaults.dictionary(forKey: reviewMomentKey) != nil {
            status.firstUsed = .distantPast
        }
        if status.firstSeen == nil { status.firstSeen = status.firstUsed }
        return status
    }

    /// The app's random id, made on its first launch, and whether this launch is the first one of a new
    /// install (rather than the first after updating from a version that kept no such record).
    func appLaunch() -> (id: String, newInstall: Bool) {
        if let id = defaults.dictionary(forKey: appKey)?["id"] as? String { return (id, false) }
        let updated = [entitlementKey, settingsKey, reviewMomentKey, extensionKey].contains { defaults.object(forKey: $0) != nil }
        let id = UUID().uuidString.lowercased()
        defaults.set(["id": id, "firstLaunch": Date().timeIntervalSince1970, "updated": updated], forKey: appKey)
        return (id, !updated)
    }

    /// Version 1.x kept Supabase sessions, e-mail and the user's OpenAI key here.
    /// None of that is used any more, so it is removed on first launch of 2.0.
    func removeLegacyData() {
        let legacyKeys = [
            "cf_is_subscribed", "cf_product_id", "cf_plan_type", "cf_expiration_date", "cf_is_in_grace_period",
            "cf_will_auto_renew", "cf_last_updated", "cf_font_size", "cf_theme", "cf_trial_usage_count",
            "cf_user_email", "cf_api_key", "cf_user_id", "cf_data_consent_given", "cf_about_me",
            "cf_auth_access_token", "cf_auth_refresh_token", "cf_auth_expires_at",
            "cf_pending_subscribe_plan", "cf_pending_logout"
        ]
        legacyKeys.forEach { defaults.removeObject(forKey: $0) }
    }
}

/// The Tips clips for the Safari panel (2.6 (91), the owner: «если ролики лежат в приложении, подтянуть их из
/// приложения в расширение на том же девайсе»). The extension carries no clips of its own: the app puts its TipClips in
/// the App Group once per build, at launch, and the extension reads them from there for the panel (the command
/// `tipClip`, in parts). Before the app has run once after an install or an update, the panel shows its words instead.
enum TipClipShare {
    nonisolated private static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName)?
            .appendingPathComponent("TipClips", isDirectory: true)
    }

    /// The app: copies TipClips/<lang>/*.mp4 into the App Group when this build hasn't yet (an update replaces them).
    nonisolated static func publish() {
        guard let source = Bundle.main.url(forResource: "TipClips", withExtension: nil), let folder else { return }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let stamp = folder.appendingPathComponent("build.txt")
        if (try? String(contentsOf: stamp, encoding: .utf8)) == build { return }
        let files = FileManager.default
        let fresh = folder.deletingLastPathComponent().appendingPathComponent("TipClips-\(build)", isDirectory: true)
        do {
            // Into a fresh folder, then swapped in whole: the extension never reads a half-copied set.
            try? files.removeItem(at: fresh)
            try files.copyItem(at: source, to: fresh)
            try build.write(to: fresh.appendingPathComponent("build.txt"), atomically: true, encoding: .utf8)
            if files.fileExists(atPath: folder.path) {
                _ = try files.replaceItemAt(folder, withItemAt: fresh)
            } else {
                try files.moveItem(at: fresh, to: folder)
            }
        } catch {
            try? files.removeItem(at: fresh)
        }
    }

    /// The extension: up to `length` bytes of a clip from `offset`, and its whole size; nil when the app hasn't put it
    /// there (not run since the install, or a clip newer than its last run). The clip's language: the panel's
    /// (`lang`), then the person's other languages, by `language`.
    nonisolated static func read(name: String, lang: String, offset: Int, length: Int) -> (data: Data, total: Int)? {
        guard name.range(of: "^[a-z0-9-]{1,40}$", options: .regularExpression) != nil, let folder else { return nil }
        let chosen = language([lang] + Locale.preferredLanguages, available: languages(in: folder))
        guard let handle = try? FileHandle(forReadingFrom: folder.appendingPathComponent(chosen).appendingPathComponent("\(name).mp4")) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        let start = UInt64(max(0, min(offset, Int(end))))
        try? handle.seek(toOffset: start)
        let data = (try? handle.read(upToCount: max(0, min(length, 1 << 20)))) ?? Data()
        return (data, Int(end))
    }

    /// The clips' languages: the folders in `folder` (TipClips/<language>/, the app's or the App Group's copy).
    nonisolated static func languages(in folder: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).filter { name in
            var dir: ObjCBool = false
            return FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path, isDirectory: &dir) && dir.boolValue
        }
    }

    /// The clips' language (build 95: no language is a special case): the first of `wanted` (most preferred first)
    /// that has a folder in `available`, else English. A language matches its folder whole ("pt_BR", "zh-Hant"), by
    /// language and script, or by language alone; Chinese by its script too ("zh-TW" → zh-Hant, "zh-CN" → zh-Hans).
    /// Clips recorded in a new language are a new folder, nothing else.
    nonisolated static func language(_ wanted: [String], available: [String]) -> String {
        let key = { (tag: String) in tag.lowercased().replacingOccurrences(of: "_", with: "-") }
        var folders: [String: String] = [:]
        for name in available where folders[key(name)] == nil { folders[key(name)] = name }
        for tag in wanted {
            let parts = key(tag).split(separator: "-").map(String.init)
            guard let lang = parts.first, lang.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil else { continue }
            var candidates = [parts.joined(separator: "-")]
            if parts.count > 2 { candidates.append("\(lang)-\(parts[1])") }
            if lang == "zh", let region = parts.dropFirst().first(where: { $0.count == 2 }) {
                candidates.append(["tw", "hk", "mo"].contains(region) ? "zh-hant" : "zh-hans")
            }
            candidates.append(lang)
            if let hit = candidates.lazy.compactMap({ folders[$0] }).first { return hit }
        }
        return folders["en"] ?? "en"
    }
}

// MARK: - Read aloud made in the panel, for the app on this device

/// Parts the panel made (build 92), kept where the app on the same device finds them, under the key its own cache uses
/// (sha256 of "v1|<language>|<text>"): a text handed from Safari to the app plays from here, nothing asked of iCloud or
/// the server. About 40 MB of audio, nothing older than 7 days; gone with "Delete all chats".
enum SharedListenCache {
    private static let limit = 40 * 1024 * 1024
    private static let maxAge: TimeInterval = 7 * 86_400

    private static var folder: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedDefaults.suiteName) else { return nil }
        let folder = base.appendingPathComponent("Listen", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    static func read(_ key: String) -> Data? {
        guard key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let file = folder?.appendingPathComponent("\(key).pcm"), let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
        let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        return Date().timeIntervalSince(written) < maxAge ? data : nil
    }

    static func write(_ key: String, _ pcm: Data) {
        guard key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, let folder else { return }
        try? pcm.write(to: folder.appendingPathComponent("\(key).pcm"), options: .atomic)
        prune(folder)
    }

    static func clear() {
        guard let folder, let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    /// Older than 7 days, then the oldest first while over the limit.
    private static func prune(_ folder: URL) {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
        let rows = files.compactMap { url -> (url: URL, at: Date, size: Int)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }.sorted { $0.at > $1.at }
        var total = 0
        for row in rows {
            total += row.size
            if total > limit || Date().timeIntervalSince(row.at) >= maxAge { try? FileManager.default.removeItem(at: row.url) }
        }
    }
}
