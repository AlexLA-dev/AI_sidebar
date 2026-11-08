import SwiftUI

/// What the paid plans give, one feature a slide, grouped Pro and Ultra (build 90; the owner: why show only sorting by
/// topic on the paywall, show every paid feature). Each slide says what the feature does in one line, over a sample
/// drawn with the app's own pieces, so it's in the reader's language and in light and dark. Swipe, or the arrows;
/// the chips jump to a group. The panel's plans sheet has the same slides (src/content/Gallery.tsx).
struct PaidGallery: View {
    let facts: ChatAI.PlanFacts
    /// Open on Ultra's slides (the plan in focus is Ultra).
    var startOnUltra = false

    enum Slide: Int, CaseIterable {
        case media, search, organize, templates, watch, answers, listen, similar, watchMore
        var ultra: Bool { rawValue >= Slide.listen.rawValue }
    }

    @State private var index = 0
    @State private var forward = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var slide: Slide { Slide(rawValue: index) ?? .media }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("What you get").font(.headline)
                Spacer()
                groupChip(ultra: false)
                groupChip(ultra: true)
            }
            ZStack(alignment: .topLeading) {
                GallerySlide(slide: slide, facts: facts)
                    .id(index)
                    .transition(transition)
            }
            .frame(maxWidth: .infinity, minHeight: 318, alignment: .topLeading)
            .clipped()
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 24).onEnded { drag in
                if drag.translation.width < -40 { step(1) } else if drag.translation.width > 40 { step(-1) }
            })
            HStack {
                Button { step(-1) } label: { Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: 36, height: 30) }
                    .accessibilityLabel(Text("Previous"))
                    .accessibilityIdentifier("gallery.previous")
                    .disabled(index == 0)
                Spacer()
                HStack(spacing: 6) {
                    ForEach(Slide.allCases, id: \.rawValue) { item in
                        Circle()
                            .fill(item.rawValue == index ? (item.ultra ? ultraViolet : brandBlue) : Color.secondary.opacity(0.3))
                            .frame(width: item.rawValue == index ? 8 : 6, height: item.rawValue == index ? 8 : 6)
                    }
                }
                .accessibilityHidden(true)
                Spacer()
                Button { step(1) } label: { Image(systemName: "chevron.right").font(.body.weight(.semibold)).frame(width: 36, height: 30) }
                    .accessibilityLabel(Text("Next"))
                    .accessibilityIdentifier("gallery.next")
                    .disabled(index == Slide.allCases.count - 1)
            }
            .buttonStyle(.borderless)
            .foregroundColor(slide.ultra ? ultraViolet : brandBlue)
        }
        .onAppear {
            #if DEBUG
            // Screenshots of one slide: -CFGallerySlide <n>.
            if let n = UserDefaults.standard.object(forKey: "CFGallerySlide") as? Int, Slide(rawValue: n) != nil {
                index = n
                return
            }
            #endif
            if startOnUltra { index = Slide.listen.rawValue }
        }
        .accessibilityElement(children: .contain)
    }

    private var transition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                           removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity))
    }

    private func step(_ by: Int) {
        go(to: index + by)
    }

    private func go(to target: Int) {
        guard target != index, Slide(rawValue: target) != nil else { return }
        forward = target > index
        withAnimation(.easeInOut(duration: 0.3)) { index = target }
    }

    private func groupChip(ultra: Bool) -> some View {
        Button { go(to: ultra ? Slide.listen.rawValue : 0) } label: {
            TierChip(ultra: ultra, dimmed: slide.ultra != ultra)
        }
        .buttonStyle(.borderless)
        .accessibilityAddTraits(slide.ultra == ultra ? .isSelected : [])
    }
}

let ultraViolet = Color(red: 0.49, green: 0.31, blue: 0.93)

/// "Pro" or "Ultra" in its colours.
struct TierChip: View {
    let ultra: Bool
    var dimmed = false

    var body: some View {
        (ultra ? Text("Ultra") : Text("Pro"))
            .font(.caption.weight(.bold))
            .foregroundColor(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Capsule().fill(ultra ? ultraGradient : brandGradient))
            .opacity(dimmed ? 0.45 : 1)
    }
}

/// One slide: the plan, the feature, what it does, and its sample.
struct GallerySlide: View {
    let slide: PaidGallery.Slide
    let facts: ChatAI.PlanFacts

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TierChip(ultra: slide.ultra)
                title.font(.headline)
            }
            line
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if slide == .organize {
                OrganizePreview()
            } else {
                sample
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.cardFill))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.06)))
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: Text {
        switch slide {
        case .media: return Text("Videos and PDFs")
        case .search: return Text("AI search and Ask your chats")
        case .organize: return Text("Sorts by topic")
        case .templates: return Text("Templates without limits")
        case .watch: return Text("Watch \(facts.watchPro) pages")
        case .answers: return Text("Up to \(facts.proWeekly) answers a week")
        case .listen: return Text("Listen")
        case .similar: return Text("Find similar")
        case .watchMore: return Text("Watch \(facts.watchUltra) pages")
        }
    }

    private var line: Text {
        switch slide {
        case .media: return Text("Answers use the video's transcript and the PDF's pages.")
        case .search: return Text("Find a chat by describing it, or ask a question across all of them.")
        case .organize: return Text("Suggests the right chat for what you just asked, and your own tag for it.")
        case .templates: return Text("Your own prompts and replies, with names and dates filled in from the page.")
        case .watch: return Text("Hear when a price drops or a page changes.")
        case .answers: return Text("Deeper, more detailed answers, instead of \(5) a day.")
        case .listen: return Text("Answers and whole pages read aloud in a natural voice, at the speed you like.")
        case .similar: return Text("Alternatives to any page: cheaper, newer, in stock or in your language.")
        case .watchMore: return Text("Prices, stock and changes on up to \(facts.watchUltra) pages at once.")
        }
    }

    @ViewBuilder
    private var sample: some View {
        switch slide {
        case .media: media
        case .search: search
        case .organize: EmptyView()
        case .templates: templates
        case .watch: notification
        case .answers: answers
        case .listen: player
        case .similar: similar
        case .watchMore: watched
        }
    }

    private func price(_ value: Int, _ code: String = "USD") -> String {
        value.formatted(.currency(code: code).precision(.fractionLength(0)))
    }

    private var media: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { attachments }
                VStack(alignment: .leading, spacing: 6) { attachments }
            }
            Text("Revenue grew 12% in the third quarter. In the video, the CEO puts it down to the new subscription plans.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var attachments: some View {
        chip("play.rectangle.fill", Text("Video transcript · 11:40"))
        chip("doc.richtext", Text("Q3 report · 3 pages"))
    }

    private func chip(_ symbol: String, _ text: Text) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).foregroundColor(brandBlue)
            text.lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule().fill(brandBlue.opacity(0.1)))
    }

    private var search: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundColor(.secondary)
                Text("that article about sleep and coffee").font(.footnote).lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "sparkles")
                    .font(.caption.weight(.bold))
                    .foregroundColor(.white)
                    .padding(6)
                    .background(Circle().fill(brandBlue))
            }
            .padding(.leading, 12)
            .padding(.trailing, 5)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.primary.opacity(0.06)))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("Caffeine and sleep").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("Last week").font(.caption).foregroundColor(.secondary)
                }
                Text("Coffee after 2 pm cut deep sleep by a fifth…")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12).fill(brandBlue.opacity(0.08)))
        }
    }

    private var templates: some View {
        let person = String(localized: "Anna")
        let day = String(localized: "Tuesday")
        var filled = AttributedString(String(localized: "Hi \(person), thanks for the call on \(day). As promised, here are the next steps."))
        for word in [person, day] {
            if let range = filled.range(of: word) {
                filled[range].backgroundColor = Color.yellow.opacity(0.35)
                filled[range].font = .footnote.weight(.semibold)
            }
        }
        return VStack(alignment: .leading, spacing: 8) {
            Label { Text("Follow-up after a call") } icon: { Image(systemName: "text.badge.plus").foregroundColor(brandBlue) }
                .font(.subheadline.weight(.semibold))
            Text(filled)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var notification: some View {
        HStack(alignment: .top, spacing: 10) {
            Image("LargeIcon")
                .resizable()
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text("ContextFlow").font(.caption).foregroundColor(.secondary)
                Text("Changed: Price").font(.footnote.weight(.semibold))
                Text("Now: \(price(99)) (was \(price(129)))").font(.footnote)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.primary.opacity(0.06)))
    }

    private var answers: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .lastTextBaseline, spacing: 8) {
                Text(verbatim: "\(facts.proWeekly)")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(brandGradient)
                Text("a week").font(.subheadline).foregroundColor(.secondary)
            }
            bar(fraction: 1, colour: brandBlue, label: Text("Pro"))
            bar(fraction: 35.0 / Double(max(facts.proWeekly, 35)), colour: Color.secondary.opacity(0.5), label: Text("Free: \(5) a day"))
        }
    }

    private func bar(fraction: Double, colour: Color, label: Text) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            GeometryReader { geo in
                Capsule().fill(colour).frame(width: max(8, geo.size.width * fraction), height: 8)
            }
            .frame(height: 8)
            label.font(.caption).foregroundColor(.secondary)
        }
    }

    private var player: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "speaker.wave.2.fill").foregroundStyle(ultraGradient)
                Text("How electric trains save energy").font(.subheadline.weight(.semibold)).lineLimit(1)
            }
            ProgressView(value: 0.27).tint(ultraViolet)
            HStack {
                Text(verbatim: "1:12")
                Spacer()
                Text(verbatim: "4:30")
            }
            .font(.caption.monospacedDigit())
            .foregroundColor(.secondary)
            HStack(spacing: 26) {
                Image(systemName: "gobackward.15").font(.title3)
                Image(systemName: "pause.circle.fill").font(.system(size: 38))
                Image(systemName: "goforward.15").font(.title3)
                Text(1.5.formatted(.number.precision(.fractionLength(1))) + "×")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(ultraViolet.opacity(0.14)))
            }
            .foregroundColor(ultraViolet)
            .frame(maxWidth: .infinity)
        }
    }

    private var similar: some View {
        VStack(spacing: 8) {
            similarRow(Text("Mesh office chair"), price(169), Text("In stock"))
            similarRow(Text("The same chair, 2026 model"), price(249), Text("Newer"))
            similarRow(Text("Chair with a headrest"), price(129), Text("Cheaper"))
        }
    }

    private func similarRow(_ name: Text, _ amount: String, _ tag: Text) -> some View {
        HStack(spacing: 8) {
            name.font(.footnote.weight(.medium)).lineLimit(1)
            Spacer(minLength: 4)
            tag.font(.caption2.weight(.semibold))
                .foregroundColor(ultraViolet)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(ultraViolet.opacity(0.12)))
            Text(amount).font(.footnote.weight(.semibold).monospacedDigit())
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private var watched: some View {
        VStack(alignment: .leading, spacing: 8) {
            watchedRow("headphones", Text("Headphones"), price(279), was: price(329))
            watchedRow("airplane", Text("Flight to Lisbon"), price(89, "EUR"), was: nil)
            Text("and \(max(0, facts.watchUltra - 2)) more pages")
                .font(.footnote)
                .foregroundColor(.secondary)
                .padding(.leading, 4)
        }
    }

    private func watchedRow(_ symbol: String, _ name: Text, _ now: String, was: String?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).foregroundColor(ultraViolet).frame(width: 22)
            name.font(.footnote.weight(.medium)).lineLimit(1)
            Spacer(minLength: 4)
            if let was { Text(was).font(.caption).strikethrough().foregroundColor(.secondary) }
            Text(now).font(.footnote.weight(.semibold).monospacedDigit())
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }
}
