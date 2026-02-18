import SwiftUI
import StoreKit
import Combine
#if os(macOS)
import SafariServices
#endif

// MARK: – Main App View

@available(macOS 12.0, iOS 15.0, *)
struct ContentView: View {
    @StateObject private var storeManager = StoreKitManager.shared

    enum Tab: String, CaseIterable {
        case subscription = "Subscription"
        case settings = "Settings"
        case setup = "Setup"
        case status = "Status"
    }

    @State private var selectedTab: Tab = .subscription

    var body: some View {
        #if os(macOS)
        NavigationView {
            sidebar
            tabContent
        }
        .frame(minWidth: 600, minHeight: 450)
        #else
        TabView(selection: $selectedTab) {
            SubscriptionTab(storeManager: storeManager)
                .tabItem {
                    Label("Subscription", systemImage: "crown")
                }
                .tag(Tab.subscription)

            SettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
                .tag(Tab.settings)

            SetupTab()
                .tabItem {
                    Label("Setup", systemImage: "safari")
                }
                .tag(Tab.setup)

            StatusTab()
                .tabItem {
                    Label("Status", systemImage: "info.circle")
                }
                .tag(Tab.status)
        }
        .tint(.purple)
        #endif
    }

    #if os(macOS)
    private var sidebar: some View {
        List(Tab.allCases, id: \.self, selection: $selectedTab) { tab in
            Label(tab.rawValue, systemImage: tabIcon(tab))
                .tag(tab)
        }
        .listStyle(.sidebar)
        .frame(minWidth: 160)
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .subscription:
            SubscriptionTab(storeManager: storeManager)
        case .settings:
            SettingsTab()
        case .setup:
            SetupTab()
        case .status:
            StatusTab()
        }
    }

    private func tabIcon(_ tab: Tab) -> String {
        switch tab {
        case .subscription: return "crown"
        case .settings: return "gearshape"
        case .setup: return "safari"
        case .status: return "info.circle"
        }
    }
    #endif
}

// MARK: – Subscription Tab

@available(macOS 12.0, iOS 15.0, *)
struct SubscriptionTab: View {
    @ObservedObject var storeManager: StoreKitManager
    @State private var isPurchasing = false
    @State private var isRestoring = false
    @State private var errorMessage: String?
    @State private var showSuccess = false

    // Reactive state — polled from SharedDefaults so we pick up changes
    // written by the Safari extension (which runs in a separate process).
    @State private var userEmail: String? = SharedDefaults.shared.userEmail
    @State private var trialUsageCount: Int = SharedDefaults.shared.trialUsageCount

    // Timer that re-reads SharedDefaults every 2 seconds
    private let refreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 44))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.purple, .indigo],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )

                    Text("ContextFlow")
                        .font(.largeTitle)
                        .fontWeight(.bold)

                    Text("AI-powered answers about any webpage")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 24)

                // Account info
                accountCard

                // Current status
                statusCard

                // Plans
                if !storeManager.currentStatus.isSubscribed {
                    plansSection
                }

                // Restore
                if !storeManager.currentStatus.isSubscribed {
                    Button(action: handleRestore) {
                        HStack(spacing: 6) {
                            if isRestoring {
                                ProgressView()
                                    .scaleEffect(0.7)
                            }
                            Text("Restore Purchases")
                                .font(.subheadline)
                        }
                    }
                    .disabled(isRestoring)
                    .foregroundColor(.purple)
                }

                // Error
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                        .padding(.horizontal)
                }

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
        }
        .background(backgroundStyle)
        .overlay {
            if showSuccess {
                successOverlay
            }
        }
        .onAppear {
            userEmail = SharedDefaults.shared.userEmail
            trialUsageCount = SharedDefaults.shared.trialUsageCount
        }
        .onReceive(refreshTimer) { _ in
            let newEmail = SharedDefaults.shared.userEmail
            let newCount = SharedDefaults.shared.trialUsageCount
            if newEmail != userEmail { userEmail = newEmail }
            if newCount != trialUsageCount { trialUsageCount = newCount }
        }
    }

    // MARK: – Account Card

    private var accountCard: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: userEmail != nil ? "person.crop.circle.fill" : "person.crop.circle")
                    .font(.title2)
                    .foregroundColor(userEmail != nil ? .purple : .gray)

                VStack(alignment: .leading, spacing: 2) {
                    if let userEmail {
                        Text(userEmail)
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text("Signed in via Safari extension")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    } else {
                        Text("Not signed in")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Text("Sign in through the Safari extension")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()
            }
        }
        .padding(16)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }

    // MARK: – Status Card

    private var statusCard: some View {
        VStack(spacing: 12) {
            if storeManager.currentStatus.isSubscribed {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.title2)
                        .foregroundColor(.green)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Active Subscription")
                            .font(.headline)
                            .foregroundColor(.primary)

                        Text(planLabel(for: storeManager.currentStatus.productId))
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }

                    Spacer()
                }

                if let expDate = storeManager.currentStatus.expirationDate {
                    HStack {
                        Text("Renews:")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(expDate, style: .date)
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                }

                if storeManager.currentStatus.isInGracePeriod {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(.orange)
                        Text("Payment issue — please update your payment method")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                }

                Button("Manage Subscription") {
                    #if os(iOS)
                    if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
                        UIApplication.shared.open(url)
                    }
                    #else
                    if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
                        NSWorkspace.shared.open(url)
                    }
                    #endif
                }
                .font(.subheadline)
                .foregroundColor(.purple)
            } else {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles")
                        .font(.title2)
                        .foregroundColor(.blue)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Free Trial")
                            .font(.headline)
                        Text("\(max(0, 5 - trialUsageCount)) of 5 requests remaining")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }

                    Spacer()
                }

                // Usage bar
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.blue.opacity(0.15))
                            .frame(height: 6)

                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.blue)
                            .frame(
                                width: geo.size.width * CGFloat(min(trialUsageCount, 5)) / 5.0,
                                height: 6
                            )
                    }
                }
                .frame(height: 6)
            }
        }
        .padding(20)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
    }

    // MARK: – Plans

    private var plansSection: some View {
        VStack(spacing: 12) {
            Text("Choose a Plan")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(storeManager.products.sorted(by: { $0.price < $1.price }), id: \.id) { product in
                planCard(product)
            }

            if storeManager.products.isEmpty && storeManager.isLoading {
                ProgressView("Loading plans...")
                    .padding()
            } else if storeManager.products.isEmpty {
                Text("Unable to load plans. Check your connection and try again.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding()

                Button("Retry") {
                    Task { await storeManager.loadProducts() }
                }
                .foregroundColor(.purple)
            }
        }
    }

    private func planCard(_ product: Product) -> some View {
        let isBYOK = product.id.contains("byok")
        let isPro = product.id.contains("pro")

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: isBYOK ? "key" : "crown.fill")
                    .font(.title3)
                    .foregroundColor(isPro ? .purple : .blue)

                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(.headline)
                    Text(product.description)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                VStack(alignment: .trailing) {
                    Text(product.displayPrice)
                        .font(.title3)
                        .fontWeight(.bold)
                        .foregroundColor(.purple)
                    Text("/month")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }

            // Features
            VStack(alignment: .leading, spacing: 4) {
                if isBYOK {
                    featureRow("Unlimited interface access")
                    featureRow("Bring your own OpenAI key")
                    featureRow("Full control over costs")
                } else {
                    featureRow("Everything in BYOK")
                    featureRow("No API key needed")
                    featureRow("We handle everything")
                }
            }

            Button(action: { handlePurchase(product) }) {
                HStack {
                    if isPurchasing {
                        ProgressView()
                            .scaleEffect(0.8)
                    }
                    Text("Subscribe — \(product.displayPrice)/mo")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(isPro ? .purple : .blue)
            .disabled(isPurchasing)
        }
        .padding(16)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isPro ? Color.purple.opacity(0.3) : Color.clear, lineWidth: 2)
        )
    }

    private func featureRow(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark")
                .font(.caption2)
                .fontWeight(.bold)
                .foregroundColor(.green)
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    // MARK: – Actions

    private func handlePurchase(_ product: Product) {
        isPurchasing = true
        errorMessage = nil

        Task {
            do {
                let (_, jws) = try await storeManager.purchase(product)
                // Verify on server (fire-and-forget)
                await verifyOnServer(jws: jws)
                showSuccess = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    showSuccess = false
                }
            } catch let error as StoreKitError where error == .userCancelled {
                // User cancelled — no error message
            } catch {
                errorMessage = error.localizedDescription
            }
            isPurchasing = false
        }
    }

    private func handleRestore() {
        isRestoring = true
        errorMessage = nil

        Task {
            await storeManager.restorePurchases()
            if !storeManager.currentStatus.isSubscribed {
                errorMessage = "No active subscription found."
            }
            isRestoring = false
        }
    }

    /// Send JWS to backend for verification.
    private func verifyOnServer(jws: String) async {
        guard let url = URL(string: "https://aisidebar.netlify.app/.netlify/functions/appstore-verify") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["jwsTransaction": jws])

        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: – Helpers

    private func planLabel(for productId: String?) -> String {
        guard let id = productId else { return "Unknown" }
        if id.contains("byok") { return "BYOK Monthly" }
        if id.contains("pro") { return "Pro Monthly" }
        return id
    }

    private var successOverlay: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 60))
                .foregroundColor(.green)

            Text("Subscription Active!")
                .font(.title2)
                .fontWeight(.bold)

            Text("Your subscription is now active. The extension will automatically pick up your new status.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.ultraThinMaterial)
        .transition(.opacity)
    }

    @ViewBuilder
    private var backgroundStyle: some View {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

// MARK: – Settings Tab

@available(macOS 12.0, iOS 15.0, *)
struct SettingsTab: View {
    @State private var fontSize: Double = Double(SharedDefaults.shared.fontSize)
    @State private var selectedTheme: String = SharedDefaults.shared.theme
    @State private var apiKey: String = SharedDefaults.shared.apiKey ?? ""
    @State private var showApiKey = false
    @State private var keySaved = false

    let themes = ["system", "light", "dark"]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 44))
                        .foregroundColor(.purple)

                    Text("Settings")
                        .font(.largeTitle)
                        .fontWeight(.bold)

                    Text("These settings sync with the Safari extension")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 24)

                // API Key (BYOK)
                apiKeySection

                // Font size
                VStack(alignment: .leading, spacing: 12) {
                    Label("Font Size", systemImage: "textformat.size")
                        .font(.headline)

                    HStack {
                        Text("A")
                            .font(.caption)
                        Slider(value: $fontSize, in: 10...24, step: 1) { editing in
                            if !editing {
                                SharedDefaults.shared.fontSize = Int(fontSize)
                            }
                        }
                        Text("A")
                            .font(.title2)
                    }

                    Text("Current: \(Int(fontSize))px")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    // Preview
                    Text("The quick brown fox jumps over the lazy dog.")
                        .font(.system(size: CGFloat(fontSize)))
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.purple.opacity(0.05))
                        .cornerRadius(8)
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)

                // Theme
                VStack(alignment: .leading, spacing: 12) {
                    Label("Theme", systemImage: "paintbrush")
                        .font(.headline)

                    Picker("Theme", selection: $selectedTheme) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: selectedTheme) { newValue in
                        SharedDefaults.shared.theme = newValue
                    }
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
        }
        .background(backgroundStyle)
    }

    // MARK: – API Key Section

    private var apiKeySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("OpenAI API Key", systemImage: "key")
                .font(.headline)

            Text("Required for BYOK plan. Your key is stored locally and shared with the extension.")
                .font(.caption)
                .foregroundColor(.secondary)

            HStack {
                if showApiKey {
                    TextField("sk-...", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        #if os(iOS)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        #endif
                } else {
                    SecureField("sk-...", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                }

                Button(action: { showApiKey.toggle() }) {
                    Image(systemName: showApiKey ? "eye.slash" : "eye")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }

            HStack {
                Button(keySaved ? "Saved ✓" : "Save Key") {
                    SharedDefaults.shared.apiKey = apiKey.isEmpty ? nil : apiKey
                    keySaved = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        keySaved = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(keySaved ? .green : .blue)
                .disabled(apiKey.isEmpty)

                if !apiKey.isEmpty || SharedDefaults.shared.apiKey != nil {
                    Button("Clear") {
                        apiKey = ""
                        SharedDefaults.shared.apiKey = nil
                        keySaved = false
                    }
                    .foregroundColor(.red)
                }
            }

            if keySaved {
                Text("Key saved and shared with extension")
                    .font(.caption)
                    .foregroundColor(.green)
            }
        }
        .padding(20)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }

    @ViewBuilder
    private var backgroundStyle: some View {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

// MARK: – Setup Tab

@available(macOS 12.0, iOS 15.0, *)
struct SetupTab: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "safari")
                        .font(.system(size: 44))
                        .foregroundColor(.purple)

                    Text("Enable Extension")
                        .font(.largeTitle)
                        .fontWeight(.bold)

                    Text("Follow these steps to enable ContextFlow in Safari")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 24)

                // Steps
                VStack(alignment: .leading, spacing: 16) {
                    #if os(iOS)
                    setupStep(number: 1, text: "Open **Safari**")
                    setupStep(number: 2, text: "Tap the **extensions icon** (puzzle piece) near the address bar")
                    setupStep(number: 3, text: "You'll see a **\"1\" badge** next to Manage Extensions")
                    setupStep(number: 4, text: "Tap **Manage Extensions** and enable **ContextFlow**")
                    #else
                    setupStep(number: 1, text: "Open **Safari → Settings → Extensions**")
                    setupStep(number: 2, text: "Find **ContextFlow** in the list and check the box")
                    setupStep(number: 3, text: "Click **\"Always Allow on Every Website\"** when prompted")
                    #endif
                    setupStep(number: 4, text: "Sign in or create an account in the extension")
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3)

                // Why all websites
                VStack(spacing: 8) {
                    Label("Why \"All Websites\"?", systemImage: "shield.checkered")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.purple)

                    Text("ContextFlow needs access to read page content so it can answer your questions. Your data is processed securely and never stored on our servers.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(16)
                .background(Color.purple.opacity(0.06))
                .cornerRadius(12)

                // Open Safari button
                #if os(iOS)
                Button(action: {
                    if let url = URL(string: "https://www.apple.com") {
                        UIApplication.shared.open(url)
                    }
                }) {
                    Label("Open Safari", systemImage: "safari")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
                #else
                Button(action: {
                    SFSafariApplication.showPreferencesForExtension(
                        withIdentifier: Bundle.main.bundleIdentifier.map {
                            $0 + ".Extension"
                        } ?? ""
                    )
                }) {
                    Label("Open Safari Extension Settings", systemImage: "gear")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
                #endif

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
        }
        .background(backgroundStyle)
    }

    private func setupStep(number: Int, text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.caption)
                .fontWeight(.bold)
                .foregroundColor(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Color.purple))

            Text(text)
                .font(.subheadline)
                .foregroundColor(.primary)
        }
    }

    @ViewBuilder
    private var backgroundStyle: some View {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

// MARK: – Status Tab (Debug / Connection Health)

@available(macOS 12.0, iOS 15.0, *)
struct StatusTab: View {
    @State private var debugInfo: [String: Any] = [:]
    @State private var isRefreshing = false

    // Reactive state — polled from SharedDefaults
    @State private var hasEmail: Bool = SharedDefaults.shared.userEmail != nil
    @State private var hasApiKey: Bool = SharedDefaults.shared.apiKey != nil
    @State private var isSubscribed: Bool = SharedDefaults.shared.readSubscriptionStatus()["isSubscribed"] as? Bool ?? false

    private let refreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 44))
                        .foregroundColor(.purple)

                    Text("Status")
                        .font(.largeTitle)
                        .fontWeight(.bold)

                    Text("Shared storage debug info")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 24)

                // App Group status
                VStack(alignment: .leading, spacing: 12) {
                    Label("App Group Storage", systemImage: "externaldrive.connected.to.line.below")
                        .font(.headline)

                    if debugInfo.isEmpty {
                        Text("Tap Refresh to load")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(debugInfo.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            HStack {
                                Text(key)
                                    .font(.caption)
                                    .fontWeight(.medium)
                                    .foregroundColor(.primary)
                                Spacer()
                                Text("\(String(describing: value))")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }

                    Button(action: refreshDebugInfo) {
                        HStack(spacing: 6) {
                            if isRefreshing {
                                ProgressView()
                                    .scaleEffect(0.7)
                            }
                            Text("Refresh")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isRefreshing)
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)

                // Native Bridge diagnostic
                nativeBridgeCard

                // Connection checklist
                checklistCard

                // How it works
                VStack(alignment: .leading, spacing: 8) {
                    Label("How it works", systemImage: "questionmark.circle")
                        .font(.headline)

                    Text("1. You subscribe in this app (StoreKit)")
                        .font(.caption)
                    Text("2. Status is written to App Group shared storage")
                        .font(.caption)
                    Text("3. Safari extension reads status via native messaging")
                        .font(.caption)
                    Text("4. Extension unlocks premium features")
                        .font(.caption)

                    Text("\nIf the extension doesn't see your subscription, make sure App Groups are enabled for ALL 4 targets in Xcode (both App + Extension, iOS + macOS).")
                        .font(.caption)
                        .foregroundColor(.orange)
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
        }
        .background(backgroundStyle)
        .onAppear {
            refreshDebugInfo()
            refreshChecklist()
        }
        .onReceive(refreshTimer) { _ in
            refreshChecklist()
            debugInfo = SharedDefaults.shared.debugDump()
        }
    }

    private var nativeBridgeCard: some View {
        let bridgeCalled = SharedDefaults.shared.debugLastNativeTimestamp > 0

        return VStack(alignment: .leading, spacing: 12) {
            Label("Native Bridge", systemImage: "arrow.left.arrow.right")
                .font(.headline)

            checkItem("Bridge ever called", ok: bridgeCalled)

            if bridgeCalled {
                HStack {
                    Text("Last command:")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(SharedDefaults.shared.debugLastNativeCommand ?? "—")
                        .font(.caption.monospaced())
                }
                HStack {
                    Text("Last called:")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(formattedTimestamp(SharedDefaults.shared.debugLastNativeTimestamp))
                        .font(.caption.monospaced())
                }
            } else {
                Text("The extension has never called the native bridge.\nOpen the extension in Safari and interact with it,\nthen come back here and tap Refresh.")
                    .font(.caption)
                    .foregroundColor(.orange)
            }
        }
        .padding(20)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }

    private var checklistCard: some View {
        let appGroupOK = UserDefaults(suiteName: SharedDefaults.suiteName) != nil

        return VStack(alignment: .leading, spacing: 12) {
            Label("Checklist", systemImage: "checklist")
                .font(.headline)

            checkItem("App Group configured", ok: appGroupOK)
            checkItem("Subscription active", ok: isSubscribed)
            checkItem("User email synced", ok: hasEmail)
            checkItem("API key set", ok: hasApiKey)
        }
        .padding(20)
        #if os(iOS)
        .background(Color(.systemBackground))
        #else
        .background(Color(nsColor: .controlBackgroundColor))
        #endif
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }

    private func formattedTimestamp(_ ts: Double) -> String {
        guard ts > 0 else { return "—" }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return fmt.string(from: Date(timeIntervalSince1970: ts))
    }

    private func refreshChecklist() {
        let newHasEmail = SharedDefaults.shared.userEmail != nil
        let newHasApiKey = SharedDefaults.shared.apiKey != nil
        let newIsSubscribed = SharedDefaults.shared.readSubscriptionStatus()["isSubscribed"] as? Bool ?? false
        if newHasEmail != hasEmail { hasEmail = newHasEmail }
        if newHasApiKey != hasApiKey { hasApiKey = newHasApiKey }
        if newIsSubscribed != isSubscribed { isSubscribed = newIsSubscribed }
    }

    private func refreshDebugInfo() {
        isRefreshing = true
        debugInfo = SharedDefaults.shared.debugDump()
        isRefreshing = false
    }

    private func checkItem(_ label: String, ok: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundColor(ok ? .green : .red)
            Text(label)
                .font(.subheadline)
            Spacer()
            Text(ok ? "OK" : "Missing")
                .font(.caption)
                .foregroundColor(ok ? .green : .red)
        }
    }

    @ViewBuilder
    private var backgroundStyle: some View {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}
