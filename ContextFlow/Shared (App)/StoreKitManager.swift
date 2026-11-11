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

    /// The products (2.6: Ultra, and yearly plans). A product not yet created in App Store Connect simply doesn't load:
    /// the paywall shows the plan with the periods it has.
    enum ProductID {
        static let ultra = "com.contextflow.ultra.monthly"
        static let ultraYearly = "com.contextflow.ultra.yearly"
        static let pro = "com.contextflow.pro.monthly"
        static let proYearly = "com.contextflow.pro.yearly"
        static let byok = "com.contextflow.byok.monthly"
        static let byokYearly = "com.contextflow.byok.yearly"
        static let all = [ultra, ultraYearly, pro, proYearly, byok, byokYearly]
    }

    enum Tier: String, CaseIterable, Identifiable {
        case byok, pro, ultra
        var id: String { rawValue }
        /// Subscription group order: moving up starts at once (an upgrade), moving down at the next renewal.
        var rank: Int {
            switch self {
            case .byok: return 1
            case .pro: return 2
            case .ultra: return 3
            }
        }
        func productId(yearly: Bool) -> String {
            switch self {
            case .byok: return yearly ? ProductID.byokYearly : ProductID.byok
            case .pro: return yearly ? ProductID.proYearly : ProductID.pro
            case .ultra: return yearly ? ProductID.ultraYearly : ProductID.ultra
            }
        }
        static func of(_ productId: String?) -> Tier? { Tier(rawValue: PlanProducts.plan(of: productId)) }
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

    func product(_ tier: Tier, yearly: Bool) -> Product? {
        products.first { $0.id == tier.productId(yearly: yearly) }
    }

    /// The current plan's tier (nil: none).
    var tier: Tier? { entitlement.active ? Tier.of(entitlement.productId) : nil }

    /// A plan's yearly price against twelve months of it, in the App Store's own currency format (build 90: the owner
    /// saw nothing selling the yearly plan). Nil when either isn't on sale or it saves under 5%.
    struct YearlyDeal: Equatable {
        let perMonth: String
        let saving: String
        let percent: Int
        let twelveMonths: String
    }

    func yearlyDeal(_ tier: Tier) -> YearlyDeal? {
        guard let monthly = product(tier, yearly: false), let yearly = product(tier, yearly: true) else { return nil }
        return Self.deal(monthly: monthly, yearly: yearly)
    }

    static func deal(monthly: Product, yearly: Product) -> YearlyDeal? {
        guard monthly.price > 0 else { return nil }
        let full = monthly.price * 12
        guard full > yearly.price else { return nil }
        // doubleValue: NSDecimalNumber.intValue misreads a long quotient (it gave no badge).
        let percent = Int((NSDecimalNumber(decimal: (full - yearly.price) / full).doubleValue * 100).rounded())
        guard percent >= 5 else { return nil }
        let style = yearly.priceFormatStyle
        return YearlyDeal(perMonth: (yearly.price / 12).formatted(style), saving: (full - yearly.price).formatted(style), percent: percent, twelveMonths: full.formatted(style))
    }

    /// The best yearly saving on offer (for the monthly/yearly switch).
    var bestYearlySaving: Int? {
        Tier.allCases.compactMap { yearlyDeal($0)?.percent }.max()
    }

    /// The App Store's currency when its prices don't say it themselves (build 95, the owner's App Store of Canada: CAD
    /// reads "$12.99", the same as dollars of the US): a currency other than USD written with a bare "$" (as the panel).
    var unclearCurrency: String? {
        guard let code = products.first?.priceFormatStyle.currencyCode.uppercased(), code.count == 3, code != "USD" else { return nil }
        let bare = products.contains { $0.displayPrice.contains("$") && !$0.displayPrice.contains(where: \.isLetter) }
        return bare ? code : nil
    }

    /// A monthly Pro or Ultra subscriber whose plan is also sold yearly: what switching saves (Settings, the panel).
    /// Gone once the switch is made (yearly starts at the renewal; until then the month runs on).
    var yearlySwitch: (tier: Tier, deal: YearlyDeal, product: Product)? {
        guard let tier, tier != .byok, product(tier, yearly: false)?.id == entitlement.productId,
              let yearly = product(tier, yearly: true), renewsTo != yearly.id, let deal = yearlyDeal(tier) else { return nil }
        return (tier, deal, yearly)
    }

    /// The product the subscription renews into (a switch to yearly shows here before it starts).
    @Published private(set) var renewsTo: String?

    /// What the plans say, from the server (the defaults until it answers).
    @Published private(set) var planFacts = ChatAI.PlanFacts()

    func refreshPlanFacts() async {
        if let facts = await ChatAI.planFacts() { planFacts = facts }
    }

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
        return entitlement.active && PlanProducts.byok.contains(entitlement.productId ?? "")
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

    /// Pro or Ultra is active (Ultra counts as Pro; the own-key plan isn't Pro): AI search, "Ask your chats".
    var isPro: Bool {
        #if DEBUG
        // Local checks against the Pro stand (tools/preview, PREVIEW_PLAN=pro): -CFDebugPro YES.
        if UserDefaults.standard.bool(forKey: "CFDebugPro") || UserDefaults.standard.bool(forKey: "CFDebugUltra") { return true }
        #endif
        return entitlement.active && ["pro", "ultra"].contains(PlanProducts.plan(of: entitlement.productId))
    }

    /// Ultra is active (2.6): read aloud, find similar, more watched pages. `-CFDebugUltra YES` in Debug builds.
    var isUltra: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFDebugUltra") { return true }
        #endif
        return entitlement.active && PlanProducts.plan(of: entitlement.productId) == "ultra"
    }

    func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            let loaded = try await Product.products(for: ProductID.all)
            products = loaded.sorted { $0.price > $1.price }
            productsFailed = loaded.isEmpty
            // The panel's plans sheet shows these prices (it can't ask the App Store itself).
            // The panel's plans sheet shows these (with each yearly plan's month and saving).
            if !loaded.isEmpty { SharedDefaults.shared.writePrices(PlanProducts.priceTable(loaded, storefront: await Storefront.current?.countryCode)) }
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
            #if os(iOS)
            // Ultra (2.6): read aloud carries on from Safari only with notifications, so they're asked about once (after
            // the plan's tour).
            if transaction.productID.contains(".ultra.") { Task { await NotifyAsk.shared.afterUltra() } }
            #endif
            return .purchased
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            return .cancelled
        }
    }

    /// Restore Purchases is running: the plan it brings back isn't a purchase (no plan tour).
    private var restoring = false

    /// "Restore Purchases": re-syncs with the App Store (may ask the user to sign in).
    func restore() async -> Bool {
        restoring = true
        defer { restoring = false }
        try? await AppStore.sync()
        await refreshEntitlement()
        return entitlement.active
    }

    /// Reads the active subscription from StoreKit and shares it with the extension.
    func refreshEntitlement() async {
        var best: (transaction: StoreKit.Transaction, jws: String)?
        for await result in StoreKit.Transaction.currentEntitlements {
            // An Own key subscription upgraded to Pro (or Pro to Ultra) stays listed until it ends: the higher plan
            // counts from the purchase.
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
        let before = entitlement.active ? Tier.of(entitlement.productId) : nil
        if let best { renewsTo = await Self.renewalProduct(of: best.transaction) }
        entitlement = value
        SharedDefaults.shared.writeEntitlement(value)
        // Build 90: a plan that starts (bought, upgraded, or a different one at renewal) is announced once, for the
        // onboarding to its features: .cfPlanChanged here (userInfo from / to / productId), "planChange" for the panel.
        let after = value.active ? Tier.of(value.productId) : nil
        if let after, after != before, let productId = value.productId {
            let from = before?.rawValue ?? "free"
            SharedDefaults.shared.writePlanChange(from: from, to: after.rawValue, productId: productId)
            NotificationCenter.default.post(name: .cfPlanChanged, object: nil, userInfo: ["from": from, "to": after.rawValue, "productId": productId])
        }
        planSeen(value)
    }

    /// The one place the app sees its plan (after every refresh, from StoreKit, never the App Group's cached copy): a
    /// move up starts the tour of what the plan adds (PlanTour). PlanTour filters by the last plan it stored: the first
    /// plan seen (an update, or a fresh install whose subscription StoreKit already has) and Restore show nothing.
    // `.cfPlanChanged` (ultra-26, branch claude/ultra-26-build90) can replace this hook once that's merged.
    private func planSeen(_ value: SharedEntitlement) {
        PlanTour.shared.planSeen(value.active ? Tier.of(value.productId) : nil, quietly: restoring)
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

extension StoreKitManager {
    /// What the subscription of `transaction` renews into (its own product, or the one the user switched to).
    static func renewalProduct(of transaction: StoreKit.Transaction) async -> String? {
        guard let group = transaction.subscriptionGroupID,
              let statuses = try? await Product.SubscriptionInfo.status(for: group) else { return nil }
        for status in statuses {
            guard case .verified(let renewal) = status.renewalInfo, renewal.originalTransactionID == transaction.originalID else { continue }
            return renewal.autoRenewPreference
        }
        return nil
    }
}

extension Notification.Name {
    /// A plan started on this device (build 90): userInfo "from" ("free", "byok", "pro", "ultra"), "to", "productId".
    static let cfPlanChanged = Notification.Name("cfPlanChanged")
}
