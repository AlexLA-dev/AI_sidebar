import WebKit
import StoreKit
import os.log

/// Handles messages from the Safari Web Extension's JavaScript code.
///
/// The extension sends messages via `webkit.messageHandlers.storekit.postMessage({ ... })`
/// and this handler processes StoreKit commands and returns results via a JS callback.
///
/// Register this handler on any WKWebView that hosts the extension's UI:
/// ```swift
/// webView.configuration.userContentController.add(
///     ExtensionMessageHandler(),
///     name: "storekit"
/// )
/// ```
final class ExtensionMessageHandler: NSObject, WKScriptMessageHandler {

    private let logger = Logger(subsystem: "com.contextflow.app", category: "MessageHandler")

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let command = body["command"] as? String,
              let callbackId = body["callbackId"] as? String
        else {
            logger.warning("Invalid message format from extension")
            return
        }

        let webView = message.webView

        logger.info("Received command: \(command)")

        Task { @MainActor in
            do {
                switch command {
                case "fetchProducts":
                    let result = try await handleFetchProducts()
                    sendCallback(to: webView, callbackId: callbackId, success: true, data: result)

                case "purchase":
                    let productId = body["productId"] as? String ?? ""
                    let appAccountToken = (body["appAccountToken"] as? String).flatMap { UUID(uuidString: $0) }
                    let result = try await handlePurchase(productId: productId, appAccountToken: appAccountToken)
                    sendCallback(to: webView, callbackId: callbackId, success: true, data: result)

                case "restorePurchases":
                    let result = try await handleRestorePurchases()
                    sendCallback(to: webView, callbackId: callbackId, success: true, data: result)

                case "getSubscriptionStatus":
                    let result = try await handleGetSubscriptionStatus()
                    sendCallback(to: webView, callbackId: callbackId, success: true, data: result)

                case "manageSubscriptions":
                    await StoreKitManager.shared.showManageSubscriptions()
                    sendCallback(to: webView, callbackId: callbackId, success: true, data: [:] as [String: Any])

                default:
                    sendCallback(
                        to: webView,
                        callbackId: callbackId,
                        success: false,
                        error: "Unknown command: \(command)"
                    )
                }
            } catch {
                logger.error("Command \(command) failed: \(error.localizedDescription)")
                sendCallback(to: webView, callbackId: callbackId, success: false, error: error.localizedDescription)
            }
        }
    }

    // MARK: – Command Handlers

    private func handleFetchProducts() async throws -> [[String: Any]] {
        let manager = StoreKitManager.shared
        await manager.loadProducts()

        return manager.products.map { product in
            [
                "id": product.id,
                "displayName": product.displayName,
                "description": product.description,
                "displayPrice": product.displayPrice,
                "price": product.price as NSDecimalNumber,
                "currencyCode": product.priceFormatStyle.currencyCode
            ] as [String: Any]
        }
    }

    private func handlePurchase(productId: String, appAccountToken: UUID?) async throws -> [String: Any] {
        let manager = StoreKitManager.shared
        let (transaction, jws) = try await manager.purchase(productId: productId, appAccountToken: appAccountToken)

        return [
            "success": true,
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID,
            "jwsTransaction": jws
        ]
    }

    private func handleRestorePurchases() async throws -> [String: Any] {
        let manager = StoreKitManager.shared
        await manager.restorePurchases()

        let status = await manager.currentSubscriptionStatus()

        var result: [String: Any] = [
            "isSubscribed": status.isSubscribed
        ]

        if let productId = status.productId {
            result["productId"] = productId
        }
        if let expDate = status.expirationDate {
            result["expirationDate"] = ISO8601DateFormatter().string(from: expDate)
        }
        result["isInGracePeriod"] = status.isInGracePeriod
        result["willAutoRenew"] = status.willAutoRenew

        return result
    }

    private func handleGetSubscriptionStatus() async throws -> [String: Any] {
        let status = await StoreKitManager.shared.currentSubscriptionStatus()

        var result: [String: Any] = [
            "isSubscribed": status.isSubscribed
        ]

        if let productId = status.productId {
            result["productId"] = productId
        }
        if let expDate = status.expirationDate {
            result["expirationDate"] = ISO8601DateFormatter().string(from: expDate)
        }
        result["isInGracePeriod"] = status.isInGracePeriod
        result["willAutoRenew"] = status.willAutoRenew

        return result
    }

    // MARK: – JS Callback

    /// Sends the result back to the extension's JavaScript via the registered callback function.
    private func sendCallback(
        to webView: WKWebView?,
        callbackId: String,
        success: Bool,
        data: Any? = nil,
        error: String? = nil
    ) {
        guard let webView else { return }

        var payload: [String: Any] = ["success": success]
        if let data { payload["data"] = data }
        if let error { payload["error"] = error }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8)
        else {
            logger.error("Failed to serialize callback payload")
            return
        }

        // Escape for safe injection into JS
        let escaped = jsonString
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")

        let js = "if (typeof window['\(callbackId)'] === 'function') { window['\(callbackId)'](\(escaped)); }"

        Task { @MainActor in
            webView.evaluateJavaScript(js) { _, jsError in
                if let jsError {
                    self.logger.error("JS callback error: \(jsError.localizedDescription)")
                }
            }
        }
    }
}
