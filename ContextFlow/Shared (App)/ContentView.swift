import Combine
import Foundation
import StoreKit
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
import SafariServices
#endif

// MARK: - Constants

enum Links {
    static let privacy = URL(string: "https://aisidebar.netlify.app/privacy")!
    static let terms = URL(string: "https://aisidebar.netlify.app/terms")!
    static let support = URL(string: "https://aisidebar.netlify.app/support")!
    static let review = URL(string: "https://apps.apple.com/app/id6759115793?action=write-review")!
    static let manageSubscriptions = URL(string: "https://apps.apple.com/account/subscriptions")!
}

let brandGradient = LinearGradient(
    colors: [Color(red: 0.22, green: 0.74, blue: 0.97), Color(red: 0.15, green: 0.39, blue: 0.92)],
    startPoint: .topLeading,
    endPoint: .bottomTrailing
)
let brandBlue = Color(red: 0.15, green: 0.39, blue: 0.92)

// MARK: - Deep links (contextflow://subscribe, contextflow://manage, contextflow://open)

final class DeepLinkRouter: ObservableObject {
    static let shared = DeepLinkRouter()
    @Published var pending: URL?

    func handle(_ url: URL) {
        guard url.scheme == "contextflow" else { return }
        pending = url
    }
}

enum AppTab: Hashable {
    case home, pro
}

// MARK: - Root

struct ContentView: View {
    @StateObject private var store = StoreKitManager.shared
    @StateObject private var router = DeepLinkRouter.shared
    @State private var tab: AppTab = .home

    var body: some View {
        root
            .tint(brandBlue)
            .onReceive(router.$pending.compactMap { $0 }) { url in
                tab = (url.host == "subscribe" || url.host == "manage") ? .pro : .home
                router.pending = nil
            }
            .task {
                SharedDefaults.shared.removeLegacyData()
                await store.refreshEntitlement()
            }
    }

    @ViewBuilder
    private var root: some View {
        #if os(iOS)
        TabView(selection: $tab) {
            NavigationView { HomeView(store: store, openPro: { tab = .pro }) }
                .navigationViewStyle(.stack)
                .tabItem { Label("Get Started", systemImage: "sparkles") }
                .tag(AppTab.home)
            NavigationView { ProView(store: store) }
                .navigationViewStyle(.stack)
                .tabItem { Label("Pro", systemImage: "crown") }
                .tag(AppTab.pro)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await store.refreshEntitlement() }
        }
        #else
        NavigationSplitView {
            List(selection: Binding<AppTab?>(get: { tab }, set: { tab = $0 ?? .home })) {
                Label("Get Started", systemImage: "sparkles").tag(AppTab.home)
                Label("Pro", systemImage: "crown").tag(AppTab.pro)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            switch tab {
            case .home: HomeView(store: store, openPro: { tab = .pro })
            case .pro: ProView(store: store)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await store.refreshEntitlement() }
        }
        #endif
    }
}

// MARK: - Home

struct HomeView: View {
    @ObservedObject var store: StoreKitManager
    var openPro: () -> Void
    #if os(macOS)
    @State private var extensionEnabled: Bool?
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                #if os(macOS)
                macStatus
                #else
                setupCard
                #endif
                howToCard
                planCard
                footer
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("ContextFlow")
        #if os(macOS)
        .onAppear(perform: refreshExtensionState)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in refreshExtensionState() }
        #endif
    }

    private var header: some View {
        HStack(spacing: 16) {
            Image("LargeIcon")
                .resizable()
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("AI for every page in Safari")
                    .font(.title2.weight(.bold))
                Text("Summarize, explain and translate what you're reading — without leaving the page.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 8)
    }

    #if os(iOS)
    private var setupCard: some View {
        Card(title: "Turn on ContextFlow", systemImage: "switch.2") {
            Step(number: 1, text: "Open the Settings app and go to Apps → Safari → Extensions.")
            Step(number: 2, text: "Tap ContextFlow and switch it on.")
            Step(number: 3, text: "Under Permissions, set All Websites to Allow.")
            Button {
                openSafari()
            } label: {
                Label("Open Safari", systemImage: "safari")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 4)
        }
    }

    private func openSafari() {
        // x-web-search:// always opens Safari, even when another browser is the default.
        guard let url = URL(string: "x-web-search://?ContextFlow") else { return }
        UIApplication.shared.open(url) { opened in
            if !opened, let fallback = URL(string: "https://www.apple.com/") {
                UIApplication.shared.open(fallback)
            }
        }
    }
    #endif

    #if os(macOS)
    private var macStatus: some View {
        Card(title: "Safari extension", systemImage: "puzzlepiece.extension") {
            HStack(spacing: 10) {
                Image(systemName: extensionEnabled == true ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundColor(extensionEnabled == true ? .green : .orange)
                    .font(.title3)
                Text(extensionEnabled == true ? LocalizedStringKey("ContextFlow is on in Safari.") : LocalizedStringKey("ContextFlow is turned off in Safari."))
                    .font(.body.weight(.medium))
            }
            if extensionEnabled != true {
                Text("Open Safari Settings → Extensions, tick ContextFlow and allow it on all websites.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            Button {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
            } label: {
                Label("Open Safari Settings", systemImage: "gearshape")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
            DispatchQueue.main.async { extensionEnabled = state?.isEnabled }
        }
    }
    #endif

    private var howToCard: some View {
        Card(title: "How to use it", systemImage: "hand.tap") {
            #if os(iOS)
            Step(number: 1, text: "Open any article, product page or document in Safari.")
            Step(number: 2, text: "Tap the ✦ button on the page — or tap the page menu in the address bar and choose ContextFlow.")
            Step(number: 3, text: "Pick Summarize, Key takeaways, Explain or Translate, or ask your own question.")
            Step(number: 4, text: "Select text first to ask about just that part.")
            #else
            Step(number: 1, text: "Open any page in Safari.")
            Step(number: 2, text: "Click the ContextFlow icon in the toolbar or press Control-Shift-E.")
            Step(number: 3, text: "Pick Summarize, Key takeaways, Explain or Translate, or ask your own question.")
            Step(number: 4, text: "Select text on the page and click “Ask AI” to ask about just that part.")
            #endif
        }
    }

    private var planCard: some View {
        Card(title: "Your plan", systemImage: "crown") {
            if store.entitlement.active {
                HStack {
                    Text(planName(store.entitlement.productId))
                        .font(.headline)
                    Spacer()
                    if let date = store.entitlement.expiresAt {
                        Text("Renews \(date, style: .date)")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                }
            } else {
                Text("Free: 5 answers every day.")
                    .font(.headline)
                Text("Pro gives you up to 375 answers a week on iPhone, iPad and Mac.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                Button("See Pro", action: openPro)
                    .buttonStyle(.bordered)
            }
        }
    }

    private var footer: some View {
        FooterLinks()
            .padding(.top, 4)
    }
}

// MARK: - Pro

struct ProView: View {
    @ObservedObject var store: StoreKitManager
    @Environment(\.requestReview) private var requestReview
    @Environment(\.openURL) private var openURL
    @State private var busyProduct: String?
    @State private var restoring = false
    @State private var message: String?
    @State private var success = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                hero
                if store.entitlement.active { activeCard }
                features
                products
                actions
                legal
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("ContextFlow Pro")
        .alert(isPresented: $success) {
            Alert(
                title: Text("You're all set"),
                message: Text("Pro is active. Open Safari and tap ✦ on any page."),
                dismissButton: .default(Text("OK")) { requestReview() }
            )
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Read less. Understand more.")
                .font(.largeTitle.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            Text("Get answers about everything you read in Safari, all week long.")
                .font(.body)
                .foregroundColor(.secondary)
        }
    }

    private var activeCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill")
                .font(.title2)
                .foregroundColor(.white)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(planName(store.entitlement.productId)) is active")
                    .font(.headline)
                    .foregroundColor(.white)
                if let date = store.entitlement.expiresAt {
                    Text("Renews \(date, style: .date)")
                        .font(.footnote)
                        .foregroundColor(.white.opacity(0.85))
                }
            }
            Spacer()
        }
        .padding(16)
        .background(brandGradient)
        .cornerRadius(16)
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 10) {
            Feature(systemImage: "bolt.fill", text: "Up to 375 answers a week instead of 5 a day")
            Feature(systemImage: "doc.text.magnifyingglass", text: "Summaries, key takeaways, explanations and translations of any page")
            Feature(systemImage: "text.cursor", text: "Ask about selected text, rewrite it or draft a reply")
            Feature(systemImage: "key.fill", text: "Optional: use your own OpenAI key")
            Feature(systemImage: "laptopcomputer.and.iphone", text: "One subscription for iPhone, iPad and Mac")
        }
    }

    @ViewBuilder
    private var products: some View {
        if store.products.isEmpty {
            HStack(spacing: 10) {
                if store.isLoadingProducts {
                    ProgressView()
                    Text("Loading plans…").foregroundColor(.secondary)
                } else {
                    Text("Plans couldn't be loaded. Check your connection.")
                        .foregroundColor(.secondary)
                    Button("Retry") { Task { await store.loadProducts() } }
                }
            }
        } else {
            VStack(spacing: 12) {
                if let pro = store.pro {
                    PlanCard(
                        product: pro,
                        title: "Pro",
                        subtitle: "Everything included. No API key needed.",
                        badge: "Recommended",
                        highlighted: store.proYearly == nil,
                        trialEligible: store.introEligible.contains(pro.id),
                        current: store.entitlement.productId == pro.id,
                        busy: busyProduct == pro.id,
                        action: { buy(pro) }
                    )
                }
                if let yearly = store.proYearly {
                    PlanCard(
                        product: yearly,
                        title: "Pro yearly",
                        subtitle: "Everything in Pro for a whole year.",
                        badge: savingsBadge(yearly: yearly, monthly: store.pro),
                        highlighted: true,
                        trialEligible: store.introEligible.contains(yearly.id),
                        current: store.entitlement.productId == yearly.id,
                        busy: busyProduct == yearly.id,
                        action: { buy(yearly) }
                    )
                }
                if let byok = store.byok {
                    PlanCard(
                        product: byok,
                        title: "Own key",
                        subtitle: "Unlimited answers with your own OpenAI API key.",
                        badge: nil,
                        highlighted: false,
                        trialEligible: store.introEligible.contains(byok.id),
                        current: store.entitlement.productId == byok.id,
                        busy: busyProduct == byok.id,
                        action: { buy(byok) }
                    )
                }
            }
        }
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundColor(.secondary)
        }
    }

    private var actions: some View {
        HStack(spacing: 16) {
            Button {
                restoring = true
                Task {
                    let restored = await store.restore()
                    restoring = false
                    message = restored ? String(localized: "Your subscription has been restored.") : String(localized: "No active subscription was found for this Apple Account.")
                }
            } label: {
                if restoring { ProgressView() } else { Text("Restore Purchases") }
            }
            if store.entitlement.active {
                Button("Manage Subscription") { openURL(Links.manageSubscriptions) }
            }
        }
        .buttonStyle(.borderless)
        .font(.callout.weight(.medium))
    }

    private var legal: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Subscriptions renew automatically each month unless cancelled at least 24 hours before the end of the current period. Payment is charged to your Apple Account. You can manage or cancel your subscription in your App Store account settings.")
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 14) {
                Link("Terms of Use (EULA)", destination: Links.terms)
                Link("Privacy Policy", destination: Links.privacy)
            }
            .font(.caption.weight(.medium))
        }
        .padding(.top, 4)
    }

    private func savingsBadge(yearly: Product, monthly: Product?) -> LocalizedStringKey? {
        guard let monthly, monthly.price > 0 else { return nil }
        let full = monthly.price * 12
        guard full > yearly.price else { return nil }
        let percent = NSDecimalNumber(decimal: (full - yearly.price) / full * 100).intValue
        guard percent >= 5 else { return nil }
        let badge: LocalizedStringKey = "Save \(percent)%"
        return badge
    }

    private func buy(_ product: Product) {
        busyProduct = product.id
        message = nil
        Task {
            do {
                switch try await store.purchase(product) {
                case .purchased: success = true
                case .pending: message = String(localized: "Your purchase is waiting for approval.")
                case .cancelled: break
                }
            } catch {
                message = error.localizedDescription
            }
            busyProduct = nil
        }
    }
}

// MARK: - Components

func planName(_ productId: String?) -> String {
    productId == StoreKitManager.ProductID.byok ? String(localized: "Own key plan") : String(localized: "Pro")
}

struct Card<Content: View>: View {
    let title: LocalizedStringKey
    let systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardBackground)
        .cornerRadius(16)
    }

    private var cardBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}

struct Step: View {
    let number: Int
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundColor(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(brandBlue))
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct Feature: View {
    let systemImage: String
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundColor(brandBlue)
                .frame(width: 24)
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PlanCard: View {
    let product: Product
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let badge: LocalizedStringKey?
    let highlighted: Bool
    let trialEligible: Bool
    let current: Bool
    let busy: Bool
    let action: () -> Void

    private var yearly: Bool { product.subscription?.subscriptionPeriod.unit == .year }

    private var priceLine: String {
        yearly ? String(localized: "\(product.displayPrice) / year") : String(localized: "\(product.displayPrice) / month")
    }

    /// e.g. "1 week free, then $6.99 / month" — only when the user is eligible for the offer.
    private var trialLine: String? {
        guard trialEligible, let offer = product.subscription?.introductoryOffer, offer.paymentMode == .freeTrial else { return nil }
        return String(localized: "\(duration(offer.period)) free, then \(priceLine)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.title3.weight(.bold))
                if let badge {
                    Text(badge)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(brandBlue.opacity(0.15)))
                        .foregroundColor(brandBlue)
                }
                Spacer()
                Text(priceLine)
                    .font(.headline)
            }
            Text(subtitle)
                .font(.callout)
                .foregroundColor(.secondary)
            if let trialLine {
                Text(trialLine)
                    .font(.callout.weight(.semibold))
                    .foregroundColor(brandBlue)
            }
            Button(action: action) {
                Group {
                    if busy {
                        ProgressView()
                    } else if current {
                        Text("Current plan")
                    } else if trialLine != nil {
                        Text("Start free trial")
                    } else {
                        Text("Subscribe for \(priceLine)")
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(highlighted ? brandBlue : .gray)
            .disabled(busy || current)
        }
        .padding(16)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(highlighted ? brandBlue : Color.secondary.opacity(0.25), lineWidth: highlighted ? 2 : 1))
    }

    private func duration(_ period: Product.SubscriptionPeriod) -> String {
        var components = DateComponents()
        switch period.unit {
        case .day: components.day = period.value
        case .week: components.weekOfMonth = period.value
        case .month: components.month = period.value
        case .year: components.year = period.value
        @unknown default: components.day = period.value
        }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.maximumUnitCount = 1
        formatter.allowedUnits = [.day, .weekOfMonth, .month, .year]
        return formatter.string(from: components) ?? ""
    }
}

struct FooterLinks: View {
    private var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return "\(short) (\(build))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 14) {
                Link("Rate ContextFlow", destination: Links.review)
                Link("Support", destination: Links.support)
                Link("Privacy Policy", destination: Links.privacy)
                Link("Terms of Use", destination: Links.terms)
            }
            .font(.footnote.weight(.medium))
            Text("Version \(version)")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}
