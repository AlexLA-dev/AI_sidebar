import Foundation

/// The one piece of state shared between the ContextFlow app and its Safari
/// extension (App Group `group.com.contextflow.shared`): the user's current
/// App Store subscription, including Apple's signed transaction (JWS) that the
/// extension forwards to the backend as proof of purchase. No accounts, no
/// personal data.
///
/// This file is compiled into both the app and the extension targets
/// (two copies: "Shared (App)" and "Shared (Extension)" — keep them identical).
struct SharedEntitlement: Equatable {
    var active: Bool
    var productId: String?
    var expiresAt: Date?
    var jws: String?
    var updatedAt: Date

    static let none = SharedEntitlement(active: false, productId: nil, expiresAt: nil, jws: nil, updatedAt: .distantPast)

    var dictionary: [String: Any] {
        var result: [String: Any] = ["active": active]
        if let productId { result["productId"] = productId }
        if let expiresAt { result["expiresAt"] = ISO8601DateFormatter().string(from: expiresAt) }
        if let jws { result["jws"] = jws }
        return result
    }
}

final class SharedDefaults {
    static let shared = SharedDefaults()
    static let suiteName = "group.com.contextflow.shared"

    private let defaults: UserDefaults
    private let entitlementKey = "cf_entitlement_v2"

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
            updatedAt: Date(timeIntervalSince1970: stored["updatedAt"] as? Double ?? 0)
        )
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
