import Foundation
import os.log

// MARK: – Shared Types

/// Subscription data passed between StoreKitManager and SharedDefaults.
/// Defined here (not in StoreKitManager) so the Extension target can use it
/// without importing StoreKit.
struct SubscriptionInfo {
    let isSubscribed: Bool
    var productId: String?
    var expirationDate: Date?
    var isInGracePeriod: Bool = false
    var willAutoRenew: Bool = false
}

/// Manages shared data between the container app and the Safari extension via App Group UserDefaults.
///
/// The container app writes subscription status, settings, and usage data here.
/// The Safari extension (SafariWebExtensionHandler) reads from here to check
/// subscription status without needing to initialize StoreKit.
///
/// Both targets must have the same App Group entitlement:
/// `group.com.contextflow.shared`
@available(iOS 15.0, macOS 12.0, *)
final class SharedDefaults {

    static let shared = SharedDefaults()

    private let logger = Logger(subsystem: "com.contextflow.app", category: "SharedDefaults")

    // MARK: – App Group

    static let suiteName = "group.com.contextflow.shared"

    private let defaults: UserDefaults

    private init() {
        guard let defaults = UserDefaults(suiteName: SharedDefaults.suiteName) else {
            fatalError("Failed to create UserDefaults for App Group: \(SharedDefaults.suiteName)")
        }
        self.defaults = defaults
    }

    // MARK: – Keys

    private enum Key {
        static let isSubscribed = "cf_is_subscribed"
        static let productId = "cf_product_id"
        static let planType = "cf_plan_type"
        static let expirationDate = "cf_expiration_date"
        static let isInGracePeriod = "cf_is_in_grace_period"
        static let willAutoRenew = "cf_will_auto_renew"
        static let lastUpdated = "cf_last_updated"
        // Settings
        static let fontSize = "cf_font_size"
        static let theme = "cf_theme"
        // Usage
        static let trialUsageCount = "cf_trial_usage_count"
        // Account
        static let userEmail = "cf_user_email"
        // API Key (BYOK)
        static let apiKey = "cf_api_key"
        // Debug — native bridge diagnostics
        static let debugLastNativeCommand = "cf_debug_last_native_command"
        static let debugLastNativeTimestamp = "cf_debug_last_native_timestamp"
    }

    // MARK: – Subscription Status

    /// Write subscription status to shared storage (called by the container app after purchase/restore).
    func writeSubscriptionStatus(_ info: SubscriptionInfo) {
        defaults.set(info.isSubscribed, forKey: Key.isSubscribed)
        defaults.set(info.productId, forKey: Key.productId)
        defaults.set(info.isInGracePeriod, forKey: Key.isInGracePeriod)
        defaults.set(info.willAutoRenew, forKey: Key.willAutoRenew)
        defaults.set(Date().timeIntervalSince1970, forKey: Key.lastUpdated)

        if let expDate = info.expirationDate {
            defaults.set(expDate.timeIntervalSince1970, forKey: Key.expirationDate)
        } else {
            defaults.removeObject(forKey: Key.expirationDate)
        }

        // Derive plan type from product ID
        if let productId = info.productId {
            if productId.contains("byok") {
                defaults.set("byok_license", forKey: Key.planType)
            } else if productId.contains("pro") {
                defaults.set("pro_subscription", forKey: Key.planType)
            }
        } else if !info.isSubscribed {
            defaults.set("free", forKey: Key.planType)
        }

        defaults.synchronize()
        logger.info("Wrote subscription status: subscribed=\(info.isSubscribed), product=\(info.productId ?? "none")")
    }

    /// Read subscription status from shared storage (called by the extension handler).
    func readSubscriptionStatus() -> [String: Any] {
        let isSubscribed = defaults.bool(forKey: Key.isSubscribed)
        let productId = defaults.string(forKey: Key.productId)
        let planType = defaults.string(forKey: Key.planType) ?? "free"
        let isInGracePeriod = defaults.bool(forKey: Key.isInGracePeriod)
        let willAutoRenew = defaults.bool(forKey: Key.willAutoRenew)
        let lastUpdated = defaults.double(forKey: Key.lastUpdated)

        var result: [String: Any] = [
            "isSubscribed": isSubscribed,
            "planType": planType,
            "isInGracePeriod": isInGracePeriod,
            "willAutoRenew": willAutoRenew,
            "lastUpdated": lastUpdated
        ]

        if let productId = productId {
            result["productId"] = productId
        }

        let expTimestamp = defaults.double(forKey: Key.expirationDate)
        if expTimestamp > 0 {
            let expDate = Date(timeIntervalSince1970: expTimestamp)
            result["expirationDate"] = ISO8601DateFormatter().string(from: expDate)
        }

        return result
    }

    /// Clear subscription (e.g. on expiration or revocation).
    func clearSubscription() {
        defaults.set(false, forKey: Key.isSubscribed)
        defaults.removeObject(forKey: Key.productId)
        defaults.set("free", forKey: Key.planType)
        defaults.removeObject(forKey: Key.expirationDate)
        defaults.set(false, forKey: Key.isInGracePeriod)
        defaults.set(false, forKey: Key.willAutoRenew)
        defaults.set(Date().timeIntervalSince1970, forKey: Key.lastUpdated)
        defaults.synchronize()
        logger.info("Cleared subscription status")
    }

    // MARK: – Settings

    var fontSize: Int {
        get {
            let size = defaults.integer(forKey: Key.fontSize)
            return size > 0 ? size : 14 // default
        }
        set {
            defaults.set(newValue, forKey: Key.fontSize)
            defaults.synchronize()
        }
    }

    /// "system", "light", "dark"
    var theme: String {
        get { defaults.string(forKey: Key.theme) ?? "system" }
        set {
            defaults.set(newValue, forKey: Key.theme)
            defaults.synchronize()
        }
    }

    // MARK: – Usage

    var trialUsageCount: Int {
        get { defaults.integer(forKey: Key.trialUsageCount) }
        set {
            defaults.set(newValue, forKey: Key.trialUsageCount)
            defaults.synchronize()
        }
    }

    // MARK: – Account

    var userEmail: String? {
        get { defaults.string(forKey: Key.userEmail) }
        set {
            if let email = newValue {
                defaults.set(email, forKey: Key.userEmail)
            } else {
                defaults.removeObject(forKey: Key.userEmail)
            }
            defaults.synchronize()
        }
    }

    // MARK: – API Key (BYOK)

    var apiKey: String? {
        get { defaults.string(forKey: Key.apiKey) }
        set {
            if let key = newValue, !key.isEmpty {
                defaults.set(key, forKey: Key.apiKey)
            } else {
                defaults.removeObject(forKey: Key.apiKey)
            }
            defaults.synchronize()
        }
    }

    // MARK: – Native Bridge Debug

    /// Records the last native bridge call for diagnostics.
    func recordNativeBridgeCall(command: String) {
        defaults.set(command, forKey: Key.debugLastNativeCommand)
        defaults.set(Date().timeIntervalSince1970, forKey: Key.debugLastNativeTimestamp)
        defaults.synchronize()
    }

    var debugLastNativeCommand: String? {
        defaults.string(forKey: Key.debugLastNativeCommand)
    }

    var debugLastNativeTimestamp: Double {
        defaults.double(forKey: Key.debugLastNativeTimestamp)
    }

    // MARK: – Debug

    /// Returns all stored values for debugging (shown in the native app Status tab).
    func debugDump() -> [String: Any] {
        var dump: [String: Any] = [
            "suiteName": SharedDefaults.suiteName,
            "isSubscribed": defaults.bool(forKey: Key.isSubscribed),
            "planType": defaults.string(forKey: Key.planType) ?? "free",
            "lastUpdated": defaults.double(forKey: Key.lastUpdated)
        ]
        if let pid = defaults.string(forKey: Key.productId) { dump["productId"] = pid }
        if let email = defaults.string(forKey: Key.userEmail) { dump["userEmail"] = email }
        if defaults.string(forKey: Key.apiKey) != nil { dump["apiKey"] = "(set)" }
        dump["trialUsageCount"] = defaults.integer(forKey: Key.trialUsageCount)
        dump["fontSize"] = defaults.integer(forKey: Key.fontSize)
        dump["theme"] = defaults.string(forKey: Key.theme) ?? "system"
        if let cmd = defaults.string(forKey: Key.debugLastNativeCommand) {
            dump["lastNativeCommand"] = cmd
        }
        let ts = defaults.double(forKey: Key.debugLastNativeTimestamp)
        if ts > 0 {
            let date = Date(timeIntervalSince1970: ts)
            let fmt = DateFormatter()
            fmt.dateFormat = "HH:mm:ss"
            dump["lastNativeCallTime"] = fmt.string(from: date)
        }
        return dump
    }
}
