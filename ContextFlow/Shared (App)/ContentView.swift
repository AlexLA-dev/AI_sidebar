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
    /// The App Store's "Write a Review" (on a Mac, in the Mac App Store; a web page would open in the browser).
    #if os(iOS)
    static let review = URL(string: "https://apps.apple.com/app/id6759115793?action=write-review")!
    #else
    static let review = URL(string: "macappstore://apps.apple.com/app/id6759115793?action=write-review")!
    #endif
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
        // Opened to do something (buy, listen, the notifications question): no rating asked over it (2.6 (100)).
        if ["subscribe", "manage", "listen", "notifications", "add"].contains(url.host ?? "") { ReviewAsk.shared.taskLink() }
        pending = url
    }
}

enum AppTab: Hashable {
    // whatsNew (2.6 (98)): hidden until it opens by itself after an update or from the "is here" notification.
    case home, chats, templates, tips, pro, settings, whatsNew
    /// 2.7: Подборки, the Mac's sidebar (on iPhone and iPad they open from the Chats screen).
    case collections

    /// The name `tab.open` counts it by (src/shared/usage.ts).
    var event: String {
        switch self {
        case .home: return "start"
        case .chats: return "chats"
        case .templates: return "templates"
        case .tips: return "tips"
        case .pro: return "pro"
        case .settings: return "settings"
        case .whatsNew: return "whats_new"
        case .collections: return "collections"
        }
    }
}

/// The install's first day (2.8, В3.3): no promo sheets then. From the app's first launch on this device (an update
/// that had the app before counts as past it).
enum QuietDay {
    static var firstDay: Bool {
        guard !SharedDefaults.shared.appUpdatedInstall(), let first = SharedDefaults.shared.appFirstLaunch() else { return false }
        return Date().timeIntervalSince1970 - first < 86_400
    }
}

// MARK: - Root

struct ContentView: View {
    @StateObject private var store = StoreKitManager.shared
    @StateObject private var router = DeepLinkRouter.shared
    @StateObject private var activation = Activation.shared
    @StateObject private var chats = ChatLibrary.shared
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: AppTab = NewUserPreview.isOn || (ChatLibrary.shared.threads.isEmpty && ChatLibrary.shared.trashed.isEmpty) ? .home : .chats
    /// «Start as a new user» (2.7, TestFlight and debug builds; Setup.swift): while it's on, the chats are left out of
    /// what's shown here (nothing in ChatLibrary, iCloud or the App Group changes).
    @StateObject private var preview = NewUserPreview.shared
    /// iOS: the setup guide, from the Chats screen (there is no Get Started tab once there are chats).
    @State private var showingSetup = false
    /// Settings scrolls down to the plan (the extension's "Manage subscription" with Pro).
    @State private var showPlan = false

    /// Once the user has chats, they come first: Get Started gives way to Chats.
    /// Chats in Recently Deleted count: the Chats screen is the way to them (2.5 (83)).
    private var hasChats: Bool { !preview.on && (!chats.threads.isEmpty || !chats.trashed.isEmpty) }

    /// With Ultra there is no Pro tab: the plan is at the bottom of Settings (2.6: Pro subscribers keep it, as
    /// "Ultra"). A purchase made on the tab keeps it until the user leaves it, so its "You're all set" isn't cut off.
    private var showsPro: Bool { !store.isUltra || tab == .pro }
    /// The tab's name: Ultra for Pro subscribers (what's left to get), else Pro.
    private var proTabName: LocalizedStringKey { store.isPro && !store.isUltra ? "Ultra" : "Pro" }
    /// Read aloud handed over by the Safari panel (contextflow://listen?id=…).
    /// The player itself isn't observed here (build 92): its clock changes four times a second while it plays, and the
    /// whole app behind the sheet was laid out again each time (the chat jumped behind the player on iPad, and it cost
    /// energy). Only whether its sheet is up is.
    private let listen = ListenPlayer.shared
    @StateObject private var listenShown = ListenShown()
    /// Calendar and Reminders handed over by the Safari panel (2.7, contextflow://add?id=…).
    @StateObject private var appleAdd = AppleAdd.shared
    @StateObject private var appleAccess = AppleAccessModel.shared

    /// What's new in 2.5 (organizing): once, to those who already have chats.
    @State private var whatsNew = false
    /// The "What's new" tab (2.6 (98), WhatsNew.swift): shown when it opens, in Tips' place on iPhone and iPad, until
    /// another tab is chosen.
    @State private var whatsNewShown = false

    private func openWhatsNew() {
        whatsNewShown = true
        tab = .whatsNew
    }

    /// After an update, the tab opens once by itself; the 2.5 sheet then never shows (its feature has a card in Tips).
    private func openWhatsNewAfterUpdate() {
        // Not for a new user («Start as a new user», test builds): it waits for a launch with the person's own data.
        guard !preview.on else { return }
        // 2.8 (В3.3): only an install that updated from an older version is an existing user; chats alone aren't (a new
        // install has them minutes after its first answers, or back from iCloud).
        let existing = SharedDefaults.shared.appUpdatedInstall() || UserDefaults.standard.object(forKey: "cf_whatsnew_organize") != nil
        guard WhatsNew.dueAfterUpdate(existingUser: existing) else { return }
        UserDefaults.standard.set(true, forKey: "cf_whatsnew_organize")
        openWhatsNew()
    }

    private func showWhatsNewIfDue() {
        #if DEBUG
        // Screenshots of the sheet without chats: -CFDebugWhatsNew YES.
        if UserDefaults.standard.bool(forKey: "CFDebugWhatsNew") {
            whatsNew = true
            return
        }
        #endif
        // 2.8 (the director's acceptance, shot 15): never over the App Store's sheet; it waits for another time.
        guard hasChats, !store.purchasing, !Paywall.shared.purchasing, Paywall.shared.buyNow == nil, !UserDefaults.standard.bool(forKey: "cf_whatsnew_organize") else { return }
        // 2.8 (В3.3, the quiet first day): this is 2.5's What's new. A new install never gets a What's new for a version it
        // didn't update from (it came on a fresh install's first day, minutes after its first answers), and no promo
        // sheet comes in an install's first day.
        guard SharedDefaults.shared.appUpdatedInstall(), !QuietDay.firstDay else { return }
        UserDefaults.standard.set(true, forKey: "cf_whatsnew_organize")
        whatsNew = true
    }

    /// A purchase started while What's new was up (the app opened by the panel's «Choose»): it goes, and comes another
    /// time.
    private func purchaseStarted(_ purchasing: Bool) {
        guard purchasing, whatsNew else { return }
        whatsNew = false
        UserDefaults.standard.set(false, forKey: "cf_whatsnew_organize")
    }

    /// What a plan adds, after a purchase or an upgrade (2.6, build 89).
    @StateObject private var tour = PlanTour.shared
    /// 2.7, invite a friend: the screen from Settings or from an invite link (contextflow://invite?code=…).
    @StateObject private var invite = InviteModel.shared
    #if os(iOS)
    /// Notifications, asked with a reason (2.6): after the other sheets and the plan tour.
    @StateObject private var notify = NotifyAsk.shared
    #endif

    /// The plan tour waits while another sheet is up (Listen handed over from Safari, What's new, the setup guide),
    /// then comes back at the step it was on.
    private var otherSheet: Bool {
        #if os(iOS)
        if notify.ask != nil { return true }
        #endif
        return listenShown.visible || whatsNew || showingSetup || appleAdd.request != nil
    }

    #if os(iOS)
    private var notifyAsk: Binding<NotifyAsk.Ask?> {
        Binding(get: { listenShown.visible || whatsNew || showingSetup || tour.run != nil ? nil : notify.ask },
                set: { if $0 == nil, notify.ask != nil { notify.notNow() } })
    }
    #endif

    private var tourRun: Binding<PlanTour.Run?> {
        Binding(get: { otherSheet ? nil : tour.run }, set: { if $0 == nil, !otherSheet { closeTour() } })
    }

    /// 2.8 (В1.7): which tabs are opened (Tips, What's new and Pro above all), and What's new left. Before the tab's own
    /// handling, while `whatsNewShown` still says whether What's new was showing.
    private func reportTab(_ next: AppTab) {
        ChatAI.reportUse("tab", "open", ["what": next.event])
        if next == .tips { ChatAI.reportUse("tips", "open") }
        if next == .whatsNew { ChatAI.reportUse("whatsnew", "shown") }
        if next != .whatsNew, whatsNewShown { ChatAI.reportUse("whatsnew", "close") }
    }

    private func closeTour() {
        guard tour.close() else { return }
        // It stood in for "You're all set" after a purchase: the rating is asked as that alert did.
        ReviewAsk.shared.ask(.tour, after: 1)
    }

    /// Apple's rating request, a moment after a good one (ReviewAsk), unless something is being done on screen: the
    /// plan's tour, the notifications question, the setup guide, the 2.5 What's new sheet, Listen's player (unless a
    /// text was just heard to its end in it). Safari's moment then waits for the next time the app comes to the front.
    private func askForReview(_ request: ReviewAsk.Request) {
        var busy = tour.run != nil || showingSetup || whatsNew || Paywall.shared.purchasing || (listenShown.visible && request.via != .listen)
        #if os(iOS)
        if notify.ask != nil { busy = true }
        #endif
        if ReviewAsk.shared.take(request, busy: busy) { requestReview() }
    }

    var body: some View {
        root
            .tint(brandBlue)
            .sheet(isPresented: Binding(get: { listenShown.visible }, set: { if !$0 { listen.dismiss() } })) {
                ListenView(player: listen, openPlans: {
                    listen.dismiss()
                    Paywall.shared.focus = .ultra
                    tab = .pro
                })
            }
            .sheet(item: $appleAdd.request, onDismiss: { appleAdd.close() }) { _ in
                AppleAddView(model: appleAdd)
            }
            .sheet(isPresented: $invite.shown) {
                InviteView()
            }
            .sheet(isPresented: $whatsNew) {
                OrganizeWhatsNew(pro: store.isPro, openPro: { whatsNew = false; tab = .pro }, close: { whatsNew = false })
            }
            .sheet(item: tourRun) { run in
                PlanTourView(tour: tour, run: run, hasChats: hasChats, open: { place in
                    closeTour()
                    tab = place
                }, close: closeTour)
            }
            #if os(iOS)
            .sheet(item: notifyAsk) { ask in
                NotifyAskView(model: notify, ask: ask)
            }
            #endif
            .onChange(of: hasChats) { _ in showWhatsNewIfDue() }
            .onReceive(Paywall.shared.$purchasing) { purchaseStarted($0) }
            .onReceive(router.$pending.compactMap { $0 }) { url in
                switch url.host {
                // 2.6: the panel's plans sheet names the plan and period; the plans screen opens on it. Build 94: also for
                // a subscriber choosing another period or a lower plan (they went to Settings, with nothing to buy);
                // only the plan they already have goes to Settings.
                // 2.8 (В7.2): from the panel with the page to go back to: the App Store's sheet at once, over whatever is on
                // screen, and back to Safari after it (the Pro tab only when the purchase can't go through here).
                case "subscribe" where Paywall.wantsPlan(url, current: store.entitlement.active ? store.entitlement.productId : nil) && QuickBuy.wants(url):
                    // At once, before anything else on launch can present a sheet over the App Store's.
                    Paywall.shared.purchasing = true
                    QuickBuy.run(url, store: store) { tab = .pro }
                case "subscribe" where Paywall.wantsPlan(url, current: store.entitlement.active ? store.entitlement.productId : nil):
                    Paywall.shared.open(url)
                    tab = .pro
                case "subscribe", "manage":
                    tab = store.isPro ? .settings : .pro
                    showPlan = store.isPro
                case "listen":
                    listen.open(url)
                // 2.7: a reminder or an event the panel couldn't add itself (access is asked here).
                case "add":
                    appleAdd.open(url)
                // 2.7.1: the agent needs Calendar or Reminders: the system's question, asked here (the extension can't).
                // Turned down before (or «settings=1» from the panel): the system's Settings, where it's turned on.
                case "access":
                    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                    let item: AppleItems.Item.Kind = query.first { $0.name == "kind" }?.value == "calendar" ? .event : .reminder
                    if query.contains(where: { $0.name == "settings" }) || AppleAccessModel.state(item) == "denied" {
                        AppleAdd.openSettings(item)
                    } else {
                        Task { _ = await AppleItems.ask(item); appleAccess.refresh() }
                    }
                // 2.7: a friend's invite link opened where the app is installed: the code goes into the field.
                case "invite":
                    let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "code" }?.value ?? ""
                    invite.draft = InviteModel.parseCode(code) ?? ""
                    // 2.8 (В3.4): the code is entered on Invite a friend (the first screen no longer has a card for it).
                    invite.shown = true
                #if os(iOS)
                // Listen in Safari without notifications (2.6): asked here (the extension can't), then the text plays.
                case "notifications":
                    let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "listen" }?.value?.lowercased()
                    if let id {
                        // 2.7: the link's own text is kept, so it's here whether or not the extension's copy has come.
                        ListenLink.keep(url)
                        Task { await NotifyAsk.shared.show(.listen, listen: id) }
                    } else {
                        // 2.8 (В3.2): a moment of value in the panel (`why`), the one way the panel asks.
                        Task { await NotifyAsk.shared.show(link: url) }
                    }
                #endif
                case "tips": tab = .tips
                // 2.8: a reminder to finish setup was tapped: the guide (in a sheet when there are chats).
                case "setup":
                    if hasChats { showingSetup = true } else { tab = .home }
                #if DEBUG
                // 2.6 (100): suggestions coming from "another device" while a chat is read (ChatLibrary.debugOrg).
                case "debug-org": chats.debugOrg(url)
                #endif
                // 2.6 (98): the "is here" notification, or a link to it.
                case "whatsnew": openWhatsNew()
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
                listen.debugStartIfAsked()
                appleAdd.debugStartIfAsked()
                // Read aloud kept in iCloud (2.6): what's older than 7 days goes (at most once a day, from any device).
                // And the parts the panel made that are still waiting to go up (build 92: the extension no longer waits on it).
                Task.detached(priority: .background) {
                    await SpeechSync.sweep()
                    await SpeechSync.uploadPending()
                    // What was heard and not counted yet (the app closed offline): to the server now.
                    await ListenPlayer.sendHeard()
                }
                chats.refresh()
                openWhatsNewAfterUpdate()
                showWhatsNewIfDue()
                // The App Store's version (2.6 (98)): at most every 12 hours; on iPhone and iPad also in the background.
                Task.detached(priority: .background) { await WhatsNew.check() }
                #if os(iOS)
                WhatsNew.schedule()
                #endif
                tour.debugStartIfAsked()
                // 2.8 (В1.6): the storefront every app event carries, read before the first ones where it can be.
                await AppSource.refresh()
                await store.refreshEntitlement()
                ReviewAsk.shared.cameToFront()
                await activation.launched()
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active {
                    ReviewAsk.shared.cameToFront()
                    Task.detached(priority: .background) { await WhatsNew.check() }
                    // What the panel heard to its end meanwhile (build 94): Listen's "already voiced" mark.
                    VoicedList.shared.reload()
                    // Back from Settings or Safari: whether ContextFlow is on now (2.6), and the guide over Settings goes.
                    // 2.7: "back" first, so the server has it before "enabled".
                    activation.cameBack()
                    Task { await activation.refresh() }
                    #if os(iOS)
                    SettingsPiP.shared.stop()
                    #endif
                }
            }
            // What's new hides again once another tab is chosen (Tips is back in its place). Left after an update: a good
            // moment for a rating (2.6 (100)).
            .onChange(of: tab) { next in
                reportTab(next)
                if next != .whatsNew {
                    if whatsNewShown { ReviewAsk.shared.ask(.whatsNew) }
                    whatsNewShown = false
                }
            }
            .onReceive(ReviewAsk.shared.requests) { askForReview($0) }
            // The first chat arrived (or the last one went): show the right first tab.
            .onChange(of: hasChats) { has in
                if has, tab == .home { tab = .chats }
                if !has, tab == .chats { tab = .home }
            }
            // «Start as a new user» started or ended (test builds): the first screen of whichever it is now.
            .onChange(of: preview.on) { on in
                tab = on || (chats.threads.isEmpty && chats.trashed.isEmpty) ? .home : .chats
            }
    }

    @ViewBuilder
    private var root: some View {
        #if os(iOS)
        // With chats: Settings · Tips · Pro · Chats (Chats where the thumb is). Without: the setup guide first.
        TabView(selection: $tab) {
            if hasChats {
                settingsTab
                // What's new stands in Tips' place while it shows: an iPhone shows five tabs, a sixth would put Chats
                // under More.
                if whatsNewShown { whatsNewTab } else { tipsTab }
                if showsPro { proTab }
                templatesTab
                // A stack: chats open by value, so a chat's screen stays when its row moves (see ChatRoute).
                NavigationStack { ChatsView(library: chats, activation: activation, openSetup: { showingSetup = true }, openPro: { tab = .pro }, openTab: { tab = $0 }) }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                    .tag(AppTab.chats)
            } else {
                NavigationView { HomeView(store: store, activation: activation, openPro: { tab = .pro }, openTips: { tab = .tips }) }
                    .navigationViewStyle(.stack)
                    .tabItem { Label("Get Started", systemImage: "sparkles") }
                    .tag(AppTab.home)
                templatesTab
                if whatsNewShown { whatsNewTab } else { tipsTab }
                if showsPro { proTab }
                settingsTab
            }
        }
        // Build 93: the player's bar while a text plays on with its sheet closed.
        .modifier(ListenMiniPlacement(shown: listenShown.mini, player: listen))
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
            ReviewAsk.shared.cameToFront()
        }
        #else
        NavigationSplitView {
            List(selection: Binding<AppTab?>(get: { tab }, set: { tab = $0 ?? (hasChats ? .chats : .home) })) {
                if hasChats {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right").tag(AppTab.chats)
                    Label("Collections", systemImage: "square.grid.2x2").tag(AppTab.collections)
                } else {
                    Label("Get Started", systemImage: "sparkles").tag(AppTab.home)
                }
                Label("Templates", systemImage: "text.badge.plus").tag(AppTab.templates)
                Label("Tips", systemImage: "lightbulb").tag(AppTab.tips)
                if whatsNewShown { Label("What's new", systemImage: "sparkles.rectangle.stack").tag(AppTab.whatsNew) }
                if showsPro { Label(proTabName, systemImage: "crown").tag(AppTab.pro) }
                Label("Settings", systemImage: "gearshape").tag(AppTab.settings)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
        } detail: {
            switch tab {
            case .home: HomeView(store: store, activation: activation, openPro: { tab = .pro }, openTips: { tab = .tips })
            case .chats: NavigationStack { ChatsView(library: chats, activation: activation, openSetup: { showingSetup = true }, openPro: { tab = .pro }, openTab: { tab = $0 }) }
            case .templates: NavigationStack { TemplatesView() }
            case .tips: TipsView(openPro: { tab = .pro })
            case .whatsNew: NavigationStack { WhatsNewView() }
            case .collections:
                NavigationStack { CollectionsView(library: chats, openPro: { tab = .pro }) }
            case .pro: ProView(store: store)
            case .settings: SettingsView(showPlan: $showPlan)
            }
        }
        .modifier(ListenMiniPlacement(shown: listenShown.mini, player: listen))
        // Build 94: the setup guide from the Chats screen's "…" (Other… → How to turn on ContextFlow).
        .sheet(isPresented: $showingSetup) {
            NavigationStack {
                HomeView(store: store, activation: activation, openPro: { showingSetup = false; tab = .pro }, openTips: { showingSetup = false; tab = .tips })
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSetup = false } }
                    }
            }
            .frame(minWidth: 560, minHeight: 600)
        }
        .frame(minWidth: 720, minHeight: 560)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            chats.refresh()
            Task {
                await store.refreshEntitlement()
                await activation.launched()
            }
            ReviewAsk.shared.cameToFront()
        }
        #endif
    }

    #if os(iOS)
    private var whatsNewTab: some View {
        NavigationStack { WhatsNewView() }
            .tabItem { Label("What's new", systemImage: "sparkles.rectangle.stack") }
            .tag(AppTab.whatsNew)
    }

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
            .tabItem { Label(proTabName, systemImage: "crown") }
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
                // Test builds, «Start as a new user» on (Setup.swift): what this is, and the way back.
                NewUserPreviewBanner()
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
                // 2.8 (В3.4): the friend's code card left the first screen (one job there: switching ContextFlow on).
                // A code is entered on Invite a friend, in Settings or from an invite link.
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
        // Our site's page in the person's language (2.7 (110); a web search for "ContextFlow" until then).
        FirstPage.open()
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
                activation.wentToSettings("card")
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
            } label: {
                Label("Open Safari Settings", systemImage: "gearshape")
            }
            .buttonStyle(.borderedProminent)
        }
        // 2.8 (В1.1): the funnel's zero step, the instruction shown.
        .onAppear { if !enabled { activation.instructionShown() } }
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
                        TipBlockHeader(title: group.title, count: group.tips.count, open: open, hasNew: group.tips.contains(where: \.isNew)) { toggle(group) }
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
    // A short recording of the extension doing it (TipClips/<language>/<clip>.mp4, TipClip.language).
    var clip: String? = nil
    // Organizing (2.5): Turn on or Try Pro under it.
    var organize = false
    // Needs Pro: the Pro badge by the title.
    var pro = false
    // Needs Ultra (2.6): the Ultra badge by the title.
    var ultra = false
    // The version that brought it ("2.7"): a quiet «New» by the title while that's the version What's new is about
    // (WhatsNew.version), gone with the next one (107, the owner).
    var since: String? = nil

    /// New in the version this build's What's new is about.
    var isNew: Bool { since == WhatsNew.version }
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
            text: "Click ✦ on the page or the ContextFlow icon in the toolbar, or press Control-Shift-E.", clip: "mac-open")
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
            text: "In any field on a page, type / and a few words of a template, then Tab. Control-Shift-V opens the whole list: what you copied in other tabs, your templates and ContextFlow's last answer.", clip: "mac-insert")
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
            text: "Point at an answer or a note: Pin, Remind me and Delete show beside it, and a right-click opens the same menu. Changed your mind? Undo brings it back.", clip: "mac-pin")
        #endif
    }

    // Reminders and watching are two lists (2.5): the bell is about time, the eye about a change on the page.
    // Also in What's new (2.6 (98), WhatsNew.items).
    static var remindTip: Tip {
        Tip(symbol: "bell", color: .orange, title: "Remind me about this page",
            text: "Reading something you want to finish later? Select a line and tap the bell, or tap … at the top of the panel, then Remind me about this page…, and pick a time: the reminder opens this page. Answers and notes have Remind me in their … menu.", clip: "later")
    }

    // Also in What's new (2.6 (98), WhatsNew.items).
    static var watchTip: Tip {
        Tip(symbol: "eye", color: .green, title: "Know when a price drops",
            text: "Select a price, a stock status or a date on a page and tap the eye. For the whole page, choose Watch this page… in the … menu at the top of the panel. ContextFlow checks the page while you use Safari and tells you when it changes, or drops below the price you name. Up to 5 at a time, 20 with Pro.", clip: "watch")
    }

    // Quick actions in the selection's field (2.6). Since 92 a Mac's pop-up has the same field and chips, scrolled with the
    // trackpad or the wheel; no clip there (the clip is touch).
    // Also in What's new (2.6 (98), WhatsNew.items).
    static var chipsTip: Tip {
        #if os(iOS)
        Tip(symbol: "hand.point.up.left", color: .indigo, title: "Quick actions under a selection",
            text: "Select text on a page: Summarize, Translate, Find similar and more wait in the “Your question…” field under it. Swipe along them and tap one, no typing needed.", clip: "chips")
        #else
        Tip(symbol: "cursorarrow.click", color: .indigo, title: "Quick actions under a selection",
            text: "Select text on a page: Summarize, Translate, Find similar and more wait in the “Your question…” field under it. Scroll along them with the trackpad or the mouse wheel and click one, no typing needed.", clip: "mac-chips")
        #endif
    }

    // Find similar (2.6, Ultra): from the panel's actions or its … menu, or from a selection (a chip in its field, on a
    // Mac too since 92). The clip is touch, so a Mac has none. 2.7 (#167, the owner): Pro has a quick search too, up to 5
    // a week, each counting as 10 answers; Ultra the full one. The badge is the first plan that has it.
    static var similarTip: Tip {
        #if os(iOS)
        Tip(symbol: "square.on.square", color: ultraViolet, title: "Find similar",
            text: "Tap Find similar among the panel's actions, or in the … menu at the top of the panel. Or select text, like a product's name, and tap Find similar among the quick actions under it. Add a condition like Cheaper or In stock if you want. Ultra searches in full and opens every link to check it before you see it. Pro has a quick search, up to 5 a week, each one counting as 10 answers.", clip: "similar", pro: true)
        #else
        Tip(symbol: "square.on.square", color: ultraViolet, title: "Find similar",
            text: "Click Find similar among the panel's actions, or in the … menu at the top of the panel. Or select text, like a product's name, and click Find similar among the quick actions under it. Add a condition like Cheaper or In stock if you want. Ultra searches in full and opens every link to check it before you see it. Pro has a quick search, up to 5 a week, each one counting as 10 answers.", clip: "mac-similar", pro: true)
        #endif
    }

    // Listen (2.6, Ultra): on iPhone and iPad the app plays it (it goes on with the screen locked), on a Mac the panel
    // does. The clip is the panel's player (build 98, the owner on 98: «Почему в What's new нет видео про Listen?
    // Должно быть»): with notifications on, iPhone and iPad play it there too, and the app carries it on when the page
    // goes; heard to its end, Listen gets its tick.
    // Also in What's new (2.6 (98), WhatsNew.items).
    static var listenTip: Tip {
        #if os(iOS)
        Tip(symbol: "speaker.wave.2.fill", color: ultraViolet, title: "Listen",
            text: "Tap Listen under an answer, or choose Listen to this page in the … menu at the top of the panel. The ContextFlow app reads it in a natural voice, and it keeps playing with the screen locked. Tap the speed in the player for 1×, 1.2×, 1.5× or 2×.", clip: "listen", ultra: true)
        #else
        Tip(symbol: "speaker.wave.2.fill", color: ultraViolet, title: "Listen",
            text: "Click Listen under an answer, or choose Listen to this page in the … menu at the top of the panel. A natural voice reads it right in the panel. Click the speed in the player for 1×, 1.2×, 1.5× or 2×.", clip: "listen", ultra: true)
        #endif
    }

    // Organizing (2.5, Pro): the chat it belongs in. The clip (build 98) starts at the Suggestions bar at the top of the
    // chat (2.6 (97)), which brings the suggestion under its answer.
    // Also in What's new (2.6 (98), WhatsNew.items).
    static var organizeTip: Tip {
        Tip(symbol: "arrow.turn.down.right", color: brandBlue, title: "Where it belongs",
            text: "Asked about a car in the chat about a sofa? Under the answer, ContextFlow suggests the chat it belongs in, or a new one. One tap moves it there, by date; Undo puts it back.", clip: "organize", organize: true, pro: true)
    }

    // 2.7: the new features, each where its block's readers look, with their clips (TipClips/en and /ru, site/clips);
    // What's new plays the same ones. A Mac's own clip (mac-…) where the pointer does it differently.

    // In-page translation (#168): the pill by ✦ on a page in another language. Also in What's new (2.7).
    static var translateTip: Tip {
        #if os(iOS)
        Tip(symbol: "character.bubble", color: .teal, title: "Read a page in your language",
            text: "On a page in another language, tap the “Translate to English?” line by ✦: the page itself switches to your language, links and all, and keeps going as you scroll. Original brings every word back. A page counts as one answer a week, however often you translate it.", clip: "translate", since: "2.7")
        #else
        Tip(symbol: "character.bubble", color: .teal, title: "Read a page in your language",
            text: "On a page in another language, click the “Translate to English?” line by ✦: the page itself switches to your language, links and all, and keeps going as you scroll. Original brings every word back. A page counts as one answer a week, however often you translate it.", clip: "translate", since: "2.7")
        #endif
    }

    // ✦ and the panel on either side (#173). The clip (side, 2.7) shows ✦ dragged along the edge and across.
    private static var sideTip: Tip {
        #if os(iOS)
        Tip(symbol: "arrow.up.and.down.and.arrow.left.and.right", color: brandBlue, title: "Move ✦ out of the way",
            text: "Is ✦ covering what you're reading? Drag it up or down along the edge, or across to the other side: it stays where you leave it. On iPad, drag the panel by its top bar to move it to the other side too. Screen side in the extension settings does the same.", clip: "side", since: "2.7")
        #else
        Tip(symbol: "arrow.up.and.down.and.arrow.left.and.right", color: brandBlue, title: "Move ✦ out of the way",
            text: "Is ✦ covering what you're reading? Drag it up or down along the edge, or across to the other side: it stays where you leave it. Drag the panel by its top bar to move it to the other side too, or choose Screen side in the extension settings.", clip: "side", since: "2.7")
        #endif
    }

    // Check and Rewrite (#174): atop quick insert's list on iPhone and iPad, the circle above the field on a Mac. Also in
    // What's new (2.7).
    static var writeTip: Tip {
        #if os(iOS)
        Tip(symbol: "checkmark.bubble", color: .indigo, title: "Check or rewrite before you send",
            text: "Writing an email or a comment? Tap the ContextFlow button by the field: Check and Rewrite are at the top of the list. Check fixes mistakes; Rewrite makes the text shorter, warmer, more formal or more confident. Both take the page into account, like the email you're answering, and Undo brings your words back. Each tap counts as one answer.", clip: "write", since: "2.7")
        #else
        Tip(symbol: "checkmark.bubble", color: .indigo, title: "Check or rewrite before you send",
            text: "Writing an email or a comment? Once you've written a few words, point at the circle above the field: Check fixes mistakes; Rewrite makes the text shorter, warmer, more formal or more confident. Both take the page into account, like the email you're answering, and Undo brings your words back. Each one counts as one answer.", clip: "mac-write", since: "2.7")
        #endif
    }

    // Live underlines (#177, Pro and Ultra).
    private static var underlineTip: Tip {
        #if os(iOS)
        Tip(symbol: "textformat.abc.dottedunderline", color: .indigo, title: "Mistakes underlined as you type",
            text: "With Pro or Ultra, pause while typing and a mistake in the paragraph you changed gets underlined. Tap the underline to see the fix, then Fix or Ignore. It doesn't count as answers, and you can turn it off in the extension settings.", clip: "underline", pro: true, since: "2.7")
        #else
        Tip(symbol: "textformat.abc.dottedunderline", color: .indigo, title: "Mistakes underlined as you type",
            text: "With Pro or Ultra, pause while typing and a mistake in the paragraph you changed gets underlined. Point at the underline to see the fix, then Fix or Ignore. It doesn't count as answers, and you can turn it off in the extension settings.", clip: "mac-underline", pro: true, since: "2.7")
        #endif
    }

    // Page snapshot in a note (#178): the visible area for everyone, the whole page with Pro. Also in What's new (2.7).
    static var shotTip: Tip {
        #if os(iOS)
        Tip(symbol: "photo.on.rectangle", color: .orange, title: "A snapshot with your note",
            text: "Writing a note? Turn on Page snapshot above the field and the note keeps a picture of the page: the part on screen, or with Pro the whole page. Tap the picture to open it full screen and crop it. It stays on your devices and in your iCloud.", clip: "shot", since: "2.7")
        #else
        Tip(symbol: "photo.on.rectangle", color: .orange, title: "A snapshot with your note",
            text: "Writing a note? Turn on Page snapshot above the field and the note keeps a picture of the page: the part on screen, or with Pro the whole page. Click the picture to open it full screen and crop it. It stays on your devices and in your iCloud.", clip: "shot", since: "2.7")
        #endif
    }

    // Calendar and Reminders (#170): the AI's card, the … menu, and Also in Reminders. Also in What's new (2.7).
    static var appleTip: Tip {
        Tip(symbol: "calendar.badge.plus", color: .red, title: "Add to Calendar or Reminders",
            text: "Ask “remind me to call the bank on Friday”, or about a date on the page: the answer comes with a card to check the date and time, and Add puts it in Calendar or Reminders. Any answer or note has Add to Calendar or Reminders in its … menu. In Remind me, Also in Reminders puts your reminder in Apple Reminders too.", clip: "apple", since: "2.7")
    }

    // Spaces (#171). Free's number isn't named here (the owner hasn't settled it): the limit card says it. Also in
    // What's new (2.7).
    static var spacesTip: Tip {
        Tip(symbol: "square.stack.3d.up", color: .purple, title: "Spaces for work and home",
            text: "Keep work, home and shopping apart. New space, at the end of the chat list, makes one in its own color. The switcher at the top of the list moves between them, and a new chat goes into the space you're in. In the switcher, Open amazon.com here keeps that site in this space. Free has a limit; with Pro or Ultra, as many as you like.", clip: "spaces", since: "2.7")
    }

    // Collections (2.7, #175, #182): "To collection" under an answer or a note, the Collections tab (the panel's window and
    // the app's), Compare and Summary with Pro, a PDF.
    static var collectionsTip: Tip {
        Tip(symbol: "square.grid.2x2", color: .orange, title: "Gather it in a collection",
            text: "Planning a trip or a purchase? Choose To collection under an answer or a note, or in its … menu, and ContextFlow suggests where it goes. Collections keeps it all in sections, in Safari and in the app. With Pro, the AI sorts the cards, Compare puts the ones you pick side by side, and Summary sums it all up. Any collection saves as a PDF.", clip: "collections", since: "2.7")
    }

    // The matching chat when the panel opens (#172).
    private static var matchTip: Tip {
        Tip(symbol: "doc.text.magnifyingglass", color: .teal, title: "The chat for this page",
            text: "Open the panel on a page and ContextFlow picks the chat about it: the one with this page, or one on the same subject. Continuing at the top says which chat it picked; New chat there starts a fresh one.", clip: "match", since: "2.7")
    }

    // The page hints by ✦ in the first days (#176, #179): Tips point to them, their how-to card points back to Tips.
    private static var pageHintsTip: Tip {
        Tip(symbol: "lightbulb", color: .yellow, title: "Tips by the ✦ button",
            text: "In your first days, a short line by ✦ suggests something for the page you're on: a summary of a long article, a price to watch, a date for your calendar. Tap it to see how. Turn the lines off in the extension settings, under Tips by the ✦ button.", clip: "pagehints", since: "2.7")
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
            // 2.6 (93), the owner, twice: «в Tips не видел… про возможность перемещать кружок для удобства чтения
            // страниц». Moving ✦ aside is a first-block card with the clip; hiding it stays under personalization. 2.7:
            // the panel moves too (sideTip).
            sideTip,
            Tip(symbol: "list.bullet.rectangle", color: .orange, title: "One tap for the gist",
                text: "Summarize, Key takeaways, Explain simply and Translate work on the whole page — no need to write a prompt.", clip: "gist"),
            translateTip,
            Tip(symbol: "text.cursor", color: .purple, title: "Ask about a part",
                text: "Select text on the page and choose Ask AI: the answer is about just that part. It can also explain, translate or rewrite it.", clip: "part"),
            Tip(symbol: "text.quote", color: .orange, title: "Ask or note a selection",
                text: "Select text on a page: type your own question about it right under the selection, or tap Note to save it to the chat with its page. Notes use no answers.", clip: "select"),
            chipsTip,
            Tip(symbol: "bubble.left.and.bubble.right", color: .teal, title: "A chat follows you",
                text: "Keep asking as you move from page to page. ContextFlow remembers the conversation and which page each question was about. Tap a page's name in the chat to go back to it.", clip: "follows"),
            Tip(symbol: "magnifyingglass", color: .green, title: "Fresh facts from Google",
                text: "Turn on Google next to the question field to answer with Google Search: news, prices and anything recent, with sources.", clip: "google")
        ]),
        TipGroup(id: "deeper-work", title: "Deeper work", tips: [
            Tip(symbol: "pencil.line", color: .orange, title: "Notes of your own",
                text: "Swipe the send button up or down (on a Mac, scroll on it) to write a note instead of asking, or tap + by the field and choose Note. It stays in the chat with its page, syncs with it and uses no answers.", clip: "notes"),
            shotTip,
            Tip(symbol: "highlighter", color: .yellow, title: "Highlight what matters",
                text: "Select a line in an answer and tap Highlight: it stays marked, like with a pen. Later answers in that chat take your highlights into account, and Copy keeps them in bold.", clip: "highlight"),
            Tip(symbol: "pin", color: .purple, title: "Pinned at the top",
                text: "Pin an answer or a note and it waits in the bar at the top of the chat. Tap the bar to jump to it, tap again for the next one.", clip: "pinned"),
            swipeTip,
            Tip(symbol: "rectangle.stack", color: .blue, title: "The whole chat in mind",
                text: "Turn on Whole chat under + by the question field when an answer needs everything: all messages, your notes and the other pages of this chat. Off, answers use the last messages and the open page.", clip: "whole"),
            Tip(symbol: "play.rectangle", color: .red, title: "Ask about a video",
                text: "With Pro, ContextFlow reads the transcript of a video on the page: ask for the gist, or what was said about something, and the answer points to the moment, like [4:15]. Free answers use the page's text.", clip: "video", pro: true),
            Tip(symbol: "doc.richtext", color: .orange, title: "PDFs on the page",
                text: "With Pro, PDFs shown on a page or linked from it go with your question, and answers say which page they're on. On iPad and Mac, ContextFlow in the toolbar opens on a PDF tab too. Free answers use the page's text.", clip: "pdf", pro: true),
            similarTip,
            listenTip
        ]),
        TipGroup(id: "quick-insert", title: "Quick insert", tips: [
            insertTip,
            writeTip,
            underlineTip,
            copiedTip,
            Tip(symbol: "curlybraces", color: .orange, title: "Templates that fill themselves",
                text: "Select a reply you send often and tap Template: ContextFlow marks the name, the date and whatever else changes. When you insert it, Fill from the page puts them in, highlighted so you can check.", clip: "fill")
        ]),
        TipGroup(id: "watch-and-remind", title: "Watch and remind", tips: [
            remindTip,
            appleTip,
            watchTip
        ]),
        TipGroup(id: "chats-in-order", title: "Chats in order", tips: [
            Tip(symbol: "square.and.pencil", color: .indigo, title: "Start fresh or go back",
                text: "Start a new chat with +. Earlier chats wait in the chat list: open one to pick up where you left off, rename it with the pencil, or delete it.", clip: "chats"),
            spacesTip,
            matchTip,
            collectionsTip,
            Tip(symbol: "magnifyingglass", color: .green, title: "Search your chats",
                text: "Type in the search over the chat list: every chat with those words, with the place they're in. A result opens the chat right there.", clip: "search"),
            Tip(symbol: "tag", color: .purple, title: "Tags and folders",
                text: "Tag a chat, an answer or a note with 🏷, or with Tag in its … menu. Tap a tag to see only its chats, or turn on Folders to group the list by tag.", clip: "tags"),
            Tip(symbol: "square.and.arrow.up", color: .pink, title: "Share what you found",
                text: "Share one answer or the whole chat: the text comes with its links, its sources and a link to ContextFlow.", clip: "share"),
            Tip(symbol: "bubble.left.and.bubble.right", color: .teal, title: "Your chats in the app",
                text: "The Chats tab has every chat from Safari. Ask about its pages or add a note right there, tag, copy or share any answer, or share the whole chat. “Continue in Safari” picks it up where you left off.", clip: "appchat"),
            Tip(symbol: "sparkles", color: brandBlue, title: "AI search",
                text: "Describe the chat you remember — “that article about sleep and coffee” — even without the exact words. In the app, choose By meaning under the search; in Safari, tap ✦ next to it.", clip: "aisearch", pro: true),
            Tip(symbol: "text.bubble", color: .indigo, title: "Ask your chats",
                text: "The first row of the chat list answers from all your chats at once: “What did I read this week?”, “Summarize my notes on AI”.", clip: "history", pro: true),
            organizeTip,
            Tip(symbol: "tag", color: .purple, title: "Your tags, suggested",
                text: "ContextFlow learns what your tags mean from where you put them, and suggests the right one under a new answer or note. Only your own tags, only when they fit.", clip: "suggested-tags", organize: true, pro: true)
        ]),
        // 2.6: monthly or yearly, and the tour of a plan (text only: the tour itself is being reworked).
        TipGroup(id: "your-plan", title: "Your plan", tips: [
            Tip(symbol: "calendar", color: .green, title: "Monthly or yearly",
                text: "Pro and Ultra come monthly or yearly, and a year costs less than twelve months. Tap Yearly above the plans, in the app or in Safari, to see each price and what you save. On monthly already? Switch to yearly is in Settings → Your plan: it starts when your current month ends.", clip: "yearly"),
            // 107, the owner: «What your plan adds не нужен в tips» (the tour itself stays in the panel's and Settings' menus).
            // 2.7 (#181): the code and the link in Settings, the friend's bonus answers, the inviter's discount. No figures:
            // the panel's and the app's own invite screens name them.
            Tip(symbol: "gift", color: .pink, title: "Invite a friend",
                text: "Settings → Invite a friend, in the app or in Safari, gives you a code and a link to send. Your friend gets bonus answers every day of their first week. Once they've asked questions on two different days, you get a discount on your first month of Pro or Ultra.", clip: "invite", since: "2.7")
        ]),
        TipGroup(id: "privacy-and-personalization", title: "Privacy & personalization", tips: [
            Tip(symbol: "person.text.rectangle", color: .mint, title: "Tell it about you",
                text: "Add a line under About me — what you do, how you like answers — and ContextFlow will tailor them to you.", clip: "about"),
            Tip(symbol: "eye.slash", color: .blue, title: "Hide ✦ when you don't need it",
                text: "Don't need ✦ on a site? Hide it on that site, or turn it off everywhere in the extension settings. ContextFlow still opens from Safari's extensions menu.", clip: "hide"),
            pageHintsTip,
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
                if tip.ultra { UltraBadge() }
                if tip.isNew { NewBadge() }
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

/// «New» by the title of a card whose feature came with this version (107, the owner: «подсвечивались слегка»): quiet,
/// tinted text on a faint fill, no solid colour (those are Pro's and Ultra's).
struct NewBadge: View {
    var body: some View {
        Text("New", comment: "A quiet badge by a Tips card whose feature is new in this version (2.7)")
            .font(.caption2.weight(.semibold))
            .foregroundColor(brandBlue)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(brandBlue.opacity(0.12)))
            .accessibilityIdentifier("cf-tip-new")
    }
}

/// "Ultra" by an Ultra card's title in Tips (2.6), as ProBadge is for Pro's, in Ultra's violet.
struct UltraBadge: View {
    var body: some View {
        Text("Ultra")
            .font(.caption2.weight(.bold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(ultraViolet))
    }
}

/// A block's title: a tap opens or folds it; folded, it says how many tips are inside.
struct TipBlockHeader: View {
    let title: LocalizedStringKey
    let count: Int
    let open: Bool
    // The block holds cards that are new in this version: said on a folded block, so they're found (107).
    var hasNew = false
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
                    if hasNew { NewBadge() }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.forward")
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

    /// The clips' language (build 95, one rule for every language, TipClipShare.language): the first of the app's
    /// language and the person's other languages that has its clips (TipClips/<language>/), else English.
    static let language: String = {
        let folder = Bundle.main.url(forResource: "TipClips", withExtension: nil)
        return TipClipShare.language(Bundle.main.preferredLocalizations + Locale.preferredLanguages, available: folder.map(TipClipShare.languages) ?? [])
    }()

    static func url(_ name: String) -> URL? {
        Bundle.main.url(forResource: name, withExtension: "mp4", subdirectory: "TipClips/\(language)")
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
    @ObservedObject private var paywall = Paywall.shared
    @Environment(\.openURL) private var openURL
    @State private var busyProduct: String?
    @State private var restoring = false
    @State private var message: String?
    @State private var success: String?
    /// A change that starts at the next renewal (a lower plan, or the same plan yearly): `success` then says when, not
    /// "is active" (the 2.6 gate: choosing Pro on Ultra said "Pro is active" while Ultra went on to the renewal).
    @State private var startsLater = false
    /// Own key's card, behind its link «I have my own API key» until asked for (109).
    @State private var ownKeyOpen = false

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    hero
                    if store.isByok { byokCard } else if store.entitlement.active { activeCard }
                    plans
                    PaidGallery(facts: store.planFacts, startOnUltra: focusTier == .ultra)
                        .onAppear { if !store.isPro { ChatAI.reportOrganize("organize_promo", ["action": "shown", "where": "pro_screen"]) } }
                    features
                    actions
                    legal
                }
                .padding(20)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .onAppear { scrollToFocus(scroller) }
            .onChange(of: paywall.focus) { _ in scrollToFocus(scroller) }
            .onAppear { buyChosen() }
            .onChange(of: paywall.buyNow) { _ in buyChosen() }
            // 2.8 (В7.2): what the one-tap purchase from the panel couldn't finish.
            .onAppear { takeNotice() }
            .onChange(of: paywall.notice) { _ in takeNotice() }
            // 2.8 (В1.5): the plans screen shown, and where from.
            .onAppear { ChatAI.reportUse("paywall", "shown", ["via": paywall.via]) }
            .onDisappear { paywall.via = "tab" }
            .onChange(of: store.products.count) { _ in buyChosen() }
        }
        .navigationTitle("ContextFlow Pro")
        .task { await store.refreshPlanFacts() }
        .alert(isPresented: Binding(get: { success != nil }, set: { if !$0 { success = nil } })) {
            Alert(
                title: Text("You're all set"),
                message: startsLater ? Text(verbatim: success ?? "") : Text("\(success ?? "Pro") is active. Open Safari and tap ✦ on any page."),
                dismissButton: .default(Text("OK")) { ReviewAsk.shared.ask(.purchase, after: 0.5) }
            )
        }
    }

    private func takeNotice() {
        guard let notice = paywall.notice else { return }
        paywall.notice = nil
        message = notice
    }

    /// Chosen in the panel (contextflow://subscribe?plan=…&period=…): its purchase opens at once, once the plans have
    /// loaded and are on screen (build 95). Not the subscription the person already has.
    private func buyChosen() {
        guard let id = paywall.buyNow, busyProduct == nil, let product = store.products.first(where: { $0.id == id }) else { return }
        paywall.buyNow = nil
        guard !(store.entitlement.active && store.entitlement.productId == id) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { buy(product) }
    }

    /// From the panel's plans sheet (contextflow://subscribe?plan=…&period=…): the chosen plan in view.
    private func scrollToFocus(_ scroller: ScrollViewProxy) {
        guard let focus = paywall.focus else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            withAnimation { scroller.scrollTo(focus.rawValue, anchor: .center) }
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
        .background(store.isUltra ? ultraGradient : brandGradient)
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
                // The plan's tour, when it starts now, takes the place of "You're all set".
                case .purchased: if !PlanTour.shared.takesOverPurchase() { startsLater = false; success = String(localized: "Pro") }
                case .pending: message = String(localized: "Your purchase is waiting for approval.")
                case .cancelled: break
                }
            } catch {
                message = (error as? ChatAI.Failure)?.message ?? error.localizedDescription
            }
            busyProduct = nil
        }
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Everything in Pro").font(.headline)
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

    // MARK: Plans (2.6): Pro and Ultra, monthly or yearly; Own key under its link (109)

    /// The row of plans. Pro and Ultra are the choice (109, the owner: «Ок, давай под ссылку»): Own key is for someone
    /// who already has an OpenAI or Claude key, so it sits under the link «I have my own API key» and comes last once
    /// the link is tapped, or when the panel sent the person here for Own key. Its subscriber sees the row as before.
    static func tiersShown(current: StoreKitManager.Tier?, ownKeyOpen: Bool) -> [StoreKitManager.Tier] {
        if current == .byok { return StoreKitManager.Tier.allCases }
        return ownKeyOpen ? [.pro, .ultra, .byok] : [.pro, .ultra]
    }

    private var ownKeyShown: Bool { ownKeyOpen || paywall.focus == .byok }

    private var hasYearly: Bool { StoreKitManager.Tier.allCases.contains { store.product($0, yearly: true) != nil } }

    @ViewBuilder
    private var plans: some View {
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
            VStack(alignment: .leading, spacing: 12) {
                if hasYearly {
                    Picker("Billing", selection: $paywall.yearly) {
                        Text("Monthly").tag(false)
                        // The best saving among the plans in the row (Own key's, when it isn't shown, is not named).
                        if let best = Self.tiersShown(current: store.tier, ownKeyOpen: ownKeyShown).compactMap({ store.yearlyDeal($0)?.percent }).max() {
                            Text("Yearly · save up to \(best)%").tag(true)
                        } else {
                            Text("Yearly").tag(true)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("plans.period")
                }
                ForEach(Self.tiersShown(current: store.tier, ownKeyOpen: ownKeyShown)) { tier in
                    if let product = store.product(tier, yearly: paywall.yearly && hasYearly) ?? store.product(tier, yearly: false) {
                        TierCard(
                            tier: tier,
                            needsOwnKey: tier == .byok && store.tier != .byok,
                            product: product,
                            monthly: store.product(tier, yearly: false),
                            deal: product.subscription?.subscriptionPeriod.unit == .year ? store.yearlyDeal(tier) : nil,
                            facts: store.planFacts,
                            focused: tier == focusTier,
                            current: store.entitlement.active && store.entitlement.productId == product.id,
                            currentTier: store.tier,
                            fromMonthly: store.entitlement.active && store.product(tier, yearly: false)?.id == store.entitlement.productId,
                            trialEligible: store.introEligible.contains(product.id),
                            busy: busyProduct == product.id,
                            action: { buy(product) }
                        )
                        .id(tier.rawValue)
                    }
                }
                if store.tier != .byok, !ownKeyShown, store.byok != nil {
                    Button("I have my own API key") { withAnimation { ownKeyOpen = true } }
                        .buttonStyle(.borderless)
                        .font(.callout.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .accessibilityIdentifier("plans.ownkey.link")
                }
                if let note = changeNote {
                    Text(note)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let code = store.unclearCurrency {
                    Text("Prices in \(code), as the App Store gives them.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("plans.currency")
                }
            }
        }
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundColor(.secondary)
        }
    }

    /// The plan to highlight: the panel's choice, else the next one up from the current plan (Pro for Free).
    private var focusTier: StoreKitManager.Tier {
        if let focus = paywall.focus { return focus }
        switch store.tier {
        case .pro?, .ultra?: return .ultra
        default: return .pro
        }
    }

    /// What happens to the current plan when the focused one is bought.
    private var changeNote: String? {
        guard let current = store.tier, current != focusTier else { return nil }
        let name = focusTier.name
        return focusTier.rank > current.rank
            ? String(localized: "\(name) starts now. Apple refunds the unused part of \(current.name).")
            : String(localized: "\(name) starts when your current plan renews.")
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

    private func buy(_ product: Product) {
        busyProduct = product.id
        message = nil
        // 2.8 (В1.5): every purchase with where it started (the tab, a link from the panel, …), its plan and period.
        let fields = PurchaseEvent.fields(product.id, via: paywall.via)
        ChatAI.reportUse("paywall", "plan", fields)
        paywall.purchasing = true
        Task {
            defer { paywall.purchasing = false }
            do {
                let outcome = try await store.purchase(product)
                ChatAI.reportUse("paywall", outcome == .purchased ? "buy_ok" : outcome == .pending ? "buy_pending" : "buy_cancel", fields)
                switch outcome {
                // The plan's tour, when it starts now, takes the place of "You're all set".
                case .purchased:
                    // Bought, but another plan stays on until the renewal (the App Store's sheet said so): said here too.
                    if store.entitlement.active, let current = store.entitlement.productId, current != product.id {
                        startsLater = true
                        success = PlanProducts.plan(of: current) == PlanProducts.plan(of: product.id) && product.id.hasSuffix(".yearly")
                            ? String(localized: "Yearly starts when your current month ends.")
                            : String(localized: "\(planName(product.id)) starts when your current plan renews.")
                    } else if !PlanTour.shared.takesOverPurchase() {
                        startsLater = false
                        success = planName(product.id)
                    }
                case .pending: message = String(localized: "Your purchase is waiting for approval.")
                case .cancelled: break
                }
            } catch {
                ChatAI.reportUse("paywall", "buy_fail", fields)
                message = error.localizedDescription
            }
            busyProduct = nil
        }
    }
}

/// 2.8 (В7.2): a plan and period chosen in the panel, with the page to go back to (contextflow://subscribe?plan=pro&
/// period=monthly&via=sheet&back=<page>): the App Store's sheet for it at once, then Safari again: iPhone and iPad open
/// the page with #cf-bought=<plan | later | no> (the panel takes it out and reopens), the Mac brings Safari's window back.
/// The page's address stays on the device. Waiting for approval, or an error: the Pro tab, saying so.
@MainActor
enum QuickBuy {
    static func wants(_ url: URL) -> Bool { product(url) != nil && back(url) != nil }

    static func product(_ url: URL) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let plan = items.first(where: { $0.name == "plan" })?.value.flatMap(StoreKitManager.Tier.init(rawValue:)),
              let period = items.first(where: { $0.name == "period" })?.value else { return nil }
        return "com.contextflow.\(plan.rawValue).\(period == "yearly" ? "yearly" : "monthly")"
    }

    static func back(_ url: URL) -> URL? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let value = items.first(where: { $0.name == "back" })?.value, value.count <= 2000,
              let page = URL(string: value), ["http", "https"].contains(page.scheme ?? "") else { return nil }
        return page
    }

    /// Where in the panel it started (the events' `via`): the plans sheet, the plans in the chat, Settings' yearly line.
    static func via(_ url: URL) -> String {
        let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "via" }?.value ?? ""
        return ["sheet", "chat", "settings", "yearly"].contains(value) ? "panel_\(value)" : "panel"
    }

    private static var running = false

    static func run(_ url: URL, store: StoreKitManager, showPlans: @escaping () -> Void) {
        guard !running, let id = product(url), let page = back(url) else {
            if !running { Paywall.shared.purchasing = false }
            return
        }
        running = true
        Paywall.shared.purchasing = true
        Task { @MainActor in
            defer {
                running = false
                Paywall.shared.purchasing = false
            }
            if store.products.isEmpty { await store.loadProducts() }
            guard let product = store.products.first(where: { $0.id == id }) else {
                // The App Store didn't answer: the plans, with the plan chosen, as before.
                Paywall.shared.open(url)
                showPlans()
                return
            }
            let fields = PurchaseEvent.fields(product.id, via: via(url))
            ChatAI.reportUse("paywall", "plan", fields)
            do {
                switch try await store.purchase(product) {
                case .purchased:
                    ChatAI.reportUse("paywall", "buy_ok", fields)
                    let now = store.entitlement.active && store.entitlement.productId == product.id
                    backToSafari(page, word: now ? PlanProducts.plan(of: product.id) : "later")
                case .cancelled:
                    ChatAI.reportUse("paywall", "buy_cancel", fields)
                    backToSafari(page, word: "no")
                case .pending:
                    ChatAI.reportUse("paywall", "buy_pending", fields)
                    Paywall.shared.notice = String(localized: "Your purchase is waiting for approval.")
                    showPlans()
                }
            } catch {
                ChatAI.reportUse("paywall", "buy_fail", fields)
                Paywall.shared.notice = error.localizedDescription
                Paywall.shared.open(url)
                Paywall.shared.buyNow = nil
                showPlans()
            }
        }
    }

    static func backToSafari(_ page: URL, word: String) {
        #if os(iOS)
        var parts = URLComponents(url: page, resolvingAgainstBaseURL: false)
        if (parts?.fragment ?? "").isEmpty { parts?.fragment = "cf-bought=\(word)" }
        let target = parts?.url ?? page
        // The address itself, not `x-safari-https://`: Safari then goes back to the tab that has this page, where the panel
        // is as it was (the director's acceptance 2, D2-5: x-safari- always opened a new tab, the page's state lost; the
        // simulator check: the address itself 3 tabs → 3, x-safari- 3 → 4). Where another browser is the default, iOS opens
        // the page there: no way to name Safari and keep the tab; the status bar's «◀ Safari» still goes back.
        UIApplication.shared.open(target)
        #else
        // Safari's own window, as it was (the tab and its panel): no new tab.
        PlanTour.openSafari()
        #endif
    }
}

/// 2.8 (В1.5): what a purchase's events carry: the plan, its period, the offer it went with, and where it started.
enum PurchaseEvent {
    static func fields(_ productId: String, via: String, offer: String = "none") -> [String: String] {
        ["via": via, "plan": PlanProducts.plan(of: productId), "period": productId.hasSuffix(".yearly") ? "yearly" : "monthly", "offer": offer]
    }
}

/// What the panel's plans sheet chose (contextflow://subscribe?plan=ultra&period=yearly), for the Pro screen.
final class Paywall: ObservableObject {
    static let shared = Paywall()

    /// The link names a plan, and a period, other than the subscription the person has (or they have none): the plans
    /// screen opens on it, its Buy for that product. Without a period, any other plan.
    static func wantsPlan(_ url: URL, current productId: String?) -> Bool {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let tier = items.first(where: { $0.name == "plan" })?.value.flatMap(StoreKitManager.Tier.init(rawValue:)) else { return false }
        guard let productId else { return true }
        guard let period = items.first(where: { $0.name == "period" })?.value else { return PlanProducts.plan(of: productId) != tier.rawValue }
        return "com.contextflow.\(tier.rawValue).\(period == "yearly" ? "yearly" : "monthly")" != productId
    }
    @Published var focus: StoreKitManager.Tier?
    @Published var yearly = true
    /// The product to buy at once (build 95, the owner since 91: "Choose…" in the panel and "Buy" in the chat open the
    /// App Store's purchase of that plan and period, not the plans with one more tap to go).
    @Published var buyNow: String?
    /// 2.8: what the one-tap purchase couldn't finish (waiting for approval, an error), said on the Pro screen.
    @Published var notice: String?
    /// 2.8 (the director's acceptance, shot 15): the App Store's sheet is up for a purchase. Nothing else is presented
    /// meanwhile (What's new waits for another time); after a one-tap purchase or a cancel the person is back in Safari.
    @Published var purchasing = false
    /// 2.8 (В1.5): how the plans screen was reached: the tab itself, or a link (from the panel: where in it).
    var via = "tab"

    func open(_ url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        via = items.contains { $0.name == "via" } ? QuickBuy.via(url) : "deeplink"
        let value = { (name: String) in items.first { $0.name == name }?.value }
        let plan = value("plan").flatMap(StoreKitManager.Tier.init(rawValue:))
        if let plan { focus = plan }
        if let period = value("period") { yearly = period == "yearly" }
        // A plan and a period named: that product is bought now (the plans stay behind the App Store's sheet).
        if let plan, let period = value("period") { buyNow = "com.contextflow.\(plan.rawValue).\(period == "yearly" ? "yearly" : "monthly")" }
    }
}

let ultraGradient = LinearGradient(colors: [Color(red: 0.55, green: 0.36, blue: 0.96), brandBlue], startPoint: .topLeading, endPoint: .bottomTrailing)

extension StoreKitManager.Tier {
    var name: String {
        switch self {
        case .byok: return String(localized: "Own key")
        case .pro: return String(localized: "Pro")
        case .ultra: return String(localized: "Ultra")
        }
    }
}

/// One plan on the Pro screen: its price for the period, what it adds in plain words, and its button.
struct TierCard: View {
    let tier: StoreKitManager.Tier
    /// Own key shown to someone who doesn't have it: one sentence under its name saying what it needs (109).
    var needsOwnKey = false
    let product: Product
    let monthly: Product?
    /// Yearly shown: a month of it and what it saves (the App Store's format).
    let deal: StoreKitManager.YearlyDeal?
    let facts: ChatAI.PlanFacts
    let focused: Bool
    let current: Bool
    let currentTier: StoreKitManager.Tier?
    /// The subscriber has this plan monthly: its yearly card is an upgrade too (build 91).
    var fromMonthly = false
    let trialEligible: Bool
    let busy: Bool
    let action: () -> Void

    private var yearly: Bool { product.subscription?.subscriptionPeriod.unit == .year }

    private var priceLine: String {
        yearly ? String(localized: "\(product.displayPrice) / year") : String(localized: "\(product.displayPrice) / month")
    }

    private var saving: Int? { deal?.percent }

    private var lines: [(String, LocalizedStringKey)] {
        switch tier {
        case .byok:
            return [
                ("key.fill", "Unlimited answers with your own OpenAI or Claude API key"),
                ("doc.text.magnifyingglass", "Everything on the page: summaries, explanations, translations")
            ]
        case .pro:
            return [
                ("bolt.fill", "Up to \(facts.proWeekly) answers a week, no API key needed"),
                ("play.rectangle", "Videos and PDFs, AI search, Ask your chats, sorting by topic"),
                ("eye", "Watch up to \(facts.watchPro) pages for price drops and changes")
            ]
        case .ultra:
            return [
                ("checkmark.circle", "Everything in Pro, plus:"),
                ("speaker.wave.2.fill", "Listen to answers and whole pages in a natural voice: \(facts.speakWeeklyMinutes) minutes a week"),
                ("square.on.square", "Find similar: alternatives to any page — cheaper, newer, in stock or in your language — \(facts.similarWeekly) searches a week"),
                ("eye", "Watch up to \(facts.watchUltra) pages")
            ]
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(tier.name).font(.title3.weight(.bold))
                if let saving {
                    Text("Save \(saving)%")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.green.opacity(0.15)))
                        .foregroundColor(.green)
                }
                Spacer()
                Text(priceLine).font(.headline)
            }
            if needsOwnKey {
                Text("This plan needs your own OpenAI or Claude API key. You pay that provider for the answers separately.")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("plans.ownkey.needs")
            }
            // Yearly: what a month of it comes to, against twelve months, and the money it saves.
            if let deal {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(deal.perMonth) a month, billed yearly")
                        .font(.footnote.weight(.medium))
                    Spacer(minLength: 4)
                    Text(deal.twelveMonths)
                        .font(.footnote)
                        .strikethrough()
                        .foregroundColor(.secondary)
                        .accessibilityHidden(true)
                }
                Text("You save \(deal.saving) a year")
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(.green)
            }
            // An Ultra subscriber: this week's listening on Ultra's card too, as in the panel's plans (build 95; the owner
            // asked for the minutes left in the player, Settings and the plans).
            if tier == .ultra, currentTier == .ultra, let left = facts.speakLeftSeconds {
                Text("Listening: \(left / 60) of \(facts.speakWeeklyMinutes) min left this week")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .accessibilityIdentifier("plans.listen.left")
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Feature(systemImage: line.0, text: line.1)
            }
            Button(action: action) {
                Group {
                    if busy {
                        ProgressView()
                    } else if current {
                        Text("Current plan")
                    } else if trialEligible, product.subscription?.introductoryOffer?.paymentMode == .freeTrial {
                        Text("Start free trial")
                    } else if let currentTier, currentTier.rank < tier.rank {
                        Text("Upgrade to \(tier.name)")
                    } else if fromMonthly, yearly {
                        Text("Upgrade to yearly")
                    } else {
                        Text("Subscribe for \(priceLine)")
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(focused ? (tier == .ultra ? Color(red: 0.49, green: 0.31, blue: 0.93) : brandBlue) : .gray)
            .disabled(busy || current)
            .accessibilityIdentifier("plans.buy.\(tier.rawValue)")
        }
        .padding(16)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(focused ? (tier == .ultra ? Color(red: 0.55, green: 0.36, blue: 0.96) : brandBlue) : Color.secondary.opacity(0.25), lineWidth: focused ? 2 : 1))
    }
}

// MARK: - Components

func planName(_ productId: String?) -> String {
    switch PlanProducts.plan(of: productId) {
    case "byok": return String(localized: "Own key plan")
    case "ultra": return String(localized: "Ultra")
    default: return String(localized: "Pro")
    }
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
                    .environment(\.openURL, OpenURLAction { _ in
                        ChatAI.reportUse("rate", "link", ["via": "footer"])
                        return .systemAction
                    })
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
    /// 2.7: Spaces, on by default (nothing shows while there's one); off: one list again, nothing lost.
    @Published var spaces = true { didSet { save() } }

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
        spaces = stored["spaces"] as? Bool ?? true
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
        let spacesChanged = (stored["spaces"] as? Bool ?? true) != spaces
        stored["spaces"] = spaces
        SharedDefaults.shared.writeSettings(stored, updatedAt: Date().timeIntervalSince1970 * 1000)
        if syncChanged { ChatLibrary.shared.refresh() }
        if spacesChanged {
            ChatLibrary.shared.objectWillChange.send()
            ChatAI.reportUse("space", "toggle", ["via": "settings", "val": spaces ? "on" : "off"])
        }
    }
}

struct SettingsView: View {
    @StateObject private var settings = ExtensionSettings()
    @ObservedObject private var store = StoreKitManager.shared
    @Environment(\.openURL) private var openURL
    @State private var restoring = false
    @State private var showingMyDetails = false
    @ObservedObject private var appleAccess = AppleAccessModel.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var restoreMessage: String?
    @State private var switching = false
    /// "Hide" on the yearly line: away for 60 days (it's a line in Settings, never a prompt).
    @AppStorage("cf_yearly_hidden_until") private var yearlyHiddenUntil: Double = 0
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
            // 2.7, TestFlight and debug builds only, never the App Store's (Setup.swift TestBuild): the first run again
            // on this device, without touching what's in iCloud. First on the screen, so a tester finds it (108).
            if TestBuild.isTest { NewUserPreviewSection() }

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

            // 2.7: Spaces (the owner: «Давай сделаем Пространства выключаемой опцией в настройках»).
            Section(
                footer: Text("Work, Personal, Shopping: each with its own chats and color. Off: every chat in one list, and your spaces stay.")
            ) {
                Toggle("Spaces", isOn: $settings.spaces)
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

            // 2.7.1: the agent's «My details» for forms on sites (the panel edits the same store).
            Section(footer: Text("For filling in forms on sites. Kept on your device; the agent fills them in only after you agree, and the AI never sees them.")) {
                Button("My details") { showingMyDetails = true }
            }
            .sheet(isPresented: $showingMyDetails) {
                NavigationStack {
                    MyDetailsView()
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingMyDetails = false } } }
                }
                #if os(macOS)
                .frame(minWidth: 480, minHeight: 520)
                #endif
            }

            // 2.7.1: the agent's Calendar and Reminders, seen and allowed here as in the panel's Settings.
            Section(header: Text("Calendar and Reminders"), footer: Text("The agent picks times that are free in your calendar and can add bookings to it. What's in your calendar never leaves the device.")) {
                AccessRow(title: "Calendar", state: appleAccess.calendar) { appleAccess.allow(.event) }
                AccessRow(title: "Reminders", state: appleAccess.reminders) { appleAccess.allow(.reminder) }
            }
            .onAppear { appleAccess.refresh() }
            .onChange(of: scenePhase) { phase in
                // Back from the system's Settings: read it again.
                if phase == .active { appleAccess.refresh() }
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

            // 2.7 (plan section 5): invite a friend, optional; the friend gets answers, the inviter an App Store offer code.
            Section {
                Button {
                    InviteModel.shared.shown = true
                } label: {
                    Label("Invite a friend", systemImage: "gift")
                }
                .accessibilityIdentifier("cf-invite")
            }

            // 2.6 (100): the App Store's "Write a Review", whenever the person wants to. Apple's own request comes by
            // itself at good moments (ReviewAsk); nothing of ours asks for a rating (guideline 5.6.1).
            Section {
                Button {
                    ChatAI.reportUse("rate", "link", ["via": "settings"])
                    openURL(Links.review)
                } label: {
                    Label("Rate in App Store", systemImage: "star")
                }
                .accessibilityIdentifier("cf-rate")
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

    private var planSection: some View {
        Section(header: Text("Your plan"), footer: restoreMessage.map { Text($0) }) {
            HStack {
                Text(planName(store.entitlement.productId))
                    .task { if store.isPro { await store.refreshPlanFacts() } }
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
            // Ultra: this week's listening (build 91: the owner wanted to see the minutes left somewhere).
            if store.isUltra, let left = store.planFacts.speakLeftSeconds {
                Text("Listening: \(left / 60) of \(store.planFacts.speakWeeklyMinutes) min left this week")
                    .foregroundColor(.secondary)
            }
            // 2.8 (В7.4): Pro's weekly taste of Listen, and what Ultra has.
            if !store.isUltra, let taste = store.planFacts.tasteSpeakSeconds, let left = store.planFacts.speakLeftSeconds {
                Text("Listen in Pro: \(left / 60) of \(taste / 60) min left this week")
                    .foregroundColor(.secondary)
                // To the plans, Ultra first (the app's own link, as the panel's «In Ultra» opens it).
                Button("In Ultra: \(store.planFacts.speakWeeklyMinutes) min a week") {
                    if let url = URL(string: "contextflow://subscribe?plan=ultra&feature=listen") { openURL(url) }
                }
            }
            if let offer = store.yearlySwitch, Date().timeIntervalSince1970 > yearlyHiddenUntil {
                yearlyLine(offer)
            }
            // The plan's tour again (2.6): Pro's steps, or Ultra's with Pro's.
            if let tier = store.tier, tier != .byok {
                Button("What's in \(tier.name)") { PlanTour.shared.show(tier) }
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

    /// A monthly Pro or Ultra subscriber: what yearly saves, and the switch (it starts when the month ends).
    private func yearlyLine(_ offer: (tier: StoreKitManager.Tier, deal: StoreKitManager.YearlyDeal, product: Product)) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(offer.tier.name) yearly: you save \(offer.deal.saving) (\(offer.deal.percent)%) a year.")
                .fixedSize(horizontal: false, vertical: true)
            Text("Yearly starts when your current month ends.")
                .font(.footnote)
                .foregroundColor(.secondary)
            HStack {
                Button {
                    switching = true
                    Task {
                        if case .purchased? = try? await store.purchase(offer.product) {
                            restoreMessage = String(localized: "Yearly starts when your current month ends.")
                        }
                        switching = false
                    }
                } label: {
                    if switching { ProgressView() } else { Text("Switch to yearly") }
                }
                .buttonStyle(.borderedProminent)
                .tint(offer.tier == .ultra ? ultraViolet : brandBlue)
                .disabled(switching)
                .accessibilityIdentifier("settings.yearly")
                Spacer()
                Button("Hide") { yearlyHiddenUntil = Date().addingTimeInterval(60 * 86_400).timeIntervalSince1970 }
                    .buttonStyle(.borderless)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Plan tour

/// What a plan adds, step by step, after a purchase or an upgrade the app sees (2.6, build 89, the owner: "when a person
/// buys Pro or Ultra, take them through the features of that plan, the way the first run does"). Pro's steps, Ultra's,
/// or Ultra's then Pro's for someone coming from below Pro (Own key counts as below). Once per plan, and it can be
/// skipped; Settings shows it again ("What's in Ultra"). An app update shows nothing: the first plan the app sees is
/// only noted, and a restore isn't a purchase. Kept in the app's own defaults. The Safari panel has its own tour of the
/// same steps (src/content/Guide.tsx).
@MainActor
final class PlanTour: ObservableObject {
    static let shared = PlanTour()

    enum Step {
        case proMedia, proChats, proSort, proTemplates, proWatch, ultraListen, ultraSimilar, ultraWatch

        var isUltra: Bool { self == .ultraListen || self == .ultraSimilar || self == .ultraWatch }
    }

    struct Run: Identifiable {
        let id = UUID()
        /// The plan it shows (the caption, the color).
        let plan: StoreKitManager.Tier
        let steps: [Step]
    }

    static let pro: [Step] = [.proMedia, .proChats, .proSort, .proTemplates, .proWatch]
    static let ultra: [Step] = [.ultraListen, .ultraSimilar, .ultraWatch]
    /// From below Pro to Ultra: Ultra's steps, then Pro's, the watched pages (Ultra's number) last.
    static let ultraFull: [Step] = [.ultraListen, .ultraSimilar, .proMedia, .proChats, .proSort, .proTemplates, .ultraWatch]

    /// The tour on screen (nil: none). The step is kept here, so the tour comes back where it was after another sheet
    /// (Listen handed over from Safari) took its place for a while.
    @Published private(set) var run: Run?
    @Published var index = 0
    /// It took the place of "You're all set" after a purchase on the Pro tab: the rating is asked when it closes.
    private var reviewAfter = false

    private let defaults = UserDefaults.standard
    private static let lastPlanKey = "cf_plan_last_seen"
    private static let shownKey = "cf_plan_tours_shown"

    /// The plan StoreKit says is active now (StoreKitManager, after every refresh). A move up starts the tour of what's
    /// new to the person, unless they saw it before; `quietly` (a restore) only notes the plan.
    func planSeen(_ tier: StoreKitManager.Tier?, quietly: Bool) {
        let now = tier?.rawValue ?? "free"
        let last = defaults.string(forKey: Self.lastPlanKey)
        guard last != now else { return }
        defaults.set(now, forKey: Self.lastPlanKey)
        // The first plan seen (a new install, or the update that brought the tour): noted, nothing shown.
        guard let last, let tier, !quietly, tier.rank > Self.rank(last) else { return }
        var shown = Set(defaults.stringArray(forKey: Self.shownKey) ?? [])
        let proRank = StoreKitManager.Tier.pro.rank
        let newUltra = tier == .ultra && !shown.contains("ultra")
        let newPro = tier.rank >= proRank && Self.rank(last) < proRank && !shown.contains("pro")
        let steps = tier == .ultra ? Self.ultraFull.filter { $0.isUltra ? newUltra : newPro } : newPro ? Self.pro : []
        guard !steps.isEmpty else { return }
        if newUltra { shown.insert("ultra") }
        if newPro { shown.insert("pro") }
        defaults.set(Array(shown), forKey: Self.shownKey)
        start(Run(plan: tier, steps: steps))
    }

    /// "What's in Pro / Ultra" in Settings: Pro's steps, or Ultra's with Pro's.
    func show(_ tier: StoreKitManager.Tier) {
        switch tier {
        case .pro: start(Run(plan: .pro, steps: Self.pro))
        case .ultra: start(Run(plan: .ultra, steps: Self.ultraFull))
        case .byok: break
        }
    }

    /// After a purchase on the Pro tab: whether the tour is on now, in place of "You're all set".
    func takesOverPurchase() -> Bool {
        guard run != nil else { return false }
        reviewAfter = true
        return true
    }

    /// Ends the tour (Done, Skip, a tab opened from it, or swiped away). True when the rating is to be asked now.
    func close() -> Bool {
        guard run != nil else { return false }
        run = nil
        index = 0
        let review = reviewAfter
        reviewAfter = false
        return review
    }

    /// `-CFDebugPlanTour pro|ultra|full` in Debug builds: the tour at launch (screenshots, checks).
    func debugStartIfAsked() {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "CFDebugPlanTour") {
        case "pro": start(Run(plan: .pro, steps: Self.pro))
        case "ultra": start(Run(plan: .ultra, steps: Self.ultra))
        case "full": start(Run(plan: .ultra, steps: Self.ultraFull))
        default: break
        }
        #endif
    }

    /// Safari itself, not another default browser: the steps that live in its panel.
    static func openSafari() {
        #if os(iOS)
        // The same page as the home screen's "Open Safari" (2.7 (110)).
        FirstPage.open()
        #else
        guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") else { return }
        NSWorkspace.shared.openApplication(at: safari, configuration: NSWorkspace.OpenConfiguration())
        #endif
    }

    private func start(_ next: Run) {
        index = 0
        run = next
    }

    private static func rank(_ plan: String) -> Int { StoreKitManager.Tier(rawValue: plan)?.rank ?? 0 }
}

/// The plan tour's sheet: a step at a time, with its clip from Tips (or its icon), what it does, and a button to where
/// it lives when the app has a place for it. Skip, Next, and Done on the last step.
struct PlanTourView: View {
    @ObservedObject var tour: PlanTour
    let run: PlanTour.Run
    /// The Chats tab is there (the "Open Chats" button).
    let hasChats: Bool
    /// A tab of the app, from a step's button: the tour ends there.
    let open: (AppTab) -> Void
    let close: () -> Void
    @ObservedObject private var store = StoreKitManager.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var suggestionsOn = SharedDefaults.shared.readSettings()?.settings["organize"] as? Bool ?? false

    private static let ultraColor = Color(red: 0.49, green: 0.31, blue: 0.93)
    private var accent: Color { run.plan == .ultra ? Self.ultraColor : brandBlue }
    private var index: Int { min(tour.index, run.steps.count - 1) }
    private var last: Bool { index == run.steps.count - 1 }

    private var caption: String {
        "\(String(localized: "What's in \(run.plan.name)")) · \(String(localized: "\(index + 1) of \(run.steps.count)"))"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(verbatim: caption)
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(.secondary)
                Spacer(minLength: 12)
                if !last {
                    Button("Skip", action: close)
                        .foregroundColor(.secondary)
                        .keyboardShortcut(.cancelAction)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 8)
            ScrollView {
                stepView(run.steps[index])
                    .id(index)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
                    .padding(.horizontal, 24)
                    .padding(.vertical, 8)
            }
            VStack(spacing: 14) {
                Button(action: next) {
                    Text(last ? LocalizedStringKey("Done") : LocalizedStringKey("Next"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                dots
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: 520)
        #if os(macOS)
        .frame(width: 460, height: 600)
        #endif
        .tint(accent)
        .task { await store.refreshPlanFacts() }
    }

    private func next() {
        if last {
            close()
        } else {
            withAnimation(.easeInOut(duration: 0.3)) { tour.index = index + 1 }
        }
    }

    private var dots: some View {
        HStack(spacing: 7) {
            ForEach(run.steps.indices, id: \.self) { i in
                Circle()
                    .fill(i == index ? accent : Color.secondary.opacity(0.3))
                    .frame(width: 7, height: 7)
            }
        }
        .accessibilityHidden(true)
    }

    private struct Info {
        let symbol: String
        let color: Color
        let title: LocalizedStringKey
        let text: LocalizedStringKey
        var clip: String? = nil
    }

    // The texts of Tips where they say it (sorting, templates, watching); the app's names for the features.
    private func info(_ step: PlanTour.Step) -> Info {
        let facts = store.planFacts
        switch step {
        case .proMedia:
            return Info(symbol: "play.rectangle", color: .red, title: "Videos and PDFs on the page",
                        text: "ContextFlow now reads a video's transcript and the PDFs on a page. Ask as usual: answers point to the moment, like [4:15], or to the PDF's page.", clip: "video")
        case .proChats:
            return Info(symbol: "text.bubble", color: .indigo, title: "Search and ask your chats",
                        text: "In Chats, open the search, choose By meaning and describe the chat you remember. Ask your chats, at the top of the list, answers from all your chats at once.", clip: "history")
        case .proSort:
            return Info(symbol: "arrow.turn.down.right", color: brandBlue, title: "Sorted by topic",
                        text: "Under a new answer or note, ContextFlow suggests the chat it belongs in, or a new one, and one of your own tags. One tap, and it's there.", clip: "organize")
        case .proTemplates:
            return Info(symbol: "curlybraces", color: .orange, title: "Templates",
                        text: "Select a reply you send often and tap Template: ContextFlow marks the name, the date and whatever else changes. When you insert it, Fill from the page puts them in, highlighted so you can check.", clip: "fill")
        case .proWatch, .ultraWatch:
            return Info(symbol: "eye", color: .green, title: "Watch up to \(step == .ultraWatch ? facts.watchUltra : facts.watchPro) pages",
                        text: "In Safari, select a price, stock or a date and tap the eye. For the whole page: … → Watch this page.", clip: "watch")
        case .ultraListen:
            // Build 95: the tour shows it working, as Tips do (build 98: on iPhone and iPad too, as Tips).
            return Info(symbol: "speaker.wave.2.fill", color: Self.ultraColor, title: "Listen",
                        text: "Tap Listen under an answer, or choose Listen to this page in the … menu at the top of the panel. A natural voice reads it aloud.", clip: "listen")
        case .ultraSimilar:
            // Build 95: the tour shows it working, as Tips do (its clip is touch: iPhone and iPad only).
            #if os(iOS)
            let clip: String? = "similar"
            #else
            let clip: String? = nil
            #endif
            return Info(symbol: "square.on.square", color: Self.ultraColor, title: "Find similar",
                        text: "Tap Find similar in the panel, or select text on the page and tap Find similar. You get real alternatives — cheaper, newer, in stock or in your language. Every link is opened and checked before you see it.", clip: clip)
        }
    }

    private func stepView(_ step: PlanTour.Step) -> some View {
        let item = info(step)
        return VStack(spacing: 14) {
            if let name = item.clip, let url = TipClip.url(name) {
                TipClipView(url: url)
                    .aspectRatio(TipClip.aspect, contentMode: .fit)
                    .frame(maxWidth: TipClip.width, maxHeight: 330)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08)))
                    .accessibilityHidden(true)
                icon(item, size: 40)
            } else {
                icon(item, size: 84)
                    .padding(.vertical, 28)
            }
            Text(item.title)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(item.text)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            action(step)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }

    private func icon(_ item: Info, size: CGFloat) -> some View {
        Image(systemName: item.symbol)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous).fill(item.color))
            .accessibilityHidden(true)
    }

    /// Where the step's feature lives: Safari's panel, a tab of the app, or the switch it needs (sorting).
    @ViewBuilder
    private func action(_ step: PlanTour.Step) -> some View {
        switch step {
        case .proMedia, .proWatch, .ultraListen, .ultraSimilar, .ultraWatch:
            Button(action: PlanTour.openSafari) { Label("Open Safari", systemImage: "safari") }
                .buttonStyle(.bordered)
        case .proChats:
            if hasChats {
                Button { open(.chats) } label: { Label("Open Chats", systemImage: "bubble.left.and.bubble.right") }
                    .buttonStyle(.bordered)
            }
        case .proTemplates:
            Button { open(.templates) } label: { Label("Open Templates", systemImage: "text.badge.plus") }
                .buttonStyle(.bordered)
        case .proSort:
            if suggestionsOn {
                Label("Suggestions are on.", systemImage: "checkmark.circle.fill")
                    .font(.callout.weight(.medium))
                    .foregroundColor(.green)
            } else {
                // Turning them on is the consent: what goes where is said first, as on the What's new sheet.
                VStack(spacing: 10) {
                    Text("For this, the text of your messages goes to our server and to OpenAI and Anthropic. We don't keep it. OpenAI and Anthropic don't use it for training.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        OrganizeModel.shared.answerConsent(true, from: "plan_tour")
                        withAnimation { suggestionsOn = true }
                    } label: { Label("Turn on suggestions", systemImage: "arrow.turn.down.right") }
                        .buttonStyle(.bordered)
                }
            }
        }
    }
}
