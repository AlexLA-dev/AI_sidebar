import StoreKit
import Combine
import os.log

/// Manages App Store subscriptions via StoreKit 2.
///
/// This class is used by the native container app that wraps the Safari Web Extension.
/// It handles product fetching, purchasing, restoration, and transaction listening.
@available(iOS 15.0, macOS 12.0, *)
@MainActor
final class StoreKitManager: ObservableObject {

    static let shared = StoreKitManager()

    // MARK: – Product IDs (must match App Store Connect)

    enum ProductID: String, CaseIterable {
        case byokMonthly = "com.contextflow.byok.monthly"
        case proMonthly  = "com.contextflow.pro.monthly"
    }

    // MARK: – Published state

    @Published private(set) var products: [Product] = []
    @Published private(set) var purchasedProductIDs: Set<String> = []
    @Published private(set) var isLoading = false

    // MARK: – Private

    private let logger = Logger(subsystem: "com.contextflow.app", category: "StoreKit")
    private var transactionListener: Task<Void, Never>?

    // MARK: – Lifecycle

    private init() {
        transactionListener = listenForTransactions()
        Task { await loadProducts() }
        Task { await updatePurchasedProducts() }
    }

    deinit {
        transactionListener?.cancel()
    }

    // MARK: – Load products

    func loadProducts() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let ids = ProductID.allCases.map(\.rawValue)
            products = try await Product.products(for: ids)
            logger.info("Loaded \(self.products.count) products")
        } catch {
            logger.error("Failed to load products: \(error.localizedDescription)")
        }
    }

    // MARK: – Purchase

    /// Purchase a product and return the JWS-encoded transaction for server verification.
    func purchase(_ product: Product, appAccountToken: UUID? = nil) async throws -> (
        transaction: Transaction,
        jwsRepresentation: String
    ) {
        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken {
            options.insert(.appAccountToken(token))
        }

        let result = try await product.purchase(options: options)

        switch result {
        case .success(let verification):
            let transaction = try checkVerified(verification)
            await transaction.finish()
            await updatePurchasedProducts()

            // Return the JWS representation for server-side verification
            let jws: String
            switch verification {
            case .verified:
                jws = verification.jwsRepresentation
            case .unverified(_, _):
                jws = verification.jwsRepresentation
            }

            logger.info("Purchase succeeded: \(product.id)")
            return (transaction, jws)

        case .userCancelled:
            throw StoreKitError.userCancelled

        case .pending:
            throw StoreKitError.purchasePending

        @unknown default:
            throw StoreKitError.unknown
        }
    }

    /// Purchase by product ID string (used by the native message handler).
    func purchase(productId: String, appAccountToken: UUID? = nil) async throws -> (
        transaction: Transaction,
        jwsRepresentation: String
    ) {
        guard let product = products.first(where: { $0.id == productId }) else {
            // Try loading products first
            await loadProducts()
            guard let product = products.first(where: { $0.id == productId }) else {
                throw StoreKitError.productNotFound
            }
            return try await purchase(product, appAccountToken: appAccountToken)
        }
        return try await purchase(product, appAccountToken: appAccountToken)
    }

    // MARK: – Restore

    func restorePurchases() async {
        try? await AppStore.sync()
        await updatePurchasedProducts()
    }

    // MARK: – Subscription status

    func currentSubscriptionStatus() async -> SubscriptionInfo {
        for product in products {
            guard let subscription = product.subscription else { continue }

            if let status = try? await subscription.status.first(where: {
                $0.state == .subscribed || $0.state == .inGracePeriod
            }) {
                let renewalInfo = try? checkVerifiedRenewalInfo(status.renewalInfo)
                let transaction = try? checkVerified(status.transaction)

                return SubscriptionInfo(
                    isSubscribed: true,
                    productId: product.id,
                    expirationDate: transaction?.expirationDate,
                    isInGracePeriod: status.state == .inGracePeriod,
                    willAutoRenew: renewalInfo?.willAutoRenew ?? false
                )
            }
        }

        return SubscriptionInfo(isSubscribed: false)
    }

    // MARK: – Transaction listener

    /// Listens for transaction updates (renewals, revocations, etc.) in the background.
    private func listenForTransactions() -> Task<Void, Never> {
        Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                if let transaction = try? self.checkVerified(result) {
                    await transaction.finish()
                    await self.updatePurchasedProducts()
                }
            }
        }
    }

    // MARK: – Helpers

    private func updatePurchasedProducts() async {
        var purchased = Set<String>()

        for await result in Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                purchased.insert(transaction.productID)
            }
        }

        purchasedProductIDs = purchased
    }

    nonisolated private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .verified(let safe):
            return safe
        case .unverified(_, let error):
            throw error
        }
    }

    private func checkVerifiedRenewalInfo(
        _ result: VerificationResult<Product.SubscriptionInfo.RenewalInfo>
    ) throws -> Product.SubscriptionInfo.RenewalInfo {
        switch result {
        case .verified(let info):
            return info
        case .unverified(_, let error):
            throw error
        }
    }

    // MARK: – Manage subscriptions

    /// Returns the URL for managing subscriptions.
    /// The caller (SafariWebExtensionHandler) passes it to JS, which opens it in a browser tab.
    /// UIApplication.shared / NSWorkspace.shared are unavailable in App Extensions.
    func manageSubscriptionsURL() -> String {
        return "https://apps.apple.com/account/subscriptions"
    }
}

// MARK: – Types

struct SubscriptionInfo {
    let isSubscribed: Bool
    var productId: String?
    var expirationDate: Date?
    var isInGracePeriod: Bool = false
    var willAutoRenew: Bool = false
}

enum StoreKitError: LocalizedError {
    case userCancelled
    case purchasePending
    case productNotFound
    case unknown

    var errorDescription: String? {
        switch self {
        case .userCancelled:  return "Purchase was cancelled."
        case .purchasePending: return "Purchase is pending approval."
        case .productNotFound: return "Product not found."
        case .unknown:         return "An unknown error occurred."
        }
    }
}
