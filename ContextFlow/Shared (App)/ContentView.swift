import AVFoundation
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

// MARK: - Deep links (contextflow://subscribe, contextflow://manage, contextflow://tips, contextflow://open)

final class DeepLinkRouter: ObservableObject {
    static let shared = DeepLinkRouter()
    @Published var pending: URL?

    func handle(_ url: URL) {
        guard url.scheme == "contextflow" else { return }
        pending = url
    }
}

enum AppTab: Hashable {
    case home, tips, pro, settings
}

// MARK: - Root

struct ContentView: View {
    @StateObject private var store = StoreKitManager.shared
    @StateObject private var router = DeepLinkRouter.shared
    @Environment(\.requestReview) private var requestReview
    @State private var tab: AppTab = .home

    /// The extension counted enough good answers since the last time: ask for an App Store rating
    /// (Apple decides whether to show it, at most 3 times a year). Never on a plain first launch.
    private func askForReviewIfDue() {
        guard let moment = SharedDefaults.shared.pendingReviewMoment() else { return }
        SharedDefaults.shared.markReviewAsked(moment)
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            requestReview()
        }
    }

    var body: some View {
        root
            .tint(brandBlue)
            .onReceive(router.$pending.compactMap { $0 }) { url in
                switch url.host {
                case "subscribe", "manage": tab = .pro
                case "tips": tab = .tips
                default: tab = .home
                }
                router.pending = nil
            }
            .task {
                SharedDefaults.shared.removeLegacyData()
                await store.refreshEntitlement()
                askForReviewIfDue()
            }
    }

    @ViewBuilder
    private var root: some View {
        #if os(iOS)
        TabView(selection: $tab) {
            NavigationView { HomeView(store: store, openPro: { tab = .pro }, openTips: { tab = .tips }) }
                .navigationViewStyle(.stack)
                .tabItem { Label("Get Started", systemImage: "sparkles") }
                .tag(AppTab.home)
            NavigationView { TipsView() }
                .navigationViewStyle(.stack)
                .tabItem { Label("Tips", systemImage: "lightbulb") }
                .tag(AppTab.tips)
            NavigationView { ProView(store: store) }
                .navigationViewStyle(.stack)
                .tabItem { Label("Pro", systemImage: "crown") }
                .tag(AppTab.pro)
            NavigationView { SettingsView() }
                .navigationViewStyle(.stack)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await store.refreshEntitlement() }
            askForReviewIfDue()
        }
        #else
        NavigationSplitView {
            List(selection: Binding<AppTab?>(get: { tab }, set: { tab = $0 ?? .home })) {
                Label("Get Started", systemImage: "sparkles").tag(AppTab.home)
                Label("Tips", systemImage: "lightbulb").tag(AppTab.tips)
                Label("Pro", systemImage: "crown").tag(AppTab.pro)
                Label("Settings", systemImage: "gearshape").tag(AppTab.settings)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            switch tab {
            case .home: HomeView(store: store, openPro: { tab = .pro }, openTips: { tab = .tips })
            case .tips: TipsView()
            case .pro: ProView(store: store)
            case .settings: SettingsView()
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await store.refreshEntitlement() }
            askForReviewIfDue()
        }
        #endif
    }
}

// MARK: - Home

struct HomeView: View {
    @ObservedObject var store: StoreKitManager
    var openPro: () -> Void
    var openTips: () -> Void
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
            Button(action: openTips) {
                Label("More tips", systemImage: "lightbulb")
            }
            .buttonStyle(.bordered)
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

// MARK: - Tips

/// What ContextFlow can do, to look up any time — in the spirit of the Tips app.
struct TipsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Quick answers to “how do I…?”")
                    .font(.callout)
                    .foregroundColor(.secondary)
                ForEach(TipGroup.all.indices, id: \.self) { index in
                    let group = TipGroup.all[index]
                    VStack(alignment: .leading, spacing: 12) {
                        Text(group.title)
                            .font(.title3.weight(.semibold))
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                            ForEach(group.tips.indices, id: \.self) { TipCard(tip: group.tips[$0]) }
                        }
                    }
                }
                FooterLinks()
                    .padding(.top, 4)
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Tips")
    }
}

struct Tip {
    let symbol: String
    let color: Color
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    // A short recording of the extension doing it (TipClips/<en|ru>/<clip>.mp4).
    var clip: String? = nil
}

struct TipGroup {
    let title: LocalizedStringKey
    let tips: [Tip]

    private static var openTip: Tip {
        #if os(iOS)
        Tip(symbol: "sparkles", color: brandBlue, title: "Open it on any page",
            text: "Tap ✦ on the page, or open the page menu in the address bar and choose ContextFlow.", clip: "open")
        #else
        Tip(symbol: "sparkles", color: brandBlue, title: "Open it on any page",
            text: "Click ✦ on the page or the ContextFlow icon in the toolbar, or press Control-Shift-E.")
        #endif
    }

    static let all: [TipGroup] = [
        TipGroup(title: "Get answers", tips: [
            openTip,
            Tip(symbol: "list.bullet.rectangle", color: .orange, title: "One tap for the gist",
                text: "Summarize, Key takeaways, Explain simply and Translate work on the whole page — no need to write a prompt.", clip: "gist"),
            Tip(symbol: "text.cursor", color: .purple, title: "Ask about a part",
                text: "Select text on the page and choose Ask AI: the answer is about just that part. It can also explain, translate or rewrite it.", clip: "part"),
            Tip(symbol: "magnifyingglass", color: .green, title: "Fresh facts from Google",
                text: "Turn on Google next to the question field to answer with Google Search: news, prices and anything recent, with sources.", clip: "google")
        ]),
        TipGroup(title: "Chats", tips: [
            Tip(symbol: "bubble.left.and.bubble.right", color: .teal, title: "A chat follows you",
                text: "Keep asking as you move from page to page. ContextFlow remembers the conversation and which page each question was about. Tap a page's name in the chat to go back to it.", clip: "follows"),
            Tip(symbol: "pencil.line", color: .orange, title: "Notes of your own",
                text: "Swipe the send button up or down (on a Mac, scroll on it) to write a note instead of asking. It stays in the chat with its page, syncs with it and uses no answers.", clip: "notes"),
            Tip(symbol: "rectangle.stack", color: .blue, title: "The whole chat in mind",
                text: "Turn on Whole chat under the question field when an answer needs everything: all messages, your notes and the other pages of this chat. Off, answers use the last messages and the open page.", clip: "whole"),
            Tip(symbol: "square.and.pencil", color: .indigo, title: "Start fresh or go back",
                text: "Start a new chat with +. Earlier chats wait in the chat list: open one to pick up where you left off, rename it with the pencil, or delete it.", clip: "chats"),
            Tip(symbol: "icloud", color: .cyan, title: "On all your devices",
                text: "With “Sync chats with iCloud” on, a chat started on your iPhone continues on your iPad and Mac. It's end-to-end encrypted in your iCloud."),
            Tip(symbol: "square.and.arrow.up", color: .pink, title: "Share what you found",
                text: "Share one answer or the whole chat: the text comes with its links, its sources and a link to ContextFlow.")
        ]),
        TipGroup(title: "Settings & privacy", tips: [
            Tip(symbol: "person.text.rectangle", color: .mint, title: "Tell it about you",
                text: "Add a line under About me — what you do, how you like answers — and ContextFlow will tailor them to you.", clip: "about"),
            Tip(symbol: "key.fill", color: .gray, title: "Use your own API key",
                text: "With Pro or the Own key plan, paste an OpenAI or Claude key in the extension settings in Safari. Requests then go straight to that provider."),
            Tip(symbol: "hand.tap", color: .blue, title: "The ✦ button, your way",
                text: "Hide the button on a single site, or turn it off everywhere in the extension settings. ContextFlow still opens from Safari's extensions menu."),
            Tip(symbol: "lock.shield", color: .brown, title: "Private by design",
                text: "ContextFlow reads a page only when you ask, and sends just its text to get the answer. Your chats stay on your devices and in your iCloud.")
        ])
    ]
}

struct TipCard: View {
    let tip: Tip

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let name = tip.clip, let url = TipClip.url(name) {
                TipClipView(url: url)
                    .aspectRatio(TipClip.aspect, contentMode: .fit)
                    .frame(maxWidth: TipClip.width)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08)))
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)
            }
            Image(systemName: tip.symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(tip.color))
                .accessibilityHidden(true)
            Text(tip.title)
                .font(.headline)
            Text(tip.text)
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(Color.cardFill)
        .cornerRadius(16)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Tip clips

enum TipClip {
    static let aspect: CGFloat = 540.0 / 794.0
    static let width: CGFloat = 270 // at most; about 400 pt tall

    /// The clip recorded in the app's language: Russian, or English for every other language.
    static func url(_ name: String) -> URL? {
        let lang = Bundle.main.preferredLocalizations.first?.hasPrefix("ru") == true ? "ru" : "en"
        return Bundle.main.url(forResource: name, withExtension: "mp4", subdirectory: "TipClips/\(lang)")
    }
}

/// A muted clip that loops while it's on screen; with Reduce Motion it shows one still frame.
struct TipClipView: View {
    let url: URL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var looping = LoopingPlayer()

    var body: some View {
        PlayerLayerView(player: looping.player)
            .background(Color.white)
            .onAppear { looping.start(url, still: reduceMotion) }
            .onDisappear { looping.player.pause() }
    }
}

final class LoopingPlayer: ObservableObject {
    let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?

    init() {
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
    }

    func start(_ url: URL, still: Bool) {
        if looper == nil { looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url)) }
        if still {
            // Past the fade-in, where the feature is already on screen.
            player.pause()
            player.seek(to: CMTime(seconds: 3.5, preferredTimescale: 600))
        } else {
            player.play()
        }
    }
}

#if os(iOS)
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ view: PlayerUIView, context: Context) {}

    final class PlayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
#else
struct PlayerLayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspect
        view.layer = layer // layer-hosting: the player layer follows the view's size
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
}
#endif

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
            Feature(systemImage: "key.fill", text: "Optional: use your own OpenAI or Claude key")
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
                        subtitle: "Unlimited answers with your own OpenAI or Claude API key.",
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
            Text("Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period. Payment is charged to your Apple Account. You can manage or cancel your subscription in your App Store account settings.")
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
        .background(Color.cardFill)
        .cornerRadius(16)
    }
}

extension Color {
    static var cardFill: Color {
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

// MARK: - Settings (shared with the Safari extension)

/// The extension's settings, kept in the App Group. Edited here or in the extension;
/// the extension picks up changes from the app the next time its panel opens, and the other way round.
@MainActor
final class ExtensionSettings: ObservableObject {
    @Published var theme = "auto" { didSet { save() } }
    @Published var textSize = "normal" { didSet { save() } }
    @Published var floatingButton = true { didSet { save() } }
    @Published var selectionButton = true { didSet { save() } }
    @Published var aboutMe = "" { didSet { save() } }
    @Published var ownKeyModel = "smart" { didSet { save() } }
    @Published var hiddenSites: [String] = [] { didSet { save() } }

    private var stored: [String: Any] = [:]
    private var loading = false

    init() { reload() }

    /// Reads the shared copy (it may have changed in Safari since).
    func reload() {
        loading = true
        defer { loading = false }
        stored = SharedDefaults.shared.readSettings()?.settings ?? [:]
        theme = stored["theme"] as? String ?? "auto"
        textSize = stored["textSize"] as? String ?? "normal"
        floatingButton = (stored["fab"] as? String ?? "on") != "off"
        selectionButton = stored["selectionButton"] as? Bool ?? true
        aboutMe = stored["aboutMe"] as? String ?? ""
        ownKeyModel = stored["ownKeyModel"] as? String ?? "smart"
        hiddenSites = stored["fabHiddenSites"] as? [String] ?? []
    }

    private func save() {
        guard !loading else { return }
        stored["theme"] = theme
        stored["textSize"] = textSize
        stored["fab"] = floatingButton ? "on" : "off"
        stored["selectionButton"] = selectionButton
        stored["aboutMe"] = String(aboutMe.prefix(1000))
        stored["ownKeyModel"] = ownKeyModel
        stored["fabHiddenSites"] = hiddenSites
        SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
    }
}

struct SettingsView: View {
    @StateObject private var settings = ExtensionSettings()

    var body: some View {
        Form {
            Section(header: Text("Appearance")) {
                Picker("Appearance", selection: $settings.theme) {
                    Text("Auto").tag("auto")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                Picker("Text size", selection: $settings.textSize) {
                    Text("Normal").tag("normal")
                    Text("Large").tag("large")
                }
            }

            Section(header: Text("On web pages")) {
                Toggle("Floating ✦ button", isOn: $settings.floatingButton)
                Toggle("Button when selecting text", isOn: $settings.selectionButton)
                if !settings.hiddenSites.isEmpty {
                    Button("Show the ✦ button on all sites again (\(settings.hiddenSites.count) hidden)") {
                        settings.hiddenSites = []
                    }
                }
            }

            Section(
                header: Text("About me"),
                footer: Text("Optional. Helps tailor answers, e.g. “I'm a product designer, keep it short”.")
            ) {
                TextEditor(text: $settings.aboutMe)
                    .frame(minHeight: 90)
            }

            Section(
                header: Text("Own API key"),
                footer: Text("Applies when you use your own OpenAI or Claude key. The key itself is entered in the extension settings in Safari.")
            ) {
                Picker("Model", selection: $settings.ownKeyModel) {
                    Text("Fast").tag("fast")
                    Text("Smart").tag("smart")
                }
            }

            Section(footer: Text("These settings are shared with ContextFlow in Safari. A change here shows up there the next time you open ContextFlow, and the other way round.")) {
                EmptyView()
            }
        }
        .navigationTitle("Settings")
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in settings.reload() }
        #else
        .formStyle(.grouped)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in settings.reload() }
        #endif
        .onAppear { settings.reload() }
    }
}
