import Combine
import Foundation
import StoreKit
import SwiftUI

/// App Store subscriptions (StoreKit 2). Purchases happen in the app; after any
/// change the current entitlement — including Apple's signed transaction — is
/// written to the App Group so the Safari extension can use it.
@MainActor
final class StoreKitManager: ObservableObject {
    static let shared = StoreKitManager()

    enum ProductID {
        static let pro = "com.contextflow.pro.monthly"
        // Optional: shown automatically once created in App Store Connect.
        static let proYearly = "com.contextflow.pro.yearly"
        static let byok = "com.contextflow.byok.monthly"
        static let all = [pro, proYearly, byok]
    }

    @Published private(set) var products: [Product] = []
    @Published private(set) var entitlement: SharedEntitlement = SharedDefaults.shared.readEntitlement()
    @Published private(set) var isLoadingProducts = false
    @Published private(set) var productsFailed = false

    private var updates: Task<Void, Never>?

    private init() {
        // Before anything here writes the App Group: the app's first launch is told from an update by it.
        _ = Activation.shared
        updates = Task.detached { [weak self] in
            for await result in StoreKit.Transaction.updates {
                if case .verified(let transaction) = result {
                    await transaction.finish()
                }
                await self?.refreshEntitlement()
            }
        }
        Task {
            await loadProducts()
            await refreshEntitlement()
        }
    }

    @Published private(set) var introEligible: Set<String> = []

    var pro: Product? { products.first { $0.id == ProductID.pro } }
    var proYearly: Product? { products.first { $0.id == ProductID.proYearly } }
    var byok: Product? { products.first { $0.id == ProductID.byok } }

    func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            let loaded = try await Product.products(for: ProductID.all)
            products = loaded.sorted { $0.price > $1.price }
            productsFailed = loaded.isEmpty
            var eligible = Set<String>()
            for product in loaded {
                if let subscription = product.subscription,
                   subscription.introductoryOffer != nil,
                   await subscription.isEligibleForIntroOffer {
                    eligible.insert(product.id)
                }
            }
            introEligible = eligible
        } catch {
            productsFailed = true
        }
    }

    enum PurchaseOutcome {
        case purchased, cancelled, pending
    }

    func purchase(_ product: Product) async throws -> PurchaseOutcome {
        // The install id travels with the transaction (appAccountToken), so the server can tell which
        // install subscribed — still without accounts.
        let options: Set<Product.PurchaseOption> = Activation.shared.accountToken.map { [.appAccountToken($0)] } ?? []
        let result = try await product.purchase(options: options)
        switch result {
        case .success(let verification):
            guard case .verified(let transaction) = verification else {
                throw StoreError.unverified
            }
            await transaction.finish()
            await refreshEntitlement()
            return .purchased
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            return .cancelled
        }
    }

    /// "Restore Purchases": re-syncs with the App Store (may ask the user to sign in).
    func restore() async -> Bool {
        try? await AppStore.sync()
        await refreshEntitlement()
        return entitlement.active
    }

    /// Reads the active subscription from StoreKit and shares it with the extension.
    func refreshEntitlement() async {
        var best: (transaction: StoreKit.Transaction, jws: String)?
        for await result in StoreKit.Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  ProductID.all.contains(transaction.productID),
                  transaction.revocationDate == nil else { continue }
            let better = best.map { ($0.transaction.expirationDate ?? .distantPast) < (transaction.expirationDate ?? .distantPast) } ?? true
            if better { best = (transaction, result.jwsRepresentation) }
        }

        let value: SharedEntitlement
        if let best {
            value = SharedEntitlement(
                active: true,
                productId: best.transaction.productID,
                expiresAt: best.transaction.expirationDate,
                jws: best.jws,
                updatedAt: Date()
            )
        } else {
            value = SharedEntitlement(active: false, productId: nil, expiresAt: nil, jws: nil, updatedAt: Date())
        }
        entitlement = value
        SharedDefaults.shared.writeEntitlement(value)
    }

    enum StoreError: LocalizedError {
        case unverified
        var errorDescription: String? {
            String(localized: "The App Store could not verify this purchase. Please try again.")
        }
    }
}
