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
            logger.warning("Invalid message from extension (no command)")
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

        case "openApp":
            // Return a signal that JS should open the app via URL scheme
            result = ["success": true, "data": ["action": "openApp", "urlScheme": "contextflow://subscribe"]]

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
