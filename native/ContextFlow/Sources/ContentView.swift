import SwiftUI
#if os(macOS)
import SafariServices
#endif

/// Main view of the ContextFlow container app.
/// Shows setup instructions so users know how to enable the Safari extension.
@available(macOS 12.0, iOS 15.0, *)
struct ContentView: View {
    @State private var extensionEnabled = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 48))
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
                .padding(.top, 32)

                // Setup instructions card
                VStack(alignment: .leading, spacing: 16) {
                    Label("How to Enable ContextFlow", systemImage: "safari")
                        .font(.headline)
                        .foregroundColor(.purple)

                    setupStep(number: 1, text: "Open **Safari**")
                    #if os(iOS)
                    setupStep(number: 2, text: "Tap the **extensions icon** (puzzle piece) near the address bar")
                    setupStep(number: 3, text: "You'll see a **\"1\" badge** next to Manage Extensions")
                    setupStep(number: 4, text: "Tap **Manage Extensions** and enable **ContextFlow**")
                    #else
                    setupStep(number: 2, text: "Open **Safari → Settings → Extensions**")
                    setupStep(number: 3, text: "Find **ContextFlow** in the list and check the box to enable it")
                    setupStep(number: 4, text: "Click **\"Always Allow on Every Website\"** when prompted")
                    #endif
                    setupStep(number: 5, text: "Sign in or create an account in the extension")
                    setupStep(number: 6, text: "Grant permission to access **all websites** (Always Allow)")
                }
                .padding(20)
                #if os(iOS)
                .background(Color(.systemBackground))
                #else
                .background(Color(nsColor: .controlBackgroundColor))
                #endif
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.08), radius: 8, y: 4)

                // Permission note
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
                Button(action: openSafari) {
                    Label("Open Safari", systemImage: "safari")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
                #else
                Button(action: openSafariExtensionPreferences) {
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
        #if os(iOS)
        .background(Color(.systemGroupedBackground))
        #else
        .background(Color(nsColor: .windowBackgroundColor))
        #endif
    }

    // MARK: - Helpers

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

    #if os(iOS)
    private func openSafari() {
        if let url = URL(string: "https://www.apple.com") {
            UIApplication.shared.open(url)
        }
    }
    #else
    private func openSafariExtensionPreferences() {
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: Bundle.main.bundleIdentifier.map {
                $0 + ".Extension"
            } ?? ""
        )
    }
    #endif
}
