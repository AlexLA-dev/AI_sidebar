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
    static let privacy = URL(string: "https://context-flow.app/privacy")!
    static let terms = URL(string: "https://context-flow.app/terms")!
    static let support = URL(string: "https://context-flow.app/support")!
    static let review = URL(string: "https://apps.apple.com/app/id6759115793?action=write-review")!
    static let manageSubscriptions = URL(string: "https://apps.apple.com/account/subscriptions")!
    // ContextFlow on X and Threads (the names aren't translated). Opens their app when it's installed.
    static let x = URL(string: "https://x.com/ContextFlowApp")!
    static let threads = URL(string: "https://www.threads.com/@contextflowapp")!
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
    case home, chats, templates, tips, pro, settings
}

// MARK: - Root

struct ContentView: View {
    @StateObject private var store = StoreKitManager.shared
    @StateObject private var router = DeepLinkRouter.shared
    @StateObject private var activation = Activation.shared
    @StateObject private var chats = ChatLibrary.shared
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: AppTab = ChatLibrary.shared.threads.isEmpty ? .home : .chats
    /// iOS: the setup guide, from the Chats screen (there is no Get Started tab once there are chats).
    @State private var showingSetup = false
    /// Settings scrolls down to the plan (the extension's "Manage subscription" with Pro).
    @State private var showPlan = false

    /// Once the user has chats, they come first: Get Started gives way to Chats.
    private var hasChats: Bool { !chats.threads.isEmpty }

    /// With Pro there is no Pro tab: the plan is at the bottom of Settings. A purchase made on the Pro
    /// tab keeps it until the user leaves it, so its "You're all set" isn't cut off.
    private var showsPro: Bool { !store.isPro || tab == .pro }

    /// The extension counted enough good answers since the last time: ask for an App Store rating
    /// (Apple decides whether to show it, at most 3 times a year). Never on a plain first launch. On
    /// launch and whenever the app comes back from Safari. `-CFDebugReview YES`: every time (Debug).
    private func askForReviewIfDue() {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "CFDebugReview") {
            requestReview()
            return
        }
        #endif
        guard let moment = SharedDefaults.shared.pendingReviewMoment() else { return }
        SharedDefaults.shared.markReviewAsked(moment)
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            requestReview()
        }
    }

    /// What's new in 2.5 (organizing): once, to those who already have chats.
    @State private var whatsNew = false

    private func showWhatsNewIfDue() {
        guard hasChats, !UserDefaults.standard.bool(forKey: "cf_whatsnew_organize") else { return }
        UserDefaults.standard.set(true, forKey: "cf_whatsnew_organize")
        whatsNew = true
    }

    var body: some View {
        root
            .tint(brandBlue)
            .sheet(isPresented: $whatsNew) {
                OrganizeWhatsNew(pro: store.isPro, openPro: { whatsNew = false; tab = .pro }, close: { whatsNew = false })
            }
            .onChange(of: hasChats) { _ in showWhatsNewIfDue() }
            .onReceive(router.$pending.compactMap { $0 }) { url in
                switch url.host {
                case "subscribe", "manage":
                    tab = store.isPro ? .settings : .pro
                    showPlan = store.isPro
                case "tips": tab = .tips
                case "chats": tab = hasChats ? .chats : .home
                // A reminder on a message (2.5): Chats opens at it.
                case "chat":
                    tab = .chats
                    ChatLinks.shared.handle(url)
                case "templates": tab = .templates
                default: tab = hasChats ? .chats : .home
                }
                router.pending = nil
            }
            .task {
                SharedDefaults.shared.removeLegacyData()
                chats.refresh()
                showWhatsNewIfDue()
                await store.refreshEntitlement()
                askForReviewIfDue()
                await activation.launched()
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active { askForReviewIfDue() }
            }
            // The first chat arrived (or the last one went): show the right first tab.
            .onChange(of: hasChats) { has in
                if has, tab == .home { tab = .chats }
                if !has, tab == .chats { tab = .home }
            }
    }

    @ViewBuilder
    private var root: some View {
        #if os(iOS)
        // With chats: Settings · Tips · Pro · Chats (Chats where the thumb is). Without: the setup guide first.
        TabView(selection: $tab) {
            if hasChats {
                settingsTab
                tipsTab
                if showsPro { proTab }
                templatesTab
                // A stack: chats open by value, so a chat's screen stays when its row moves (see ChatRoute).
                NavigationStack { ChatsView(library: chats, activation: activation, openSetup: { showingSetup = true }, openPro: { tab = .pro }) }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                    .tag(AppTab.chats)
            } else {
                NavigationView { HomeView(store: store, activation: activation, openPro: { tab = .pro }, openTips: { tab = .tips }) }
                    .navigationViewStyle(.stack)
                    .tabItem { Label("Get Started", systemImage: "sparkles") }
                    .tag(AppTab.home)
                templatesTab
                tipsTab
                if showsPro { proTab }
                settingsTab
            }
        }
        .sheet(isPresented: $showingSetup) {
            NavigationView {
                HomeView(store: store, activation: activation, openPro: { showingSetup = false; tab = .pro }, openTips: { showingSetup = false; tab = .tips })
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSetup = false } }
                    }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            chats.refresh()
            Task {
                await store.refreshEntitlement()
                await activation.launched()
            }
            askForReviewIfDue()
        }
        #else
        NavigationSplitView {
            List(selection: Binding<AppTab?>(get: { tab }, set: { tab = $0 ?? (hasChats ? .chats : .home) })) {
                if hasChats {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right").tag(AppTab.chats)
                } else {
                    Label("Get Started", systemImage: "sparkles").tag(AppTab.home)
                }
                Label("Templates", systemImage: "text.badge.plus").tag(AppTab.templates)
                Label("Tips", systemImage: "lightbulb").tag(AppTab.tips)
                if showsPro { Label("Pro", systemImage: "crown").tag(AppTab.pro) }
                Label("Settings", systemImage: "gearshape").tag(AppTab.settings)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            switch tab {
            case .home: HomeView(store: store, activation: activation, openPro: { tab = .pro }, openTips: { tab = .tips })
            case .chats: NavigationStack { ChatsView(library: chats, activation: activation, openPro: { tab = .pro }) }
            case .templates: NavigationStack { TemplatesView() }
            case .tips: TipsView(openPro: { tab = .pro })
            case .pro: ProView(store: store)
            case .settings: SettingsView(showPlan: $showPlan)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            chats.refresh()
            Task {
                await store.refreshEntitlement()
                await activation.launched()
            }
            askForReviewIfDue()
        }
        #endif
    }

    #if os(iOS)
    private var tipsTab: some View {
        NavigationView { TipsView(openPro: { tab = .pro }) }
            .navigationViewStyle(.stack)
            .tabItem { Label("Tips", systemImage: "lightbulb") }
            .tag(AppTab.tips)
    }

    private var templatesTab: some View {
        NavigationView { TemplatesView() }
            .navigationViewStyle(.stack)
            .tabItem { Label("Templates", systemImage: "text.badge.plus") }
            .tag(AppTab.templates)
    }

    private var proTab: some View {
        NavigationView { ProView(store: store) }
            .navigationViewStyle(.stack)
            .tabItem { Label("Pro", systemImage: "crown") }
            .tag(AppTab.pro)
    }

    private var settingsTab: some View {
        NavigationView { SettingsView(showPlan: $showPlan) }
            .navigationViewStyle(.stack)
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag(AppTab.settings)
    }
    #endif
}

// MARK: - Home

struct HomeView: View {
    @ObservedObject var store: StoreKitManager
    @ObservedObject var activation: Activation
    var openPro: () -> Void
    var openTips: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if store.renewalOff != nil {
                    RenewalQuestionCard()
                        .padding(16)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
                }
                #if os(macOS)
                macStatus
                #else
                SetupCard(activation: activation, openSafari: openSafari)
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
        let enabled = activation.state != .off
        return Card(title: "Safari extension", systemImage: "puzzlepiece.extension") {
            HStack(spacing: 10) {
                Image(systemName: enabled ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundColor(enabled ? .green : .orange)
                    .font(.title3)
                Text(enabled ? LocalizedStringKey("ContextFlow is on in Safari.") : LocalizedStringKey("ContextFlow is turned off in Safari."))
                    .font(.body.weight(.medium))
            }
            if activation.state == .on {
                Text("Open any page and click the ContextFlow icon in the toolbar. If Safari asks, allow it on every website.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            if !enabled {
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
                Text("Pro gives you up to 375 answers a week and reads videos and PDFs on the page, on iPhone, iPad and Mac.")
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
///
/// The extension's Tips sheet shows the same blocks and texts, read from here and from Localizable.xcstrings when
/// the extension is built (scripts/tips-source.mjs): keep `TipGroup` in this shape — `Tip(…)` with string literals,
/// `#if os(iOS)` for what differs on a Mac.
struct TipsView: View {
    /// The Pro tab (organizing tips, without Pro).
    var openPro: () -> Void = {}
    @ObservedObject private var store = StoreKitManager.shared
    @ObservedObject private var organize = OrganizeModel.shared
    // The blocks open, by id (2.5 (78), the owner's note: the big blocks fold). "Get started" until one is opened or
    // closed, then as left.
    @AppStorage("tipsOpenBlocks") private var openBlocks = TipGroup.all[0].id

    var body: some View {
        ScrollView {
            // An open block's title stays at the top while its cards scroll under it, until the next block's takes
            // its place (2.5 (81), the owner's note).
            LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
                Text("Quick answers to “how do I…?”")
                    .font(.callout)
                    .foregroundColor(.secondary)
                // The whole app's, before the blocks (the owner's note).
                TipCard(tip: TipGroup.lead)
                ForEach(TipGroup.all, id: \.id) { group in
                    let open = isOpen(group)
                    Section {
                        if open {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                                ForEach(group.tips.indices, id: \.self) { i in
                                    TipCard(tip: group.tips[i], action: organizeAction(group.tips[i]))
                                }
                            }
                            .padding(.bottom, 8)
                        }
                    } header: {
                        TipBlockHeader(title: group.title, count: group.tips.count, open: open) { toggle(group) }
                            .background(.background)
                    }
                }
                FooterLinks()
                    .padding(.top, 8)
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Tips")
    }

    private func isOpen(_ group: TipGroup) -> Bool {
        openBlocks.split(separator: ",").contains(Substring(group.id))
    }

    private func toggle(_ group: TipGroup) {
        var ids = openBlocks.split(separator: ",").map(String.init)
        if let i = ids.firstIndex(of: group.id) { ids.remove(at: i) } else { ids.append(group.id) }
        withAnimation(.easeInOut(duration: 0.2)) { openBlocks = ids.joined(separator: ",") }
    }

    /// Under the organizing tips: Turn on (Pro, suggestions off; that's the consent) or Try Pro (without Pro).
    private func organizeAction(_ tip: Tip) -> (label: LocalizedStringKey, run: () -> Void)? {
        guard tip.organize else { return nil }
        if !store.isPro {
            return ("Try Pro", {
                ChatAI.reportOrganize("organize_promo", ["action": "tap", "where": "tip"])
                openPro()
            })
        }
        guard !(SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false) else { return nil }
        return ("Turn on", { organize.answerConsent(true, from: "tip") })
    }
}

struct Tip {
    let symbol: String
    let color: Color
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    // A short recording of the extension doing it (TipClips/<en|ru>/<clip>.mp4).
    var clip: String? = nil
    // Organizing (2.5): Turn on or Try Pro under it.
    var organize = false
    // Needs Pro: the Pro badge by the title.
    var pro = false
}

struct TipGroup {
    // Stable, whatever the title says: which blocks are open is kept by it (and the site's sections use the same).
    let id: String
    let title: LocalizedStringKey
    let tips: [Tip]

    // Chats on every device: the whole app's, so it stands before the blocks (2.5 (78), the owner's note).
    static let lead = Tip(symbol: "icloud", color: .cyan, title: "On all your devices",
                          text: "With “Sync chats with iCloud” on, a chat started on your iPhone continues on your iPad and Mac. It's end-to-end encrypted in your iCloud.")

    private static var openTip: Tip {
        #if os(iOS)
        Tip(symbol: "sparkles", color: brandBlue, title: "Open it on any page",
            text: "Tap ✦ on the page, or open the page menu in the address bar and choose ContextFlow.", clip: "open")
        #else
        Tip(symbol: "sparkles", color: brandBlue, title: "Open it on any page",
            text: "Click ✦ on the page or the ContextFlow icon in the toolbar, or press Control-Shift-E.")
        #endif
    }

    // Quick insert (2.5): how the list opens differs, a tap on iPhone and iPad, / or ⌃⇧V with a keyboard. The clips
    // show the button by the field, which a Mac doesn't have.
    private static var insertTip: Tip {
        #if os(iOS)
        Tip(symbol: "text.badge.plus", color: brandBlue, title: "Insert into any field",
            text: "Tap a text field on a page, then the ContextFlow button by it: what you copied in other tabs, your templates and ContextFlow's last answer are one tap away. With a keyboard, type / and a few words of a template, then Tab.", clip: "insert")
        #else
        Tip(symbol: "text.badge.plus", color: brandBlue, title: "Insert into any field",
            text: "In any field on a page, type / and a few words of a template, then Tab. Control-Shift-V opens the whole list: what you copied in other tabs, your templates and ContextFlow's last answer.")
        #endif
    }

    private static var copiedTip: Tip {
        Tip(symbol: "doc.on.clipboard", color: .green, title: "Copied, kept for a day",
            text: "The last 5 things you copied on pages in Safari wait in the list for 24 hours, on this device only. Nothing from password or card fields, or in Private Browsing.", clip: iOSClip("copied"))
    }

    // Swipes are touch only: on a Mac the same actions show on hover and on a right-click.
    private static var swipeTip: Tip {
        #if os(iOS)
        Tip(symbol: "hand.draw", color: .blue, title: "Swipe to pin or delete",
            text: "Swipe an answer or a note to the right to pin it, to the left to delete it. Changed your mind? Undo brings it back.", clip: "swipes")
        #else
        Tip(symbol: "cursorarrow.rays", color: .blue, title: "Pin or delete with a click",
            text: "Point at an answer or a note: Pin, Remind me and Delete show beside it, and a right-click opens the same menu. Changed your mind? Undo brings it back.")
        #endif
    }

    // Reminders and watching are two lists (2.5): the bell is about time, the eye about a change on the page.
    private static var remindTip: Tip {
        Tip(symbol: "bell", color: .orange, title: "Remind me about this page",
            text: "Reading something you want to finish later? Select a line and tap the bell, or tap … at the top of the panel, then Remind me about this page…, and pick a time: the reminder opens this page. Answers and notes have Remind me in their … menu.", clip: "later")
    }

    private static var watchTip: Tip {
        Tip(symbol: "eye", color: .green, title: "Know when a price drops",
            text: "Select a price, a stock status or a date on a page and tap the eye. For the whole page, choose Watch this page… in the … menu at the top of the panel. ContextFlow checks the page while you use Safari and tells you when it changes, or drops below the price you name. Up to 5 at a time, 20 with Pro.", clip: "watch")
    }

    private static func iOSClip(_ name: String) -> String? {
        #if os(iOS)
        name
        #else
        nil
        #endif
    }

    // Blocks by what the person wants to do, simple to advanced within each; Pro cards carry the badge.
    static let all: [TipGroup] = [
        TipGroup(id: "get-started", title: "Get started", tips: [
            openTip,
            Tip(symbol: "list.bullet.rectangle", color: .orange, title: "One tap for the gist",
                text: "Summarize, Key takeaways, Explain simply and Translate work on the whole page — no need to write a prompt.", clip: "gist"),
            Tip(symbol: "text.cursor", color: .purple, title: "Ask about a part",
                text: "Select text on the page and choose Ask AI: the answer is about just that part. It can also explain, translate or rewrite it.", clip: "part"),
            Tip(symbol: "text.quote", color: .orange, title: "Ask or note a selection",
                text: "Select text on a page: type your own question about it right under the selection, or tap Note to save it to the chat with its page. Notes use no answers.", clip: "select"),
            Tip(symbol: "bubble.left.and.bubble.right", color: .teal, title: "A chat follows you",
                text: "Keep asking as you move from page to page. ContextFlow remembers the conversation and which page each question was about. Tap a page's name in the chat to go back to it.", clip: "follows"),
            Tip(symbol: "magnifyingglass", color: .green, title: "Fresh facts from Google",
                text: "Turn on Google next to the question field to answer with Google Search: news, prices and anything recent, with sources.", clip: "google")
        ]),
        TipGroup(id: "deeper-work", title: "Deeper work", tips: [
            Tip(symbol: "pencil.line", color: .orange, title: "Notes of your own",
                text: "Swipe the send button up or down (on a Mac, scroll on it) to write a note instead of asking. It stays in the chat with its page, syncs with it and uses no answers.", clip: "notes"),
            Tip(symbol: "highlighter", color: .yellow, title: "Highlight what matters",
                text: "Select a line in an answer and tap Highlight: it stays marked, like with a pen. Later answers in that chat take your highlights into account, and Copy keeps them in bold.", clip: "highlight"),
            Tip(symbol: "pin", color: .purple, title: "Pinned at the top",
                text: "Pin an answer or a note and it waits in the bar at the top of the chat. Tap the bar to jump to it, tap again for the next one.", clip: "pinned"),
            swipeTip,
            Tip(symbol: "rectangle.stack", color: .blue, title: "The whole chat in mind",
                text: "Turn on Whole chat under the question field when an answer needs everything: all messages, your notes and the other pages of this chat. Off, answers use the last messages and the open page.", clip: "whole"),
            Tip(symbol: "play.rectangle", color: .red, title: "Ask about a video",
                text: "With Pro, ContextFlow reads the transcript of a video on the page: ask for the gist, or what was said about something, and the answer points to the moment, like [4:15]. Free answers use the page's text.", clip: "video", pro: true),
            Tip(symbol: "doc.richtext", color: .orange, title: "PDFs on the page",
                text: "With Pro, PDFs shown on a page or linked from it go with your question, and answers say which page they're on. On iPad and Mac, ContextFlow in the toolbar opens on a PDF tab too. Free answers use the page's text.", clip: "pdf", pro: true)
        ]),
        TipGroup(id: "quick-insert", title: "Quick insert", tips: [
            insertTip,
            copiedTip,
            Tip(symbol: "curlybraces", color: .orange, title: "Templates that fill themselves",
                text: "Select a reply you send often and tap Template: ContextFlow marks the name, the date and whatever else changes. When you insert it, Fill from the page puts them in, highlighted so you can check.", clip: "fill")
        ]),
        TipGroup(id: "watch-and-remind", title: "Watch and remind", tips: [
            remindTip,
            watchTip
        ]),
        TipGroup(id: "chats-in-order", title: "Chats in order", tips: [
            Tip(symbol: "square.and.pencil", color: .indigo, title: "Start fresh or go back",
                text: "Start a new chat with +. Earlier chats wait in the chat list: open one to pick up where you left off, rename it with the pencil, or delete it.", clip: "chats"),
            Tip(symbol: "magnifyingglass", color: .green, title: "Search your chats",
                text: "Type in the search over the chat list: every chat with those words, with the place they're in. A result opens the chat right there.", clip: "search"),
            Tip(symbol: "tag", color: .purple, title: "Tags and folders",
                text: "Tag a chat, an answer or a note with 🏷. Tap a tag to see only its chats, or turn on Folders to group the list by tag.", clip: "tags"),
            Tip(symbol: "square.and.arrow.up", color: .pink, title: "Share what you found",
                text: "Share one answer or the whole chat: the text comes with its links, its sources and a link to ContextFlow.", clip: "share"),
            Tip(symbol: "bubble.left.and.bubble.right", color: .teal, title: "Your chats in the app",
                text: "The Chats tab has every chat from Safari. Ask about its pages or add a note right there, tag, copy or share any answer, or share the whole chat. “Continue in Safari” picks it up where you left off.", clip: "appchat"),
            Tip(symbol: "sparkles", color: brandBlue, title: "AI search",
                text: "Tap ✦ next to the search and describe the chat you remember — “that article about sleep and coffee” — even without the exact words.", clip: "aisearch", pro: true),
            Tip(symbol: "text.bubble", color: .indigo, title: "Ask your chats",
                text: "The first row of the chat list answers from all your chats at once: “What did I read this week?”, “Summarize my notes on AI”.", clip: "history", pro: true),
            Tip(symbol: "arrow.turn.down.right", color: brandBlue, title: "Where it belongs",
                text: "Asked about a car in the chat about a sofa? Under the answer, ContextFlow suggests the chat it belongs in, or a new one. One tap moves it there, by date; Undo puts it back.", clip: "organize", organize: true, pro: true),
            Tip(symbol: "tag", color: .purple, title: "Your tags, suggested",
                text: "ContextFlow learns what your tags mean from where you put them, and suggests the right one under a new answer or note. Only your own tags, only when they fit.", clip: "suggested-tags", organize: true, pro: true)
        ]),
        TipGroup(id: "privacy-and-personalization", title: "Privacy & personalization", tips: [
            Tip(symbol: "person.text.rectangle", color: .mint, title: "Tell it about you",
                text: "Add a line under About me — what you do, how you like answers — and ContextFlow will tailor them to you.", clip: "about"),
            Tip(symbol: "hand.tap", color: .blue, title: "The ✦ button, your way",
                text: "Covering something on the page? Drag ✦ up or down along the edge, or to the other side: it stays where you leave it. You can also hide it on a single site, or turn it off everywhere in the extension settings. ContextFlow still opens from Safari's extensions menu.", clip: "button"),
            Tip(symbol: "key.fill", color: .gray, title: "Use your own API key",
                text: "With Pro or the Own key plan, paste an OpenAI or Claude key in the extension settings in Safari. Requests then go straight to that provider."),
            Tip(symbol: "lock.shield", color: .brown, title: "Private by design",
                text: "ContextFlow reads a page only when you ask, and sends just its text to get the answer. Your chats stay on your devices and in your iCloud. With suggestions on, the text of new messages also goes to our server to find where they belong; we don't keep it.")
        ])
    ]
}

struct TipCard: View {
    let tip: Tip
    var action: (label: LocalizedStringKey, run: () -> Void)? = nil

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
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(tip.title)
                    .font(.headline)
                if tip.pro { ProBadge() }
            }
            Text(tip.text)
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(Color.cardFill)
        .cornerRadius(16)
        .accessibilityElement(children: action == nil ? .combine : .contain)
    }
}

/// A block's title: a tap opens or folds it; folded, it says how many tips are inside.
struct TipBlockHeader: View {
    let title: LocalizedStringKey
    let count: Int
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundColor(.primary)
                if !open {
                    Text(verbatim: String(count))
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.secondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
        .accessibilityAddTraits([.isHeader, .isButton])
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
                if store.isByok { byokCard } else if store.entitlement.active { activeCard }
                organizing
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

    /// An Own key subscriber: what Pro adds over their key, and the upgrade (at the discount once it's due). Pro
    /// starts at once (Pro is the higher level); Apple refunds the unused part of Own key.
    private var byokCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("You're on Own key").font(.headline)
            Text("What Pro adds over your own key:")
                .foregroundColor(.secondary)
            Feature(systemImage: "magnifyingglass", text: "Google answers: \(store.searchProWeekly) a week instead of \(store.searchFreeDaily) a day")
            Feature(systemImage: "bubble.left.and.text.bubble.right", text: "“Ask your chats” and AI search")
            Feature(systemImage: "text.bubble", text: "Questions in the app's chats: up to \(375) a week instead of \(5) a day")
            Feature(systemImage: "key.slash", text: "No API key and no bills from OpenAI or Anthropic")
            if let discount = store.upgradeDiscount, store.byokOfferDue {
                Button { upgradeWithOffer() } label: {
                    Group { if busyProduct == "offer" { ProgressView() } else { Text("Upgrade at \(discount)% off") } }
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            } else if let pro = store.pro {
                Button { buy(pro) } label: {
                    Group { if busyProduct == pro.id { ProgressView() } else { Text("Upgrade to Pro") } }
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            Text("Pro starts now. Apple refunds the unused part of Own key.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
        .task { await store.refreshUpgradeOffer() }
    }

    private func upgradeWithOffer() {
        busyProduct = "offer"
        message = nil
        Task {
            do {
                switch try await store.upgradeWithOffer() {
                case .purchased: success = true
                case .pending: message = String(localized: "Your purchase is waiting for approval.")
                case .cancelled: break
                }
            } catch {
                message = (error as? ChatAI.Failure)?.message ?? error.localizedDescription
            }
            busyProduct = nil
        }
    }

    /// Organizing the chats (2.5), first: what it does, with its loop.
    private var organizing: some View {
        HStack(alignment: .center, spacing: 16) {
            OrganizeAnimation(big: true)
            VStack(alignment: .leading, spacing: 6) {
                Text("Sorts by topic").font(.headline)
                Text("Suggests the right chat for what you just asked, and your own tag for it.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { if !store.isPro { ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "pro_screen"]) } }
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 10) {
            Feature(systemImage: "arrow.turn.down.right", text: "Sorts by topic: suggests the right chat and your own tag")
            Feature(systemImage: "sparkles", text: "AI search: find any chat by describing it in your own words")
            Feature(systemImage: "bubble.left.and.text.bubble.right", text: "Ask your chats: questions across everything you've read and asked")
            Feature(systemImage: "bolt.fill", text: "Up to 375 deeper, more detailed answers a week instead of 5 a day")
            Feature(systemImage: "play.rectangle", text: "Videos and PDFs on the page: answers use the transcript and the documents")
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
            // A row of their own: six links don't fit one line on a 375 pt iPhone.
            HStack(spacing: 14) {
                Link("X", destination: Links.x)
                Link("Threads", destination: Links.threads)
            }
            .font(.footnote.weight(.medium))
            // Counted (social_open: which network only), then opened as usual.
            .environment(\.openURL, OpenURLAction { url in
                Task { await ChatAI.reportSocial(url == Links.x ? "x" : "threads") }
                return .systemAction
            })
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
    @Published var syncChats = true { didSet { save() } }
    /// Quick insert (2.5): the button by text fields (iPhone and iPad) and keeping copied text; both on by default.
    @Published var insertButton = true { didSet { save() } }
    @Published var keepCopied = true { didSet { save() } }
    /// Suggestions (2.5, Pro): a better chat for a block, one of the user's tags. Off until turned on (the consent).
    @Published var organize = false { didSet { save() } }

    /// Turns suggestions on from outside the Settings screen (the card in a chat, What's new): that's the consent.
    static func setOrganize(_ on: Bool) {
        var stored = SharedDefaults.shared.readSettings()?.settings ?? [:]
        stored["organize"] = on
        SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
    }

    /// Switches iCloud sync of chats on or off from outside the Settings screen (the Chats screen).
    static func setSyncChats(_ on: Bool) {
        var stored = SharedDefaults.shared.readSettings()?.settings ?? [:]
        stored["syncChats"] = on
        SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
    }

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
        syncChats = stored["syncChats"] as? Bool ?? true
        insertButton = stored["insertButton"] as? Bool ?? true
        keepCopied = stored["keepCopied"] as? Bool ?? true
        organize = stored["organize"] as? Bool ?? false
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
        let syncChanged = (stored["syncChats"] as? Bool ?? true) != syncChats
        stored["syncChats"] = syncChats
        stored["insertButton"] = insertButton
        stored["keepCopied"] = keepCopied
        stored["organize"] = organize
        SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
        if syncChanged { ChatLibrary.shared.refresh() }
    }
}

struct SettingsView: View {
    @StateObject private var settings = ExtensionSettings()
    @ObservedObject private var store = StoreKitManager.shared
    @Environment(\.openURL) private var openURL
    @State private var restoring = false
    @State private var restoreMessage: String?
    /// Set to scroll down to the plan; cleared once it has.
    @Binding var showPlan: Bool

    var body: some View {
        ScrollViewReader { proxy in
            form
                .onAppear { scrollToPlan(proxy) }
                .onChange(of: showPlan) { _ in scrollToPlan(proxy) }
        }
    }

    private func scrollToPlan(_ proxy: ScrollViewProxy) {
        guard showPlan else { return }
        showPlan = false
        guard store.isPro else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            withAnimation { proxy.scrollTo("plan", anchor: .top) }
        }
    }

    private var form: some View {
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

            Section(
                header: Text("On web pages"),
                footer: Text("The last 5 pieces of text copied on pages. They stay on this device and are erased after 24 hours. Nothing from password or card fields, or in Private Browsing.")
            ) {
                Toggle("Floating ✦ button", isOn: $settings.floatingButton)
                Toggle("Button when selecting text", isOn: $settings.selectionButton)
                if !settings.hiddenSites.isEmpty {
                    Button("Show the ✦ button on all sites again (\(settings.hiddenSites.count) hidden)") {
                        settings.hiddenSites = []
                    }
                }
                // Quick insert's settings (2.5 rules): the button shows by fields on touch screens only, as in the panel.
                #if os(iOS)
                Toggle("Button by text fields", isOn: $settings.insertButton)
                #endif
                Toggle("Keep copied text", isOn: $settings.keepCopied)
            }

            Section(
                header: Text("Chats"),
                footer: Text("Your chats continue on your iPhone, iPad and Mac signed in to the same Apple Account. They're end-to-end encrypted in iCloud: only your devices can read them.")
            ) {
                Toggle("Sync chats with iCloud", isOn: $settings.syncChats)
            }

            Section(
                header: Text("Suggestions"),
                footer: Text(store.isPro
                    ? "A fitting chat and your tag under new answers and notes. The text of your messages goes to our server and to OpenAI and Anthropic. We don't keep it; they don't use it for training."
                    : "Pro: ContextFlow suggests a fitting chat and your tag under new answers and notes.")
            ) {
                Toggle("Suggestions: tags and moving", isOn: $settings.organize)
                    .disabled(!store.isPro)
                    .onChange(of: settings.organize) { on in
                        if on { ChatAI.reportOrganize("organize_optin", ["action": "accepted", "from": "settings"]) }
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

            // With Pro there is no Pro tab: the plan and its subscription are managed here.
            if store.isPro { planSection.id("plan") }
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

    private var planSection: some View {
        Section(header: Text("Your plan"), footer: restoreMessage.map { Text($0) }) {
            HStack {
                Text(planName(store.entitlement.productId))
                Spacer()
                if let date = store.entitlement.expiresAt {
                    if store.entitlement.autoRenew == false {
                        Text("Ends \(date, style: .date)")
                            .foregroundColor(.secondary)
                    } else {
                        Text("Renews \(date, style: .date)")
                            .foregroundColor(.secondary)
                    }
                }
            }
            Button("Manage Subscription") { openURL(Links.manageSubscriptions) }
            Button {
                restoring = true
                restoreMessage = nil
                Task {
                    let restored = await store.restore()
                    restoring = false
                    restoreMessage = restored ? String(localized: "Your subscription has been restored.") : String(localized: "No active subscription was found for this Apple Account.")
                }
            } label: {
                if restoring { ProgressView() } else { Text("Restore Purchases") }
            }
            .disabled(restoring)
        }
    }
}
