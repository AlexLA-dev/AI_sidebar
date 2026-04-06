import SwiftUI
import StoreKit
import Combine
#if os(macOS)
import SafariServices
#endif

// MARK: – Shared Helpers

/// "Open Safari" / "Open Extension Settings" button used across tabs
struct OpenSafariButton: View {
    var body: some View {
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
    }
}

// MARK: – Main App View

@available(macOS 12.0, iOS 15.0, *)
struct ContentView: View {
    @StateObject private var storeManager = StoreKitManager.shared

    enum Tab: String, CaseIterable {
        case subscription = "Subscription"
        case settings = "Settings"
        case setup = "Setup"
    }

    @State private var selectedTab: Tab = .subscription

    /// Product ID hint from URL scheme (e.g. contextflow://subscribe?plan=byok)
    @State private var suggestedProductId: String?

    var body: some View {
        #if os(macOS)
        NavigationView {
            sidebar
            tabContent
        }
        .frame(minWidth: 600, minHeight: 450)
        .onOpenURL { url in handleDeepLink(url) }
        #else
        TabView(selection: $selectedTab) {
            SubscriptionTab(storeManager: storeManager, suggestedProductId: $suggestedProductId)
                .tabItem {
                    Label("Subscription", systemImage: "crown")
                }
                .tag(Tab.subscription)

            SetupTab()
                .tabItem {
                    Label("Setup", systemImage: "safari")
                }
                .tag(Tab.setup)

            SettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
                .tag(Tab.settings)
        }
        .tint(.purple)
        .onOpenURL { url in handleDeepLink(url) }
        .onReceive(NotificationCenter.default.publisher(for: .contextFlowOpenURL)) { notification in
            if let url = notification.object as? URL {
                handleDeepLink(url)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            checkPendingSubscribe()
        }
        .onAppear {
            checkPendingSubscribe()
        }
        #endif
    }

    /// Check SharedDefaults for a pending subscription request from the extension.
    /// This is a reliable fallback when .onOpenURL doesn't fire.
    private func checkPendingSubscribe() {
        guard let plan = SharedDefaults.shared.pendingSubscribePlan, !plan.isEmpty else { return }
        // Clear immediately to avoid re-processing
        SharedDefaults.shared.pendingSubscribePlan = nil

        selectedTab = .subscription

        switch plan {
        case "byok": suggestedProductId = "com.contextflow.byok.monthly"
        case "pro":  suggestedProductId = "com.contextflow.pro.monthly"
        default: break
        }
    }

    /// Parse deep link: contextflow://subscribe?plan=byok or contextflow://subscribe?plan=pro
    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "contextflow" else { return }

        // Always switch to subscription tab when the app is opened via deep link
        selectedTab = .subscription

        if url.host == "subscribe",
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let planParam = components.queryItems?.first(where: { $0.name == "plan" })?.value {
            switch planParam {
            case "byok": suggestedProductId = "com.contextflow.byok.monthly"
            case "pro": suggestedProductId = "com.contextflow.pro.monthly"
            default: break
            }
        }
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
            SubscriptionTab(storeManager: storeManager, suggestedProductId: $suggestedProductId)
        case .settings:
            SettingsTab()
        case .setup:
            SetupTab()
        }
    }

    private func tabIcon(_ tab: Tab) -> String {
        switch tab {
        case .subscription: return "crown"
        case .settings: return "gearshape"
        case .setup: return "safari"
        }
    }
    #endif
}

// MARK: – Subscription Tab

@available(macOS 12.0, iOS 15.0, *)
struct SubscriptionTab: View {
    @ObservedObject var storeManager: StoreKitManager
    @Binding var suggestedProductId: String?
    @State private var isPurchasing = false
    @State private var isRestoring = false
    @State private var errorMessage: String?
    @State private var showSuccess = false

    // Reactive state — polled from SharedDefaults so we pick up changes
    // written by the Safari extension (which runs in a separate process).
    @State private var userEmail: String? = SharedDefaults.shared.userEmail
    @State private var trialUsageCount: Int = SharedDefaults.shared.trialUsageCount

    // Auth form state
    @State private var showSignInForm = false
    @State private var authMode: AuthMode = .signIn
    @State private var signInEmail = ""
    @State private var signInPassword = ""
    @State private var signInError: String?
    @State private var signInSuccess: String?
    @State private var isSigningIn = false

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

                // Plans (always shown — for upgrade/downgrade when subscribed)
                plansSection

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

                OpenSafariButton()

                // Legal links (required by App Store 3.1.2)
                legalLinks

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
            // Refresh subscription status on appear — catches pending purchases that resolved
            Task { await storeManager.refreshSubscriptionStatus() }
            // Refresh auth token if expired
            Task { await refreshAuthTokenIfNeeded() }
        }
        .onReceive(refreshTimer) { _ in
            let newEmail = SharedDefaults.shared.userEmail
            let newCount = SharedDefaults.shared.trialUsageCount
            if newEmail != userEmail { userEmail = newEmail }
            if newCount != trialUsageCount { trialUsageCount = newCount }
        }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            // Refresh status when returning from Settings or App Store (e.g. Sandbox approval)
            Task { await storeManager.refreshSubscriptionStatus() }
        }
        #endif
        .onChange(of: suggestedProductId) { productId in
            guard let productId, !isPurchasing else { return }
            // Auto-trigger purchase when deep link sets a suggested product
            if let product = storeManager.products.first(where: { $0.id == productId }) {
                handlePurchase(product)
                suggestedProductId = nil
            } else {
                // Products may not be loaded yet — wait and retry
                Task {
                    await storeManager.loadProducts()
                    if let product = storeManager.products.first(where: { $0.id == productId }) {
                        handlePurchase(product)
                    }
                    suggestedProductId = nil
                }
            }
        }
    }

    // MARK: – Account Card

    private var accountCard: some View {
        VStack(spacing: 8) {
            if let email = userEmail {
                // Signed-in state
                HStack(spacing: 10) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.title2)
                        .foregroundColor(.purple)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(email)
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text("Signed in")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Button(action: handleLogout) {
                        HStack(spacing: 4) {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.caption)
                            Text("Logout")
                                .font(.caption)
                        }
                        .foregroundColor(.red)
                    }
                    .buttonStyle(.plain)
                }
            } else if showSignInForm {
                // Inline sign-in form
                signInFormView
            } else {
                // Not signed in — prompt
                HStack(spacing: 10) {
                    Image(systemName: "person.crop.circle")
                        .font(.title2)
                        .foregroundColor(.gray)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Not signed in")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Text("Sign in to sync across devices")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Button(action: { showSignInForm = true }) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.right.circle")
                                .font(.caption)
                            Text("Sign In")
                                .font(.caption)
                        }
                        .foregroundColor(.purple)
                    }
                    .buttonStyle(.plain)
                }
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

    // MARK: – Sign-In Form

    private var signInFormView: some View {
        VStack(spacing: 12) {
            // Header with close button
            HStack {
                Text(authMode == .signIn ? "Sign In" : "Create Account")
                    .font(.headline)
                Spacer()
                Button(action: {
                    showSignInForm = false
                    signInError = nil
                    signInSuccess = nil
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }

            // Toggle sign-in / sign-up
            Picker("", selection: $authMode) {
                Text("Sign In").tag(AuthMode.signIn)
                Text("Sign Up").tag(AuthMode.signUp)
            }
            .pickerStyle(.segmented)
            .onChange(of: authMode) { _ in
                signInError = nil
                signInSuccess = nil
            }

            // Email
            TextField("Email", text: $signInEmail)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textContentType(.emailAddress)
                .autocapitalization(.none)
                .keyboardType(.emailAddress)
                #endif

            // Password
            SecureField(authMode == .signUp ? "Password (min 6 chars)" : "Password", text: $signInPassword)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textContentType(authMode == .signIn ? .password : .newPassword)
                #endif

            // Success message
            if let success = signInSuccess {
                Text(success)
                    .font(.caption)
                    .foregroundColor(.green)
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            // Error message
            if let error = signInError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            // Submit button
            Button(action: handleAuth) {
                HStack(spacing: 6) {
                    if isSigningIn {
                        ProgressView()
                            .scaleEffect(0.8)
                    }
                    Text(authMode == .signIn ? "Sign In" : "Create Account")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.purple)
            .disabled(isSigningIn || signInEmail.isEmpty || signInPassword.isEmpty)

            // Forgot password (sign-in mode only)
            if authMode == .signIn {
                Button(action: handleForgotPassword) {
                    Text("Forgot password?")
                        .font(.caption)
                        .foregroundColor(.purple)
                }
                .buttonStyle(.plain)
                .disabled(isSigningIn)
            }
        }
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
        let isSuggested = suggestedProductId == product.id

        // Determine if this is the user's current plan
        let currentProductId = storeManager.currentStatus.productId ?? ""
        let pendingProductId = storeManager.currentStatus.pendingProductId ?? ""
        let isCurrentPlan = storeManager.currentStatus.isSubscribed &&
            ((isBYOK && currentProductId.contains("byok")) ||
             (isPro && currentProductId.contains("pro")))
        let isSubscribed = storeManager.currentStatus.isSubscribed
        // Check if this plan is the pending switch target
        let isPendingSwitch = isSubscribed && !isCurrentPlan &&
            ((isBYOK && pendingProductId.contains("byok")) ||
             (isPro && pendingProductId.contains("pro")))

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: isBYOK ? "key" : "crown.fill")
                    .font(.title3)
                    .foregroundColor(isPro ? .purple : .orange)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(product.displayName)
                            .font(.headline)
                        if isCurrentPlan {
                            Text("Current")
                                .font(.caption2)
                                .fontWeight(.semibold)
                                .foregroundColor(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color.green)
                                .cornerRadius(6)
                        }
                    }
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

            if isCurrentPlan && !pendingProductId.isEmpty {
                VStack(spacing: 4) {
                    Text("Active until end of period")
                        .font(.subheadline)
                        .foregroundColor(.orange)
                    Text("Then switches to \(pendingProductId.contains("byok") ? "BYOK" : "Pro")")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            } else if isCurrentPlan {
                Text("Active subscription")
                    .font(.subheadline)
                    .foregroundColor(.green)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else if isPendingSwitch {
                Text("Switching at next renewal")
                    .font(.subheadline)
                    .foregroundColor(.blue)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else if isSubscribed {
                Button(action: { handlePurchase(product) }) {
                    HStack {
                        if isPurchasing {
                            ProgressView()
                                .scaleEffect(0.8)
                        }
                        Text(isPro ? "Upgrade to Pro" : "Switch to BYOK")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(isPro ? .purple : .orange)
                .disabled(isPurchasing)
            } else {
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
                .stroke(isSuggested ? Color.purple : (isPro ? Color.purple.opacity(0.3) : Color.clear), lineWidth: isSuggested ? 3 : 2)
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
                // Pass Supabase user ID as appAccountToken so Apple embeds it in the JWS
                let userIdUUID: UUID? = SharedDefaults.shared.userId.flatMap { UUID(uuidString: $0) }
                let (_, jws) = try await storeManager.purchase(product, appAccountToken: userIdUUID)
                // Verify on server (fire-and-forget)
                await verifyOnServer(jws: jws)
                showSuccess = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    showSuccess = false
                }
                // Request App Store review after successful purchase (3s delay for best UX)
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    requestAppReview()
                }
            } catch let error as StoreKitError where error == .userCancelled {
                // User cancelled — no error message
            } catch let error as StoreKitError where error == .purchasePending {
                // Sandbox and Ask to Buy — purchase needs external approval
                errorMessage = "Purchase is pending approval. Complete it in Settings → App Store, then return here."
                // Refresh status when approved (the transaction listener will pick it up)
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

    private func handleLogout() {
        // Signal the extension to sign out from Supabase
        SharedDefaults.shared.pendingLogout = true
        SharedDefaults.shared.clearAuthSession()
        SharedDefaults.shared.userEmail = nil
        SharedDefaults.shared.apiKey = nil
        SharedDefaults.shared.trialUsageCount = 0
        SharedDefaults.shared.clearSubscription()
        userEmail = nil
        trialUsageCount = 0
    }

    // MARK: – Auth Actions

    private func handleAuth() {
        guard !signInEmail.isEmpty, !signInPassword.isEmpty else { return }
        if authMode == .signUp && signInPassword.count < 6 {
            signInError = "Password must be at least 6 characters"
            return
        }

        isSigningIn = true
        signInError = nil
        signInSuccess = nil

        Task {
            do {
                let response: SupabaseAuth.AuthResponse
                if authMode == .signUp {
                    response = try await SupabaseAuth.signUp(email: signInEmail.trimmingCharacters(in: .whitespaces), password: signInPassword)
                } else {
                    response = try await SupabaseAuth.signIn(email: signInEmail.trimmingCharacters(in: .whitespaces), password: signInPassword)
                }

                // Store session in SharedDefaults for extension to pick up
                SharedDefaults.shared.writeAuthSession(
                    accessToken: response.accessToken,
                    refreshToken: response.refreshToken,
                    expiresAt: response.expiresAt,
                    userId: response.userId,
                    email: response.email
                )

                // Update local UI state
                userEmail = response.email
                showSignInForm = false
                signInEmail = ""
                signInPassword = ""
            } catch {
                let msg = error.localizedDescription
                if msg.contains("Invalid login credentials") {
                    signInError = "Wrong email or password"
                } else if msg.contains("User already registered") {
                    signInError = "Account already exists. Try signing in."
                    authMode = .signIn
                } else if msg.contains("Email not confirmed") {
                    signInError = "Please check your email and confirm your account first."
                } else if msg.contains("Signups not allowed") || msg.contains("signup_disabled") {
                    signInError = "Sign-up is currently disabled. Please sign in with an existing account."
                } else {
                    signInError = msg
                }
            }
            isSigningIn = false
        }
    }

    private func handleForgotPassword() {
        guard !signInEmail.trimmingCharacters(in: .whitespaces).isEmpty else {
            signInError = "Enter your email first"
            return
        }

        isSigningIn = true
        signInError = nil
        signInSuccess = nil

        Task {
            do {
                try await SupabaseAuth.resetPassword(email: signInEmail.trimmingCharacters(in: .whitespaces))
                signInSuccess = "Password reset link sent! Check your email."
            } catch {
                signInError = error.localizedDescription
            }
            isSigningIn = false
        }
    }

    /// Refresh the Supabase access token if it is expired or about to expire.
    private func refreshAuthTokenIfNeeded() async {
        guard let session = SharedDefaults.shared.readAuthSession(),
              let refreshToken = session["refresh_token"] as? String,
              !refreshToken.isEmpty else { return }

        let expiresAt = session["expires_at"] as? Double ?? 0
        // Refresh if expires within 5 minutes
        guard Date().timeIntervalSince1970 > expiresAt - 300 else { return }

        do {
            let response = try await SupabaseAuth.refreshToken(refreshToken)
            SharedDefaults.shared.writeAuthSession(
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                expiresAt: response.expiresAt,
                userId: response.userId,
                email: response.email
            )
            if userEmail == nil, !response.email.isEmpty {
                userEmail = response.email
            }
        } catch {
            // Token may be fully expired — user needs to sign in again
            print("[ContextFlow] Token refresh failed: \(error.localizedDescription)")
        }
    }

    /// Send JWS to backend for verification.
    /// Includes the Supabase user ID so the server can link the purchase
    /// to the correct user even without an auth token.
    private func verifyOnServer(jws: String) async {
        guard let url = URL(string: "https://aisidebar.netlify.app/.netlify/functions/appstore-verify") else { return }

        guard let userId = SharedDefaults.shared.userId, !userId.isEmpty else {
            // No Supabase user ID — server will reject (401).
            // The subscription is still active locally via SharedDefaults.
            // It will be synced to the server when the user signs in through the extension.
            print("[ContextFlow] Skipping server verification — no userId. Subscription is active locally.")
            return
        }

        var body: [String: Any] = ["jwsTransaction": jws, "userId": userId]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
                let body = String(data: data, encoding: .utf8) ?? "no body"
                print("[ContextFlow] Server verification failed (\(httpResponse.statusCode)): \(body)")
            }
        } catch {
            print("[ContextFlow] Server verification network error: \(error.localizedDescription)")
        }
    }

    // MARK: – Legal Links

    private var legalLinks: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                Link("Terms of Use (EULA)", destination: URL(string: "https://aisidebar.netlify.app/terms")!)
                Text("·")
                    .foregroundColor(.secondary)
                Link("Privacy Policy", destination: URL(string: "https://aisidebar.netlify.app/privacy")!)
            }
            .font(.caption2)
            .foregroundColor(.purple)

            Text("Subscriptions auto-renew monthly unless cancelled at least 24 hours before the end of the current period. Manage in Settings > Subscriptions.")
                .font(.caption2)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
        }
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

    /// Request an App Store review at a moment of value.
    /// Apple allows up to 3 prompts per year per user; the system
    /// silently ignores extras.
    private func requestAppReview() {
        #if os(iOS)
        if let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene {
            SKStoreReviewController.requestReview(in: scene)
        }
        #elseif os(macOS)
        SKStoreReviewController.requestReview()
        #endif
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

    let themes = ["system", "light", "dark"]

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                VStack(spacing: 6) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 36))
                        .foregroundColor(.purple)

                    Text("Settings")
                        .font(.title)
                        .fontWeight(.bold)

                    Text("Appearance settings sync with the Safari extension")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 16)

                // Font size
                VStack(alignment: .leading, spacing: 8) {
                    Label("Font Size", systemImage: "textformat.size")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    HStack {
                        Text("A")
                            .font(.caption)
                        Slider(value: $fontSize, in: 10...24, step: 1) { editing in
                            if !editing {
                                SharedDefaults.shared.fontSize = Int(fontSize)
                            }
                        }
                        Text("A")
                            .font(.title3)
                    }

                    Text("Current: \(Int(fontSize))px")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(14)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.04), radius: 4, y: 2)

                // Theme
                VStack(alignment: .leading, spacing: 8) {
                    Label("Theme", systemImage: "paintbrush")
                        .font(.subheadline)
                        .fontWeight(.semibold)

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
                .padding(14)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.04), radius: 4, y: 2)

                OpenSafariButton()

                Spacer(minLength: 16)
            }
            .padding(.horizontal, 20)
        }
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
        #endif
        .background(backgroundStyle)
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
    // Reactive state for onboarding checklist
    @State private var hasEmail: Bool = SharedDefaults.shared.userEmail != nil
    @State private var isSubscribed: Bool = SharedDefaults.shared.readSubscriptionStatus()["isSubscribed"] as? Bool ?? false

    private let refreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header + Value proposition
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

                    Text("Ask AI about any webpage right in Safari.\nSummarize, explain, translate — instantly.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)
                }
                .padding(.top, 24)

                // Getting started
                Text("Getting Started")
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)

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

                // Onboarding checklist
                VStack(alignment: .leading, spacing: 10) {
                    Label("Setup Checklist", systemImage: "checklist")
                        .font(.headline)

                    checkItem("Account synced", ok: hasEmail)
                    checkItem("Subscription active", ok: isSubscribed)
                }
                .padding(16)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)

                // Data & Privacy disclosure (required by App Store 5.1.1/5.1.2)
                VStack(alignment: .leading, spacing: 10) {
                    Label("Data & Privacy", systemImage: "hand.raised.fill")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.purple)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("What data is shared")
                            .font(.caption)
                            .fontWeight(.semibold)
                        Text("When you ask a question, the text content of the current webpage (or your selected text) is sent to generate an AI response.")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Who receives it")
                            .font(.caption)
                            .fontWeight(.semibold)
                        Text("Page content is sent to OpenAI's API for processing. If you use the BYOK plan, data goes directly from your device to OpenAI. On the Pro plan, data is proxied through our server to OpenAI.")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Your control")
                            .font(.caption)
                            .fontWeight(.semibold)
                        Text("No data is sent until you explicitly ask a question. We do not store page content on our servers. Your browsing history is never collected.")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    HStack(spacing: 4) {
                        Link("Privacy Policy", destination: URL(string: "https://aisidebar.netlify.app/privacy")!)
                        Text("·")
                            .foregroundColor(.secondary)
                        Link("Terms of Use", destination: URL(string: "https://aisidebar.netlify.app/terms")!)
                    }
                    .font(.caption2)
                    .foregroundColor(.purple)
                }
                .padding(16)
                .background(Color.purple.opacity(0.06))
                .cornerRadius(12)

                // Why all websites
                VStack(spacing: 8) {
                    Label("Why \"All Websites\"?", systemImage: "shield.checkered")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.purple)

                    Text("ContextFlow needs access to read page content so it can answer your questions about any webpage you visit.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(16)
                .background(Color.purple.opacity(0.06))
                .cornerRadius(12)

                OpenSafariButton()

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
        }
        .background(backgroundStyle)
        .onAppear {
            refreshChecklist()
        }
        .onReceive(refreshTimer) { _ in
            refreshChecklist()
        }
    }

    private func refreshChecklist() {
        let newHasEmail = SharedDefaults.shared.userEmail != nil
        let newIsSubscribed = SharedDefaults.shared.readSubscriptionStatus()["isSubscribed"] as? Bool ?? false
        if newHasEmail != hasEmail { hasEmail = newHasEmail }
        if newIsSubscribed != isSubscribed { isSubscribed = newIsSubscribed }
    }

    private func checkItem(_ label: String, ok: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle")
                .foregroundColor(ok ? .green : .gray)
            Text(label)
                .font(.subheadline)
            Spacer()
            Text(ok ? "Done" : "Pending")
                .font(.caption)
                .foregroundColor(ok ? .green : .secondary)
        }
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

// MARK: – Auth Mode

enum AuthMode {
    case signIn
    case signUp
}

// MARK: – Supabase REST API Auth

/// Lightweight Supabase GoTrue REST API client for native sign-in.
/// Uses the same project URL and anon key as the web extension.
enum SupabaseAuth {
    static let supabaseURL = "https://schyokcqfqxqrjlsnxnj.supabase.co"
    static let anonKey = "sb_publishable_pU9po5xhCKv1hTVT3xrNQA_8nors2lF"

    struct AuthResponse {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Double
        let userId: String
        let email: String
    }

    /// Sign in with email and password.
    static func signIn(email: String, password: String) async throws -> AuthResponse {
        let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=password")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")

        let body: [String: String] = ["email": email, "password": password]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await performAuthRequest(request)
    }

    /// Create a new account with email and password.
    static func signUp(email: String, password: String) async throws -> AuthResponse {
        let url = URL(string: "\(supabaseURL)/auth/v1/signup")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")

        let body: [String: String] = ["email": email, "password": password]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await performAuthRequest(request)
    }

    /// Refresh an expired access token.
    static func refreshToken(_ refreshToken: String) async throws -> AuthResponse {
        let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=refresh_token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")

        let body: [String: String] = ["refresh_token": refreshToken]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await performAuthRequest(request)
    }

    /// Send a password reset email.
    static func resetPassword(email: String) async throws {
        let url = URL(string: "\(supabaseURL)/auth/v1/recover")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")

        let body: [String: String] = ["email": email]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode >= 400 {
            let errMsg = parseErrorMessage(from: data) ?? "Failed to send reset email"
            throw NSError(domain: "SupabaseAuth", code: httpResponse.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: errMsg])
        }
    }

    // MARK: – Private

    private static func performAuthRequest(_ request: URLRequest) async throws -> AuthResponse {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "SupabaseAuth", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
        }

        if httpResponse.statusCode >= 400 {
            let errMsg = parseErrorMessage(from: data) ?? "Authentication failed (\(httpResponse.statusCode))"
            throw NSError(domain: "SupabaseAuth", code: httpResponse.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: errMsg])
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "SupabaseAuth", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid response format"])
        }

        guard let accessToken = json["access_token"] as? String,
              let refreshToken = json["refresh_token"] as? String else {
            // Sign-up may return user without tokens (email confirmation required)
            if let user = json["user"] as? [String: Any],
               let identities = user["identities"] as? [[String: Any]],
               identities.isEmpty {
                throw NSError(domain: "SupabaseAuth", code: 0,
                              userInfo: [NSLocalizedDescriptionKey: "User already registered"])
            }
            throw NSError(domain: "SupabaseAuth", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "Account created! Check your email to confirm, then sign in."])
        }

        let expiresAt = json["expires_at"] as? Double
            ?? (Date().timeIntervalSince1970 + (json["expires_in"] as? Double ?? 3600))

        let user = json["user"] as? [String: Any] ?? [:]
        let userId = user["id"] as? String ?? ""
        let email = user["email"] as? String ?? ""

        return AuthResponse(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: expiresAt,
            userId: userId,
            email: email
        )
    }

    private static func parseErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["error_description"] as? String
            ?? json["msg"] as? String
            ?? json["message"] as? String
            ?? json["error"] as? String
    }
}
