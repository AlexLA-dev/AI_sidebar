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
        if let defaults = UserDefaults(suiteName: SharedDefaults.suiteName) {
            self.defaults = defaults
            logger.info("App Group UserDefaults initialized successfully for \(SharedDefaults.suiteName)")
        } else {
            // Fallback to standard UserDefaults if App Group isn't provisioned.
            // This means data won't be shared between app and extension, but
            // at least neither process will crash.
            self.defaults = UserDefaults.standard
            logger.error("Failed to create UserDefaults for App Group \(SharedDefaults.suiteName) — falling back to standard")
        }
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
        // Supabase user ID (synced from extension for App Store verification)
        static let userId = "cf_user_id"
        // Data sharing consent
        static let dataConsentGiven = "cf_data_consent_given"
        // About Me (user profile for AI personalization)
        static let aboutMe = "cf_about_me"
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
        // Log which UserDefaults suite we're reading from
        let suiteName = defaults === UserDefaults.standard ? "standard (FALLBACK!)" : SharedDefaults.suiteName
        logger.info("Reading subscription from UserDefaults suite: \(suiteName)")
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

    /// Raw timestamp of last subscription status update (for race-condition guards).
    var lastUpdatedTimestamp: Double {
        defaults.double(forKey: Key.lastUpdated)
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

    // MARK: – Data Sharing Consent

    var dataConsentGiven: Bool {
        get { defaults.bool(forKey: Key.dataConsentGiven) }
        set {
            defaults.set(newValue, forKey: Key.dataConsentGiven)
            defaults.synchronize()
        }
    }

    // MARK: – About Me

    var aboutMe: String {
        get { defaults.string(forKey: Key.aboutMe) ?? "" }
        set {
            if newValue.isEmpty {
                defaults.removeObject(forKey: Key.aboutMe)
            } else {
                defaults.set(newValue, forKey: Key.aboutMe)
            }
            defaults.synchronize()
        }
    }

    // MARK: – Auth Session (Supabase tokens shared between app and extension)

    private enum AuthKey {
        static let accessToken = "cf_auth_access_token"
        static let refreshToken = "cf_auth_refresh_token"
        static let expiresAt = "cf_auth_expires_at"
    }

    /// Write a full Supabase auth session to shared storage.
    /// Called by the native app after sign-in or by the extension via the native handler.
    func writeAuthSession(accessToken: String, refreshToken: String, expiresAt: Double, userId: String, email: String) {
        defaults.set(accessToken, forKey: AuthKey.accessToken)
        defaults.set(refreshToken, forKey: AuthKey.refreshToken)
        defaults.set(expiresAt, forKey: AuthKey.expiresAt)
        self.userId = userId
        self.userEmail = email
        defaults.synchronize()
        logger.info("Wrote auth session for: \(email)")
    }

    /// Read the stored auth session. Returns nil if no session is stored.
    func readAuthSession() -> [String: Any]? {
        guard let accessToken = defaults.string(forKey: AuthKey.accessToken),
              let refreshToken = defaults.string(forKey: AuthKey.refreshToken),
              !accessToken.isEmpty else {
            return nil
        }
        return [
            "access_token": accessToken,
            "refresh_token": refreshToken,
            "expires_at": defaults.double(forKey: AuthKey.expiresAt),
            "user_id": userId ?? "",
            "email": userEmail ?? ""
        ]
    }

    /// Clear the stored auth session (on sign-out).
    func clearAuthSession() {
        defaults.removeObject(forKey: AuthKey.accessToken)
        defaults.removeObject(forKey: AuthKey.refreshToken)
        defaults.removeObject(forKey: AuthKey.expiresAt)
        defaults.synchronize()
        logger.info("Cleared auth session")
    }

    // MARK: – Pending Subscribe (extension → app communication)

    /// Written by the extension when the user taps "Subscribe".
    /// The app reads this on appear and auto-navigates to the Subscription tab.
    /// Cleared after the app reads it.
    var pendingSubscribePlan: String? {
        get { defaults.string(forKey: "cf_pending_subscribe_plan") }
        set {
            if let plan = newValue, !plan.isEmpty {
                defaults.set(plan, forKey: "cf_pending_subscribe_plan")
            } else {
                defaults.removeObject(forKey: "cf_pending_subscribe_plan")
            }
            defaults.synchronize()
        }
    }

    // MARK: – Pending Logout (app → extension communication)

    /// Set by the native app when the user taps "Logout".
    /// The extension reads this flag and signs out from Supabase,
    /// then clears the flag via the native handler.
    var pendingLogout: Bool {
        get { defaults.bool(forKey: "cf_pending_logout") }
        set {
            defaults.set(newValue, forKey: "cf_pending_logout")
            defaults.synchronize()
        }
    }

    // MARK: – User ID (Supabase)

    var userId: String? {
        get { defaults.string(forKey: Key.userId) }
        set {
            if let id = newValue, !id.isEmpty {
                defaults.set(id, forKey: Key.userId)
            } else {
                defaults.removeObject(forKey: Key.userId)
            }
            defaults.synchronize()
        }
    }

}
