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

    /// Pro with auto-renew turned off: the subscription to ask "what was missing" about, once per period
    /// (the app and the panel share the mark). `-CFDebugRenewalOff YES` shows it in Debug builds.
    var renewalOff: SharedEntitlement? {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFDebugRenewalOff") {
            // The same period all day, so "once per period" can be checked.
            let end = Calendar.current.startOfDay(for: Date()).addingTimeInterval(12 * 86_400)
            return SharedEntitlement(active: true, productId: ProductID.pro, expiresAt: end, jws: nil, updatedAt: Date(), autoRenew: false)
        }
        #endif
        guard isPro, entitlement.autoRenew == false else { return nil }
        return entitlement
    }

    /// The Own key plan is active (not Pro). `-CFDebugByok YES` in Debug builds, with
    /// `-CFDebugByokRefusedHoursAgo 25` for a refusal that long ago.
    var isByok: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFDebugByok") { return true }
        #endif
        return entitlement.active && entitlement.productId == ProductID.byok
    }

    /// Own key → Pro at this discount (%), when the server has the promotional offer set up; nil otherwise.
    @Published private(set) var upgradeDiscount: Int?
    /// Google answers: the free allowance a day (Own key gets it too) and Pro's a week, as the server says.
    @Published private(set) var searchFreeDaily = 3
    @Published private(set) var searchProWeekly = 50

    /// Asks the server whether Own key subscribers can move to Pro at a discount now, and its Google allowances.
    func refreshUpgradeOffer() async {
        #if DEBUG
        let hours = UserDefaults.standard.integer(forKey: "CFDebugByokRefusedHoursAgo")
        if isByok, hours > 0 { SharedDefaults.shared.markByokRefused(entitlement.period, at: Date().addingTimeInterval(-Double(hours) * 3600)) }
        #endif
        guard isByok, let status = await ChatAI.upgradeStatus() else {
            upgradeDiscount = nil
            return
        }
        upgradeDiscount = status.discount
        searchFreeDaily = status.searchFreeDaily ?? searchFreeDaily
        searchProWeekly = status.searchProWeekly ?? searchProWeekly
    }

    /// Pro at a discount is due: an Own key subscriber, the offer is set up, and a day has passed since the first
    /// refusal of this period (in the app or the Safari panel).
    var byokOfferDue: Bool {
        guard isByok, upgradeDiscount != nil, let refused = SharedDefaults.shared.byokRefusedAt(entitlement.period) else { return false }
        return Date().timeIntervalSince(refused) >= 24 * 3600
    }

    /// Pro at a discount is on screen in this run of the app (marked as shown for the period when it appeared).
    @Published var byokOfferVisible = false

    /// Shows Pro at a discount when it's due and wasn't shown this period (in the app or the panel).
    func showByokOfferIfDue() {
        guard byokOfferDue, !SharedDefaults.shared.byokOfferShown(entitlement.period) else { return }
        SharedDefaults.shared.markByokOfferShown(entitlement.period)
        byokOfferVisible = true
    }

    /// Notes a refusal of an Own key subscriber (a limit, or a Pro-only feature); the first one of the period counts.
    func noteByokRefusal() {
        if isByok { SharedDefaults.shared.markByokRefused(entitlement.period) }
    }

    /// Pro at the discount: the server signs Apple's promotional offer, then the App Store sheet shows the price.
    func upgradeWithOffer() async throws -> PurchaseOutcome {
        let signature = try await ChatAI.promoSignature()
        guard let pro else { throw StoreError.noPlans }
        return try await purchase(pro, offer: signature)
    }

    /// Pro is active (the own-key plan isn't Pro): AI search, "Ask your chats", no Pro tab in the app.
    var isPro: Bool {
        #if DEBUG
        // Local checks against the Pro stand (tools/preview, PREVIEW_PLAN=pro): -CFDebugPro YES.
        if UserDefaults.standard.bool(forKey: "CFDebugPro") { return true }
        #endif
        return entitlement.active && entitlement.productId != ProductID.byok
    }

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

    func purchase(_ product: Product, offer: ChatAI.PromoSignature? = nil) async throws -> PurchaseOutcome {
        // The install id travels with the transaction (appAccountToken), so the server can tell which
        // install subscribed — still without accounts.
        var options: Set<Product.PurchaseOption> = Activation.shared.accountToken.map { [.appAccountToken($0)] } ?? []
        if let offer {
            options.insert(.promotionalOffer(offerID: offer.offerId, keyID: offer.keyId, nonce: offer.nonce, signature: offer.signature, timestamp: offer.timestamp))
        }
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
            // An Own key subscription upgraded to Pro stays listed until it ends: Pro counts from the purchase.
            guard case .verified(let transaction) = result,
                  ProductID.all.contains(transaction.productID),
                  transaction.revocationDate == nil, !transaction.isUpgraded else { continue }
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
                updatedAt: Date(),
                autoRenew: await SharedEntitlement.autoRenew(of: best.transaction)
            )
        } else {
            value = SharedEntitlement(active: false, productId: nil, expiresAt: nil, jws: nil, updatedAt: Date())
        }
        entitlement = value
        SharedDefaults.shared.writeEntitlement(value)
    }

    enum StoreError: LocalizedError {
        case unverified
        /// The plans didn't load (no connection, or the App Store didn't answer).
        case noPlans
        var errorDescription: String? {
            switch self {
            case .unverified: return String(localized: "The App Store could not verify this purchase. Please try again.")
            case .noPlans: return String(localized: "Plans couldn't be loaded. Check your connection.")
            }
        }
    }
}
