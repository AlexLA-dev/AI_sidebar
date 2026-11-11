import SwiftUI

// Find similar's answer in the app (2.6), drawn like the panel's, with the same parts. The chat keeps the whole answer
// (src/shared/similar.ts SimilarAnswer, the entry's "similar"); the app draws the panel's cards from it
// (src/content/similar/Similar.tsx SimilarList): how close each item is and how it differs, its price (≈ theirs),
// stock, whether the condition holds, what people say, the less similar ones apart. Its words are the panel's.

/// A Find similar answer as the chat keeps it. Read leniently: a part that doesn't make sense is left out, the chat
/// still reads (an answer without items shows its Markdown, as before).
struct SimilarAnswerData: Decodable, Hashable {
    var intro = ""
    var items: [SimilarItemData] = []
    var note = ""
    /// When its pages were checked (ms).
    var at: Double?

    private enum Keys: String, CodingKey { case intro, items, note, at }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return }
        intro = (try? c.decode(String.self, forKey: .intro)) ?? ""
        note = (try? c.decode(String.self, forKey: .note)) ?? ""
        at = try? c.decode(Double.self, forKey: .at)
        items = ((try? c.decode([LenientItem].self, forKey: .items)) ?? []).compactMap(\.item)
    }

    private struct LenientItem: Decodable {
        let item: SimilarItemData?
        init(from decoder: Decoder) throws { item = try? SimilarItemData(from: decoder) }
    }
}

struct SimilarItemData: Decodable, Hashable {
    var name: String
    var why: String?
    var fit: String?
    /// "yes", "no" (close, but misses the chip they tapped), "unknown" (not confirmed), "n/a" (no condition).
    var met: String?
    var url: String
    var host: String?
    var source: String?
    var checked: Bool?
    var price: String?
    var priceLocal: String?
    var stock: String?
    var date: String?
    var similarity: Int?
    var estimated: Bool?
    var differs: String?
    var regionLocked: Bool?
    var same: Bool?
    var pricing: Pricing?
    var reviews: Reviews?

    struct Pricing: Decodable, Hashable {
        var model: String
        var from: String?
        var period: String?
        var freeStart: Bool?
        var url: String
    }

    struct Reviews: Decodable, Hashable {
        struct Rating: Decodable, Hashable {
            var value: Double
            var best: Double
            var count: Int?
        }
        var rating: Rating?
        var pros: String?
        var cons: String?
        var summary: String?
        var sources: [String]?
    }
}

/// The panel's split (src/shared/similar.ts closeAndLess): under 60 % an item is "less similar", shown apart when fewer
/// than 3 are close; none close at all, the best of them leads.
enum SimilarSplit {
    static let close = 60

    static func split(_ items: [SimilarItemData]) -> (close: [SimilarItemData], less: [SimilarItemData]) {
        let near = items.filter { ($0.similarity ?? 100) >= close }
        let less = items.filter { ($0.similarity ?? 100) < close }
        if near.count >= 3 { return (near, []) }
        if near.isEmpty { return (Array(less.prefix(1)), Array(less.dropFirst().prefix(3))) }
        return (near, Array(less.prefix(3)))
    }

    /// A price as the page's markup states it ("169.99 USD"), the way the person writes money.
    static func money(_ price: String) -> String {
        let parts = price.split(separator: " ")
        guard parts.count == 2, let amount = Decimal(string: String(parts[0]), locale: Locale(identifier: "en_US_POSIX")) else { return price }
        let code = String(parts[1])
        guard code.count == 3 else { return price }
        return amount.formatted(.currency(code: code).presentation(.narrow))
    }
}

struct SimilarCardsView: View {
    let answer: SimilarAnswerData

    var body: some View {
        let (close, less) = SimilarSplit.split(answer.items)
        VStack(alignment: .leading, spacing: 12) {
            if !answer.intro.isEmpty {
                Text(answer.intro)
                    .textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(close.enumerated()), id: \.offset) { index, item in
                    SimilarItemCard(item: item, number: index + 1, less: false)
                }
            }
            if !less.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Less similar")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(.secondary)
                    ForEach(Array(less.enumerated()), id: \.offset) { index, item in
                        SimilarItemCard(item: item, number: close.count + index + 1, less: true)
                    }
                }
                .padding(.top, 2)
            }
            if !answer.note.isEmpty {
                Text(answer.note)
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }
            if let at = answer.at {
                Label {
                    Text("Links checked at \(Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened))")
                } icon: {
                    Image(systemName: "checkmark")
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A finished answer with alternatives, opened in the app within two days of its search: a good moment for a
        // rating (2.6 (100)).
        .onAppear {
            guard !close.isEmpty, let at = answer.at, Date().timeIntervalSince1970 - at / 1000 < 2 * 86_400 else { return }
            ReviewAsk.shared.ask(.similar, after: 2)
        }
    }
}

private struct SimilarItemCard: View {
    let item: SimilarItemData
    let number: Int
    let less: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(less ? Color.secondary : brandBlue))
            VStack(alignment: .leading, spacing: 4) {
                if let url = URL(string: item.url) {
                    Link(destination: url) {
                        Text(item.name)
                            .font(.body.weight(.semibold))
                            .multilineTextAlignment(.leading)
                    }
                } else {
                    Text(item.name).font(.body.weight(.semibold))
                }
                hostLine
                if let why = item.why, !why.isEmpty {
                    Text(why)
                        .font(.callout)
                        .foregroundColor(.secondary)
                        .textSelection(.enabled)
                }
                closeness
                if item.regionLocked == true {
                    Text("Not in your country's App Store")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(.orange)
                }
                fit
                reviews
                facts
            }
        }
    }

    // MARK: Parts, in the panel's order

    private var hostLine: some View {
        HStack(spacing: 4) {
            Text(item.host ?? host(of: item.url))
            if item.source == "list" {
                Text("·")
                Text("named in a review")
            }
            if item.same == true {
                Text("·")
                Text("Same item, another shop")
                    .fontWeight(.semibold)
                    .foregroundColor(.green)
            }
        }
        .font(.caption)
        .foregroundColor(.secondary)
        .lineLimit(1)
    }

    @ViewBuilder private var closeness: some View {
        let pct = item.same == true ? nil : item.similarity
        if pct != nil || !(item.differs ?? "").isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                if let pct {
                    HStack(spacing: 4) {
                        Text("\(pct)% similar")
                            .fontWeight(.semibold)
                        if item.estimated == true {
                            Text("· \(String(localized: "estimated from the description"))")
                                .foregroundColor(.secondary)
                        }
                    }
                }
                if let differs = item.differs, !differs.isEmpty {
                    Text("Differs: \(differs)")
                        .textSelection(.enabled)
                }
            }
            .font(.footnote)
            .foregroundColor(less ? .secondary : .primary)
        }
    }

    @ViewBuilder private var fit: some View {
        let text = item.fit ?? ""
        switch item.met {
        case "yes" where !text.isEmpty:
            Label {
                Text(text).textSelection(.enabled)
            } icon: {
                Image(systemName: "checkmark")
            }
            .font(.callout)
            .foregroundColor(.green)
        case "unknown":
            tagged("Not confirmed", text)
        case "no":
            tagged("Doesn't meet your choice", text)
        default:
            if !text.isEmpty {
                Text(text)
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private func tagged(_ tag: LocalizedStringKey, _ text: String) -> some View {
        (Text(tag).fontWeight(.semibold) + Text(text.isEmpty ? "" : "  \(text)"))
            .font(.callout)
            .foregroundColor(.secondary)
            .textSelection(.enabled)
    }

    /// «What people say: ★ 4.6 · 687 ratings · like … · dislike … · site», one line for every item (build 94).
    @ViewBuilder private var reviews: some View {
        if let r = item.reviews {
            let parts = reviewParts(r)
            if !parts.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    (Text("What people say:").fontWeight(.semibold) + Text(" " + parts.joined(separator: " · ")))
                        .font(.footnote)
                        .textSelection(.enabled)
                    let links = (r.sources ?? []).compactMap { URL(string: $0) }
                    if !links.isEmpty {
                        HStack(spacing: 8) {
                            ForEach(links, id: \.self) { url in
                                Link(destination: url) { Text(host(of: url.absoluteString)) }
                            }
                        }
                        .font(.caption)
                    }
                }
            }
        }
    }

    private func reviewParts(_ r: SimilarItemData.Reviews) -> [String] {
        var parts: [String] = []
        if let rating = r.rating {
            let value = rating.value.formatted(.number.precision(.fractionLength(0...1)))
            parts.append(rating.best == 5 ? "★ \(value)" : "★ \(value)/\(rating.best.formatted(.number.precision(.fractionLength(0))))")
            if let count = rating.count { parts.append(String(localized: "\(count.formatted()) ratings")) }
        }
        if let pros = r.pros, !pros.isEmpty { parts.append(String(localized: "like \(pros)")) }
        if let cons = r.cons, !cons.isEmpty { parts.append(String(localized: "dislike \(cons)")) }
        if (r.pros ?? "").isEmpty && (r.cons ?? "").isEmpty, let summary = r.summary, !summary.isEmpty { parts.append(summary) }
        return parts
    }

    /// The price (≈ theirs), stock, date, an app's pricing; "couldn't open the page" when it wasn't opened.
    @ViewBuilder private var facts: some View {
        let shown = factParts()
        if !shown.isEmpty || item.checked == false {
            HStack(spacing: 6) {
                if !shown.isEmpty {
                    Text(shown.joined(separator: " · "))
                        .fontWeight(.semibold)
                }
                if item.checked == false {
                    Text("Couldn't open the page to check")
                        .foregroundColor(.secondary)
                }
            }
            .font(.footnote)
        }
    }

    private func factParts() -> [String] {
        var parts: [String] = []
        if let pricing = item.pricing {
            parts.append(payText(pricing))
        } else if let price = item.price {
            parts.append(item.priceLocal.map { "\(SimilarSplit.money(price)) ≈ \(SimilarSplit.money($0))" } ?? SimilarSplit.money(price))
        }
        if item.stock == "in" { parts.append(String(localized: "In stock")) }
        if item.stock == "out" { parts.append(String(localized: "Out of stock")) }
        if let date = item.date, let day = ISO8601DateFormatter().date(from: "\(date)T00:00:00Z") {
            parts.append(day.formatted(.dateTime.year().month(.abbreviated).day()))
        }
        return parts
    }

    /// What an app costs (src/content/similar/Similar.tsx payText).
    private func payText(_ p: SimilarItemData.Pricing) -> String {
        if p.model == "free" { return String(localized: "Free, no in-app purchases") }
        let money = p.from.map(SimilarSplit.money) ?? ""
        let per: String
        switch p.period {
        case "week": per = String(localized: "\(money)/week")
        case "year": per = String(localized: "\(money)/year")
        case "month": per = String(localized: "\(money)/month")
        default: per = money
        }
        let what: String
        switch p.model {
        case "subscription": what = String(localized: "Subscription from \(per)")
        case "one_time": what = String(localized: "One-time purchase \(money)")
        default: what = String(localized: "In-app purchases from \(per)")
        }
        return p.freeStart == true ? "\(String(localized: "Free")) · \(what)" : what
    }
}

/// Under a Find similar question: where it looked (near them, in their country, or worldwide), as in the panel.
struct SimilarWhereLine: View {
    let region: String
    let country: String?

    var body: some View {
        Group {
            if region == "world" {
                Text("Worldwide")
            } else if let country, let name = Locale.current.localizedString(forRegionCode: country) {
                Text("Near me · \(name)")
            } else {
                Text("Near me")
            }
        }
        .font(.caption)
        .foregroundColor(.secondary)
    }
}

#if DEBUG
/// Screenshots of a Find similar answer in the app: -CFDebugSeedSimilar YES puts this chat here — a real
/// answer from a test run (an office chair, in the US), as the chat keeps it.
enum SimilarDebugSeed {
    static let id = "debug-similar"
    static let json = #"""
{"title": "Aeron Chair - Office Chairs - Herman Miller", "m": [{"role": "user", "content": "Cheaper", "label": "Cheaper", "similarAsk": "Cheaper", "similarRegion": "local", "similarCountry": "US", "id": "ds1", "t": 0, "page": {"url": "https://www.hermanmiller.com/products/seating/office-chairs/aeron-chair/", "title": "Aeron Chair - Office Chairs - Herman Miller", "at": 0}}, {"role": "assistant", "content": "", "similar": {"intro": "Here are ergonomic office chairs similar to the Aeron, from refurbished Aerons to lower-priced alternatives.", "items": [{"name": "Herman Miller Classic Aeron Chair", "why": "It is a refurbished Herman Miller Aeron with forward tilt, adjustable arms and a mesh build.", "fit": "Costs 565 USD. The Aeron page's price isn't shown, so whether it is cheaper can't be confirmed; the list guide says a new Aeron starts at $1,620.", "met": "unknown", "url": "https://www.officelogixshop.com/products/herman-miller-classic-aeron-chair-size-b-lumbar", "host": "officelogixshop.com", "title": "Refurbished Herman Miller Aeron Chair | Classic, Sizes B & C &ndash; Office Logix Shop", "source": "item", "checked": true, "price": "565 USD", "stock": "in", "date": "2026-04-23", "watch": {"source": "ld-price", "value": "565.00 USD"}, "similarity": 100, "differs": "Renewed, not new; the same shop's Aeron Classic with aluminum frame is 750 USD", "reviews": {"rating": {"value": 4.9, "best": 5, "count": 44}, "sources": ["https://www.officelogixshop.com/products/herman-miller-classic-aeron-chair-size-b-lumbar"]}}, {"name": "Doro C300 Pro V2 Ergonomic Office Chair", "why": "It is an ergonomic chair with adaptive back support, 8D armrests and adjustable seat depth for home or office.", "fit": "Costs 409.99 USD, well under the $1,620 starting price of a new Aeron given in the list guide (the Aeron page's price isn't shown).", "met": "unknown", "url": "https://www.sihoo.com/products/doro-c300-pro-v2", "host": "sihoo.com", "title": "Sihoo Doro C300 Pro V2 with Full Body Adaptive Support &ndash; Official US Sihoo Store", "source": "item", "checked": true, "price": "409.99 USD", "stock": "in", "watch": {"source": "ld-price", "value": "409.99 USD"}, "similarity": 50, "differs": "Not full mesh like the Aeron and a lower price tier"}, {"name": "Branch Ergonomic Chair Pro", "why": "It has two-way adjustable lumbar support, 5D armrests and a breathable back for office use.", "fit": "Costs 449.10 USD; the Aeron's price isn't shown, so cheaper can't be confirmed. The same site's Open Box model is 399 USD.", "met": "unknown", "url": "https://www.branchfurniture.com/products/ergonomic-chair-pro", "host": "branchfurniture.com", "title": "Branch Ergonomic Chair Pro | Most Comfortable Office Chair", "source": "item", "checked": true, "price": "449.10 USD", "stock": "in", "watch": {"source": "ld-price", "value": "449.1 USD"}, "similarity": 50, "differs": "Padded seat rather than a full mesh seat", "reviews": {"rating": {"value": 4.5, "best": 5, "count": 931}, "pros": "chic design, super comfy, thick soft seat, responsive breathable back, loads of adjustments, good range of colours and materials", "sources": ["https://www.branchfurniture.com/products/ergonomic-chair-pro", "https://www.creativebloq.com/tech/chairs-desks/branch-ergonomic-chair-pro-review-this-is-the-best-mid-range-price-ergonomic-chair-today"]}}, {"name": "Sihoo Doro C300 Advanced Ergonomic Office Chair with Advanced Back Support", "why": "It is an ergonomic office chair with adaptive lumbar support aimed at long sitting hours.", "fit": "Costs 269.99 USD, much less than a new Aeron's $1,620 starting price per the list guide (the Aeron page's price isn't shown).", "met": "unknown", "url": "https://www.sihoo.com/products/sihoo-doro-c300-ergonomic-office-chair", "host": "sihoo.com", "title": "Sihoo Doro C300 Advanced Ergonomic Office Chair with Advanced Back Support &ndash; Official US Sihoo Store", "source": "item", "checked": true, "price": "269.99 USD", "stock": "in", "watch": {"source": "ld-price", "value": "269.99 USD"}, "similarity": 50, "differs": "Budget tier with fewer adjustments; the brand's Pro V2 is 409.99 USD", "reviews": {"rating": {"value": 4.9, "best": 5, "count": 998}, "pros": "comfortable, easy to assemble, effective adaptive lumbar support, good packaging, not stuffy in hot weather, good quality plastic, well fini", "cons": "seams gave way after about a year, one piece broke", "sources": ["https://www.sihoo.com/products/sihoo-doro-c300-ergonomic-office-chair"]}}], "note": "The page for your Aeron showed no price, so the price comparisons rely on the $1,620 starting price in a list guide.", "condition": "cheaper", "asked": "Cheaper", "at": 0}, "id": "ds2", "t": 0}]}
"""#
}
#endif
