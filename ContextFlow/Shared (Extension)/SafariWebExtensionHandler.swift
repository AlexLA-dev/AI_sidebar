import SafariServices
import os.log

/// Handles native messages from the Safari Web Extension's JavaScript code.
///
/// The extension sends messages via `browser.runtime.sendNativeMessage()`
/// and this handler reads subscription status from SharedDefaults (App Group)
/// written by the container app.
///
/// Purchase flow is handled entirely in the container app — this handler
/// only reads status and settings, no StoreKit initialization needed.
@available(iOS 15.0, macOS 12.0, *)
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let logger = Logger(subsystem: "com.contextflow.app.Extension", category: "NativeHandler")

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        guard let message, let command = message["command"] as? String else {
            logger.warning("Invalid message from extension (no command). Raw: \(String(describing: item?.userInfo))")
            sendResponse(context: context, data: ["success": false, "error": "Invalid message"])
            return
        }

        logger.info("Received command: \(command)")

        let result: [String: Any]

        switch command {
        case "getSubscriptionStatus":
            let status = SharedDefaults.shared.readSubscriptionStatus()
            result = ["success": true, "data": status]

        case "getSettings":
            let settings: [String: Any] = [
                "fontSize": SharedDefaults.shared.fontSize,
                "theme": SharedDefaults.shared.theme,
                "aboutMe": SharedDefaults.shared.aboutMe
            ]
            result = ["success": true, "data": settings]

        case "syncUserInfo":
            // Extension writes user email and Supabase user ID to shared storage
            if let email = message["email"] as? String, !email.isEmpty {
                SharedDefaults.shared.userEmail = email
                logger.info("Synced user email: \(email)")
            } else {
                SharedDefaults.shared.userEmail = nil
                logger.info("Cleared user email")
            }
            if let userId = message["userId"] as? String, !userId.isEmpty {
                SharedDefaults.shared.userId = userId
                logger.info("Synced user ID: \(userId)")
            } else if (message["email"] as? String ?? "").isEmpty {
                // Only clear userId when email is also cleared (logout)
                SharedDefaults.shared.userId = nil
                logger.info("Cleared user ID")
            }
            result = ["success": true, "data": [:] as [String: Any]]

        case "syncTrialUsage":
            // Extension syncs trial usage count so the native app displays accurate remaining requests
            if let count = message["count"] as? Int {
                SharedDefaults.shared.trialUsageCount = count
                logger.info("Synced trial usage count: \(count)")
            }
            result = ["success": true, "data": [:] as [String: Any]]

        case "syncDataConsent":
            if let given = message["given"] as? Bool {
                SharedDefaults.shared.dataConsentGiven = given
                logger.info("Synced data consent: \(given)")
            }
            result = ["success": true, "data": [:] as [String: Any]]

        case "getApiKey":
            let key = SharedDefaults.shared.apiKey ?? ""
            result = ["success": true, "data": ["apiKey": key]]

        case "setApiKey":
            let key = message["apiKey"] as? String
            SharedDefaults.shared.apiKey = key
            logger.info("API key \(key != nil && !key!.isEmpty ? "set" : "cleared")")
            result = ["success": true, "data": [:] as [String: Any]]

        case "syncAboutMe":
            let text = message["aboutMe"] as? String ?? ""
            SharedDefaults.shared.aboutMe = text
            logger.info("Synced aboutMe (\(text.count) chars)")
            result = ["success": true, "data": [:] as [String: Any]]

        case "setPendingSubscribe":
            // Extension writes the desired plan so the app auto-navigates to purchase on open
            let plan = message["plan"] as? String ?? ""
            SharedDefaults.shared.pendingSubscribePlan = plan.isEmpty ? nil : plan
            logger.info("Set pending subscribe plan: \(plan)")
            result = ["success": true, "data": [:] as [String: Any]]

        case "openApp":
            // Return a signal that JS should open the app via URL scheme
            result = ["success": true, "data": ["action": "openApp", "urlScheme": "contextflow://subscribe"]]

        case "getPendingLogout":
            // Extension checks if the native app requested a logout
            let pending = SharedDefaults.shared.pendingLogout
            result = ["success": true, "data": ["pendingLogout": pending]]

        case "clearPendingLogout":
            // Extension clears the flag after signing out from Supabase
            SharedDefaults.shared.pendingLogout = false
            result = ["success": true, "data": [:] as [String: Any]]

        case "getAuthSession":
            // Extension reads shared auth session (tokens written by native app or extension)
            if let session = SharedDefaults.shared.readAuthSession() {
                result = ["success": true, "data": session]
            } else {
                result = ["success": true, "data": [:] as [String: Any]]
            }

        case "setAuthSession":
            // Extension writes auth session after sign-in so the native app picks it up
            if let accessToken = message["access_token"] as? String,
               let refreshToken = message["refresh_token"] as? String,
               !accessToken.isEmpty {
                let expiresAt = message["expires_at"] as? Double ?? 0
                let userId = message["user_id"] as? String ?? ""
                let email = message["email"] as? String ?? ""
                SharedDefaults.shared.writeAuthSession(
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    expiresAt: expiresAt,
                    userId: userId,
                    email: email
                )
            }
            result = ["success": true, "data": [:] as [String: Any]]

        case "clearAuthSession":
            // Clear stored auth session (sign-out)
            SharedDefaults.shared.clearAuthSession()
            result = ["success": true, "data": [:] as [String: Any]]

        case "ping":
            // Health check — extension can verify native messaging works
            result = ["success": true, "data": ["pong": true, "version": "1.0"]]

        default:
            result = ["success": false, "error": "Unknown command: \(command). Purchases are now handled in the ContextFlow app."]
        }

        sendResponse(context: context, data: result)
    }

    // MARK: – Response

    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: data]
        context.completeRequest(returningItems: [response])
    }
}
