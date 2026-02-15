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

        // Record raw message receipt for diagnostics (even if parsing fails)
        SharedDefaults.shared.recordNativeBridgeCall(command: message?["command"] as? String ?? "(no command)")

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
                "theme": SharedDefaults.shared.theme
            ]
            result = ["success": true, "data": settings]

        case "syncUserInfo":
            // Extension writes user email to shared storage so the native app can display it
            if let email = message["email"] as? String, !email.isEmpty {
                SharedDefaults.shared.userEmail = email
                logger.info("Synced user email: \(email)")
            } else {
                SharedDefaults.shared.userEmail = nil
                logger.info("Cleared user email")
            }
            result = ["success": true, "data": [:] as [String: Any]]

        case "syncTrialUsage":
            // Extension syncs trial usage count so the native app displays accurate remaining requests
            if let count = message["count"] as? Int {
                SharedDefaults.shared.trialUsageCount = count
                logger.info("Synced trial usage count: \(count)")
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

        case "openApp":
            // Return a signal that JS should open the app via URL scheme
            result = ["success": true, "data": ["action": "openApp", "urlScheme": "contextflow://subscribe"]]

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
