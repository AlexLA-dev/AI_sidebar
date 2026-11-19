import SwiftUI

// Spaces in the app (2.7, SpaceRecord in ChatMirror.swift; the panel's src/content/Spaces.tsx): the switcher over the
// chats list (a coloured dot and the name; a tap opens the short list), the sheet that makes or edits a space (a name and
// a colour, nothing else), and a search hit's space. The owner (14 Nov): «главное её реализовать не громоздко и понятно».

extension SpaceRecord {
    /// A space's colour as SwiftUI draws it (its base, and the gradient the ✦ circle has).
    static func color(_ name: String) -> Color {
        let rgb = colors.first { $0.name == name }?.base ?? 0x2563eb
        return Color(red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255, blue: Double(rgb & 0xff) / 255)
    }

    static func gradient(_ name: String) -> LinearGradient {
        let pair = colors.first { $0.name == name } ?? colors[0]
        func color(_ rgb: UInt32) -> Color { Color(red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255, blue: Double(rgb & 0xff) / 255) }
        return LinearGradient(colors: [color(pair.light), color(pair.base)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    static func colorLabel(_ name: String) -> String {
        switch name {
        case "green": return String(localized: "Green", comment: "A space's colour (2.7 Spaces)")
        case "orange": return String(localized: "Orange", comment: "A space's colour (2.7 Spaces)")
        case "pink": return String(localized: "Pink", comment: "A space's colour (2.7 Spaces)")
        case "violet": return String(localized: "Violet", comment: "A space's colour (2.7 Spaces)")
        case "graphite": return String(localized: "Graphite", comment: "A space's colour (2.7 Spaces)")
        default: return String(localized: "Blue", comment: "A space's colour (2.7 Spaces)")
        }
    }
}

struct SpaceDot: View {
    let color: String
    var size: CGFloat = 12

    var body: some View {
        Circle().fill(SpaceRecord.gradient(color)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// What the sheet is for: a new space, editing one, or Free with its spaces all made.
enum SpaceSheetMode: Identifiable {
    case new(color: String)
    case edit(SpaceRecord.Shown)
    case limit

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let space): return "edit:\(space.id)"
        case .limit: return "limit"
        }
    }
}

/// The switcher over the chats list: the space's dot and name; the list of spaces, "New space" and "Edit" in a menu.
struct SpacesBar: View {
    @ObservedObject var library: ChatLibrary
    let onNew: () -> Void
    let onEdit: (SpaceRecord.Shown) -> Void

    var body: some View {
        let spaces = library.spaces
        let current = spaces.first { $0.id == library.shownSpace } ?? spaces[0]
        let counts = Dictionary(grouping: library.threads) { library.spaceOf($0).id }.mapValues(\.count)
        Menu {
            ForEach(spaces) { space in
                Button {
                    guard space.id != current.id else { return }
                    library.currentSpace = space.id
                    ChatAI.reportUse("space", "switch", ["via": "app", "spaces": String(spaces.count)])
                } label: {
                    if space.id == current.id {
                        Label("\(space.name) · \(counts[space.id] ?? 0)", systemImage: "checkmark")
                    } else {
                        Text(verbatim: "\(space.name) · \(counts[space.id] ?? 0)")
                    }
                }
            }
            Divider()
            Button(action: onNew) { Label("New space", systemImage: "plus") }
            Button { onEdit(current) } label: { Label("Edit “\(current.name)”…", systemImage: "pencil") }
        } label: {
            HStack(spacing: 8) {
                SpaceDot(color: current.color)
                Text(verbatim: current.name)
                    .font(.headline)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("Space: \(current.name). Switch"))
        .accessibilityIdentifier("cf-space-switcher")
        .listRowBackground(SpaceRecord.color(current.color).opacity(0.11))
    }
}

/// The space a search hit is in (search goes through every space).
struct SpaceTagView: View {
    let space: SpaceRecord.Shown

    var body: some View {
        HStack(spacing: 4) {
            SpaceDot(color: space.color, size: 8)
            Text(verbatim: space.name)
        }
        .font(.caption)
        .foregroundColor(.secondary)
    }
}

/// A name and a colour (the mockup's two fields), Create or Save; editing has Delete for any space but the first (its
/// chats go to the first). Free with its spaces all made: what Pro gives, and Pro.
struct SpaceSheet: View {
    @ObservedObject var library: ChatLibrary
    let mode: SpaceSheetMode
    let openPro: () -> Void
    @State private var name = ""
    @State private var color = "green"
    @State private var askDelete = false
    @Environment(\.dismiss) private var dismiss

    private var firstName: String { String(localized: "Personal", comment: "The first space's name until it's renamed (2.7 Spaces)") }

    private var isFirst: Bool {
        if case .edit(let space) = mode { return space.id == SpaceRecord.first }
        return false
    }

    /// A space needs its name; only the first one's may be empty (it's then called by its default name).
    private var named: Bool { !SpaceRecord.cleanName(name).isEmpty || isFirst }

    var body: some View {
        NavigationView {
            Form {
                if case .limit = mode {
                    Section {
                        Text("Spaces in Free: \(SpaceRecord.freeSpaces). With Pro, as many as you like.")
                        Button("Get Pro") {
                            dismiss()
                            openPro()
                        }
                        .font(.body.weight(.semibold))
                    }
                } else {
                    Section(header: Text("Name")) {
                        TextField(isFirst ? firstName : String(localized: "For example, Work", comment: "A new space's name field (2.7 Spaces)"), text: $name)
                            .onSubmit(save)
                    }
                    Section(header: Text("Color")) {
                        HStack(spacing: 14) {
                            ForEach(SpaceRecord.colors, id: \.name) { option in
                                Button { color = option.name } label: {
                                    Circle()
                                        .fill(SpaceRecord.gradient(option.name))
                                        .frame(width: 32, height: 32)
                                        .overlay(Circle().stroke(Color.primary, lineWidth: color == option.name ? 2.5 : 0).padding(-4))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text(verbatim: SpaceRecord.colorLabel(option.name)))
                                .accessibilityAddTraits(color == option.name ? .isSelected : [])
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    if case .edit(let space) = mode, space.id != SpaceRecord.first {
                        Section {
                            Button(role: .destructive) { askDelete = true } label: { Text("Delete space") }
                        } footer: {
                            Text("Its chats go to “\(library.spaces.first?.name ?? firstName)”.")
                        }
                    }
                }
            }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if case .limit = mode {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isNew ? String(localized: "Create", comment: "Makes the new space (2.7 Spaces)") : String(localized: "Save", comment: "Saves the space's name and colour (2.7 Spaces)"), action: save)
                            .disabled(!named)
                    }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
            .confirmationDialog("Delete space", isPresented: $askDelete, titleVisibility: .visible) {
                Button("Delete space", role: .destructive) {
                    if case .edit(let space) = mode {
                        library.deleteSpace(space.id)
                        ChatAI.reportUse("space", "delete", ["spaces": String(library.spaces.count)])
                    }
                    dismiss()
                }
            } message: {
                Text("Its chats go to “\(library.spaces.first?.name ?? firstName)”.")
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 320)
        #endif
        .onAppear {
            switch mode {
            case .new(let first): color = first
            case .edit(let space):
                name = space.name
                color = space.color
            case .limit: break
            }
        }
    }

    private var isNew: Bool {
        if case .new = mode { return true }
        return false
    }

    private var title: String {
        switch mode {
        case .new, .limit: return String(localized: "New space", comment: "The sheet that makes a space (2.7 Spaces)")
        case .edit(let space): return String(localized: "Edit “\(space.name)”", comment: "The sheet that edits a space (2.7 Spaces)")
        }
    }

    private func save() {
        guard named else { return }
        switch mode {
        case .new:
            library.addSpace(name: name, color: color)
            ChatAI.reportUse("space", "create", ["via": "app", "spaces": String(library.spaces.count)])
        case .edit(let space):
            library.editSpace(space.id, name: name, color: color, firstName: firstName)
            ChatAI.reportUse("space", "edit", ["via": "app"])
        case .limit:
            break
        }
        dismiss()
    }
}
