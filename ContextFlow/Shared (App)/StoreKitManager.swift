import StoreKit
import Combine
import os.log

/// Manages App Store subscriptions via StoreKit 2.
///
/// This class is used by the native container app to handle purchases.
/// After each purchase/restore/status change, it writes the subscription
/// status to SharedDefaults so the Safari extension can read it.
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
    @Published private(set) var currentStatus = SubscriptionInfo(isSubscribed: false)

    // MARK: – Private

    private let logger = Logger(subsystem: "com.contextflow.app", category: "StoreKit")
    private var transactionListener: Task<Void, Never>?

    // MARK: – Lifecycle

    private init() {
        transactionListener = listenForTransactions()
        Task {
            await loadProducts()
            print("[ContextFlow][StoreKit] Init: loaded \(self.products.count) products: \(self.products.map(\.id))")
            await refreshSubscriptionStatus()
            print("[ContextFlow][StoreKit] Init: subscription status = subscribed:\(self.currentStatus.isSubscribed), product:\(self.currentStatus.productId ?? "none")")
        }
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

    /// Purchase a product. After success, writes status to SharedDefaults.
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

            // Immediately write subscription status from the successful transaction.
            let immediateStatus = SubscriptionInfo(
                isSubscribed: true,
                productId: transaction.productID,
                expirationDate: transaction.expirationDate,
                willAutoRenew: true
            )
            currentStatus = immediateStatus
            purchasedProductIDs.insert(product.id)
            SharedDefaults.shared.writeSubscriptionStatus(immediateStatus)

            // Also refresh via the standard path (non-blocking).
            // This will reconcile with StoreKit's subscription.status eventually.
            Task { await refreshSubscriptionStatus() }

            let jws = verification.jwsRepresentation

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

    /// Purchase by product ID string.
    func purchase(productId: String, appAccountToken: UUID? = nil) async throws -> (
        transaction: Transaction,
        jwsRepresentation: String
    ) {
        guard let product = products.first(where: { $0.id == productId }) else {
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
        // Ensure products are loaded before querying status — querySubscriptionStatus()
        // iterates self.products, which may be empty on a slow network.
        if products.isEmpty {
            await loadProducts()
        }
        await refreshSubscriptionStatus()
    }

    // MARK: – Subscription status

    /// Refresh subscription status and write to SharedDefaults.
    func refreshSubscriptionStatus() async {
        // Ensure products are loaded before querying — querySubscriptionStatus()
        // iterates self.products, and would return isSubscribed=false if empty.
        if products.isEmpty {
            await loadProducts()
        }

        let status = await querySubscriptionStatus()

        // Guard against overwriting a recently-written active status.
        // In Sandbox, subscription.status can lag behind an actual purchase,
        // and a background refresh can race with the immediate write in purchase().
        if !status.isSubscribed && currentStatus.isSubscribed {
            if products.isEmpty {
                logger.warning("Skipping status downgrade — products not loaded")
                return
            }
            let lastUpdated = SharedDefaults.shared.lastUpdatedTimestamp
            let elapsed = Date().timeIntervalSince1970 - lastUpdated
            if elapsed < 120 {
                logger.warning("Skipping status downgrade — last update was \(Int(elapsed))s ago (< 120s)")
                return
            }
        }

        currentStatus = status

        // Write to SharedDefaults so the extension can read it
        SharedDefaults.shared.writeSubscriptionStatus(status)

        // Update purchased product IDs
        var purchased = Set<String>()
        for await result in Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                purchased.insert(transaction.productID)
            }
        }
        purchasedProductIDs = purchased
    }

    /// Query StoreKit for current subscription status.
    /// Uses Transaction.currentEntitlements as the primary check (reliable in both
    /// Production and Sandbox), then falls back to subscription.status.
    private func querySubscriptionStatus() async -> SubscriptionInfo {
        // Primary: check Transaction.currentEntitlements — Apple's recommended approach.
        let productIDs = Set(ProductID.allCases.map(\.rawValue))
        print("[ContextFlow][StoreKit] Querying subscription. Product IDs: \(productIDs)")

        // First, collect renewal info from subscription.status (needed for pending switches)
        var pendingSwitch: String? = nil
        for product in products {
            guard let subscription = product.subscription else { continue }
            if let status = try? await subscription.status.first(where: {
                $0.state == .subscribed || $0.state == .inGracePeriod
            }) {
                if let renewalInfo = try? checkVerifiedRenewalInfo(status.renewalInfo) {
                    // autoRenewPreference is the product the user switched to
                    if let preference = renewalInfo.autoRenewPreference,
                       preference != product.id {
                        pendingSwitch = preference
                    }
                }
            }
        }

        var entitlementCount = 0
        for await result in Transaction.currentEntitlements {
            entitlementCount += 1
            if let transaction = try? checkVerified(result) {
                if productIDs.contains(transaction.productID) &&
                   transaction.productType == .autoRenewable {
                    return SubscriptionInfo(
                        isSubscribed: true,
                        productId: transaction.productID,
                        expirationDate: transaction.expirationDate,
                        willAutoRenew: true,
                        pendingProductId: pendingSwitch
                    )
                }
            }
        }

        // Fallback: check subscription.status on each product
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
                    willAutoRenew: renewalInfo?.willAutoRenew ?? false,
                    pendingProductId: pendingSwitch
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
                    await self.refreshSubscriptionStatus()
                }
            }
        }
    }

    // MARK: – Helpers

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

    func manageSubscriptionsURL() -> String {
        return "https://apps.apple.com/account/subscriptions"
    }
}

// MARK: – Types
// NOTE: SubscriptionInfo is defined in SharedDefaults.swift (shared between App and Extension targets)

enum StoreKitError: LocalizedError, Equatable {
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
