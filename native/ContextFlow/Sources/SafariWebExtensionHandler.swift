import SafariServices
import StoreKit
import os.log

/// Handles native messages from the Safari Web Extension's JavaScript code.
///
/// The extension sends messages via `browser.runtime.sendNativeMessage()`
/// and this handler processes StoreKit commands and returns results.
///
/// This file lives in the **Extension target** (ContextFlow Extension),
/// NOT in the container app. StoreKitManager and related files must be
/// added to the Extension target as well.
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

        Task {
            do {
                let result: [String: Any]

                switch command {
                case "fetchProducts":
                    result = try await handleFetchProducts()

                case "purchase":
                    let productId = message["productId"] as? String ?? ""
                    let appAccountToken = (message["appAccountToken"] as? String).flatMap { UUID(uuidString: $0) }
                    result = try await handlePurchase(productId: productId, appAccountToken: appAccountToken)

                case "restorePurchases":
                    result = try await handleRestorePurchases()

                case "getSubscriptionStatus":
                    result = try await handleGetSubscriptionStatus()

                case "manageSubscriptions":
                    let url = await StoreKitManager.shared.manageSubscriptionsURL()
                    result = ["success": true, "data": ["url": url]]

                default:
                    result = ["success": false, "error": "Unknown command: \(command)"]
                }

                sendResponse(context: context, data: result)
            } catch {
                logger.error("Command \(command) failed: \(error.localizedDescription)")
                sendResponse(context: context, data: [
                    "success": false,
                    "error": error.localizedDescription
                ])
            }
        }
    }

    // MARK: – Command Handlers

    private func handleFetchProducts() async throws -> [String: Any] {
        let manager = await StoreKitManager.shared
        await manager.loadProducts()

        let products = await manager.products.map { product in
            [
                "id": product.id,
                "displayName": product.displayName,
                "description": product.description,
                "displayPrice": product.displayPrice,
                "price": product.price as NSDecimalNumber,
                "currencyCode": product.priceFormatStyle.currencyCode
            ] as [String: Any]
        }

        return ["success": true, "data": products]
    }

    private func handlePurchase(productId: String, appAccountToken: UUID?) async throws -> [String: Any] {
        let manager = await StoreKitManager.shared
        let (transaction, jws) = try await manager.purchase(productId: productId, appAccountToken: appAccountToken)

        return [
            "success": true,
            "data": [
                "success": true,
                "transactionId": String(transaction.id),
                "originalTransactionId": String(transaction.originalID),
                "productId": transaction.productID,
                "jwsTransaction": jws
            ] as [String: Any]
        ]
    }

    private func handleRestorePurchases() async throws -> [String: Any] {
        let manager = await StoreKitManager.shared
        await manager.restorePurchases()

        let status = await manager.currentSubscriptionStatus()

        var data: [String: Any] = [
            "isSubscribed": status.isSubscribed,
            "isInGracePeriod": status.isInGracePeriod,
            "willAutoRenew": status.willAutoRenew
        ]
        if let productId = status.productId { data["productId"] = productId }
        if let expDate = status.expirationDate {
            data["expirationDate"] = ISO8601DateFormatter().string(from: expDate)
        }

        return ["success": true, "data": data]
    }

    private func handleGetSubscriptionStatus() async throws -> [String: Any] {
        let status = await StoreKitManager.shared.currentSubscriptionStatus()

        var data: [String: Any] = [
            "isSubscribed": status.isSubscribed,
            "isInGracePeriod": status.isInGracePeriod,
            "willAutoRenew": status.willAutoRenew
        ]
        if let productId = status.productId { data["productId"] = productId }
        if let expDate = status.expirationDate {
            data["expirationDate"] = ISO8601DateFormatter().string(from: expDate)
        }

        return ["success": true, "data": data]
    }

    // MARK: – Response

    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: data]
        context.completeRequest(returningItems: [response])
    }
}
