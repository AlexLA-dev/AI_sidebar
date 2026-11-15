import Foundation

/// The words a text is about (2.7): the panel's `topicWords` (src/shared/words.ts), scalar for scalar, so a card goes to
/// the same collection in the app as in the panel (Board.suggest), in every language the app speaks: function words
/// ("the", "для", "los") don't count; Chinese, Japanese and Korean, which don't put spaces between words, go by pairs of
/// characters. Organizing's names share the function words (Organize.swift). Foundation only:
/// tests/words-parity.test.mts builds this file alone and checks it against the panel's.
nonisolated enum TopicWords {
    /// Words that don't tell names apart, by script: the Latin languages' together, Vietnamese's apart (its "da", "do"
    /// are words), Cyrillic's, Arabic's, Korean's (src/shared/words.ts `NAME_STOP`).
    static let nameStopLatin: Set<String> = [
        "the", "a", "an", "and", "or", "of", "for", "with", "by", "in", "on", "to", "at", "from", "vs", "my", "your", "our", "about", "how", "what",
        "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "für", "mit", "von", "vom", "im", "am", "zum", "zur", "oder", "auf", "über", "bei", "zu", "wie", "was",
        "le", "la", "les", "l", "un", "une", "et", "pour", "avec", "de", "d", "du", "en", "ou", "au", "aux", "sur", "dans", "par", "à",
        "el", "los", "las", "una", "y", "para", "con", "del", "al", "por", "sobre",
        "il", "lo", "i", "gli", "e", "per", "di", "della", "dei", "delle", "degli", "alla", "su", "da", "nel", "nella", "dell",
        "o", "os", "as", "um", "uma", "com", "do", "dos", "das", "em", "no", "na", "nos", "nas", "ao"
    ]
    static let nameStopVi: Set<String> = ["và", "cho", "của", "với", "các", "những", "về", "trong", "là", "một"]
    static let nameStopCyrillic: Set<String> = ["и", "в", "во", "на", "с", "со", "по", "для", "от", "до", "из", "или", "о", "об", "обо", "про", "к", "ко", "у", "за", "это", "как", "что",
                                                "і", "й", "та", "з", "із", "зі", "від", "або", "як", "що"]
    static let nameStopArabic: Set<String> = ["و", "في", "من", "على", "مع", "أو", "عن", "إلى"]
    static let nameStopHangul: Set<String> = ["및", "위한", "대한"]
    /// Korean particles at a word's end ("교토의" is "교토"), the longer first.
    static let koParticles = ["에서", "으로", "에게", "까지", "부터", "의", "을", "를", "은", "는", "이", "가", "에", "로", "와", "과", "도", "만"]

    /// What else a title or a question is made of beside its topic (src/shared/words.ts `TOPIC_EXTRA`, word for word).
    static let topicExtra: [String: [String]] = [
        "en": ["you", "are", "is", "this", "that", "these", "those", "why", "when", "where", "which", "who", "can", "into", "its", "was", "were", "will", "not", "than", "does", "has", "have", "but"],
        "de": ["ist", "sind", "nicht", "wird", "warum", "wann", "wer", "welche", "welcher", "dieser", "diese", "dieses", "ihre", "ihr", "sie", "ich", "wir", "aus", "nach", "man", "sich", "auch", "noch"],
        "fr": ["est", "sont", "pas", "qui", "que", "quoi", "comment", "pourquoi", "quand", "votre", "vos", "nos", "ces", "cette", "son", "ses", "leur", "plus", "tout", "tous"],
        "es": ["que", "qué", "como", "cómo", "cuando", "cuándo", "donde", "dónde", "son", "más", "sus", "este", "esta", "estos", "estas", "pero", "sin", "entre", "todo", "todos", "cual", "cuál"],
        "it": ["che", "come", "perché", "quando", "dove", "sono", "non", "questo", "questa", "questi", "suo", "sua", "più", "tutto", "tra", "fra"],
        "pt": ["que", "como", "quando", "onde", "são", "não", "este", "esta", "seu", "sua", "seus", "suas", "mais", "pelo", "pela", "entre", "todo"],
        "ru": ["чем", "где", "когда", "почему", "зачем", "при", "без", "над", "под", "мой", "ваш", "все", "всё", "его", "она", "они", "так", "тот", "эта", "этот", "эти", "уже", "ещё", "чтобы", "если", "также", "только"],
        "uk": ["чому", "коли", "при", "без", "над", "під", "цей", "ця", "це", "все", "його", "вона", "вони", "щоб", "якщо", "також", "тільки", "який", "яка", "які"],
        "vi": ["được", "này", "không", "như", "nào", "khi", "thì", "cũng", "đến", "từ"],
        "ar": ["هذا", "هذه", "كيف", "ماذا", "لماذا", "التي", "الذي", "ذلك", "تلك", "كان", "هل"],
        "ko": ["어떻게", "무엇", "언제", "어디", "하는", "있는", "위해", "대해", "그리고", "또는", "이런", "이것", "그것", "모든"],
        "zh": ["的", "为什么", "為什麼", "什么", "什麼", "怎么", "怎麼", "如何", "哪些", "哪个", "哪個", "可以", "我们", "我們", "你们", "你們", "这个", "這個", "那个", "那個", "一个", "一個", "以及", "还是", "還是", "或者", "就是", "不是", "没有", "沒有"],
        "single": ["我", "你", "他", "她", "它", "是", "在", "和", "与", "與", "及", "了", "吗", "嗎", "呢", "吧", "也", "都", "就", "年", "月", "日"]
    ]

    private static let stop: Set<String> = {
        let names = [nameStopLatin, nameStopVi, nameStopCyrillic, nameStopArabic, nameStopHangul].flatMap { Array($0) }
        let extra = topicExtra.filter { $0.key != "zh" && $0.key != "single" }.flatMap { $0.value }
        return Set((names + extra).map(fold))
    }()
    private static let singleStop = Set(topicExtra["single"] ?? [])
    /// Chinese grammar words as character runs, the longer first («为什么» before «什么»).
    private static let zhSplit: [[Unicode.Scalar]] = (topicExtra["zh"] ?? []).map { Array($0.unicodeScalars) }.sorted { $0.count > $1.count }

    /// Lower case, the accents off, "ß" as "ss": the panel's `unaccent` (src/shared/fold.ts), scalar for scalar.
    static func fold(_ text: String) -> String {
        let lower = text.lowercased().replacingOccurrences(of: "ß", with: "ss")
        var kept = String.UnicodeScalarView()
        for s in lower.decomposedStringWithCanonicalMapping.unicodeScalars {
            let v = s.value
            if (0x300...0x36F).contains(v) || (0x64B...0x65F).contains(v) || v == 0x670 { continue }
            kept.append(s)
        }
        return String(kept).precomposedStringWithCanonicalMapping
    }

    private enum Script { case hanKana, hiragana, hangul, other }

    // The panel's \p{Script=…} classes as ranges (Swift has no script property): Han, Katakana with «ー», Hiragana,
    // Hangul, as Unicode assigns them.
    private static let hanKana: [ClosedRange<UInt32>] = [
        0x2E80...0x2E99, 0x2E9B...0x2EF3, 0x2F00...0x2FD5, 0x3005...0x3005, 0x3007...0x3007, 0x3021...0x3029, 0x3038...0x303B,
        0x30A1...0x30FA, 0x30FC...0x30FF, 0x31F0...0x31FF, 0x32D0...0x32FE, 0x3300...0x3357, 0x3400...0x4DBF, 0x4E00...0x9FFF,
        0xF900...0xFA6D, 0xFA70...0xFAD9, 0xFF66...0xFF6F, 0xFF71...0xFF9D, 0x20000...0x3134F
    ]
    private static let hiraganaRanges: [ClosedRange<UInt32>] = [0x3041...0x3096, 0x309D...0x309F]
    private static let hangulRanges: [ClosedRange<UInt32>] = [
        0x1100...0x11FF, 0x302E...0x302F, 0x3131...0x318E, 0x3200...0x321E, 0x3260...0x327E, 0xA960...0xA97C, 0xAC00...0xD7A3,
        0xD7B0...0xD7C6, 0xD7CB...0xD7FB, 0xFFA0...0xFFBE, 0xFFC2...0xFFC7, 0xFFCA...0xFFCF, 0xFFD2...0xFFD7, 0xFFDA...0xFFDC
    ]

    private static func script(_ s: Unicode.Scalar) -> Script {
        let v = s.value
        if hanKana.contains(where: { $0.contains(v) }) { return .hanKana }
        if hiraganaRanges.contains(where: { $0.contains(v) }) { return .hiragana }
        if hangulRanges.contains(where: { $0.contains(v) }) { return .hangul }
        return .other
    }

    /// A letter or a digit (the panel's [\p{L}\p{N}]).
    private static func inRun(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func string(_ scalars: some Sequence<Unicode.Scalar>) -> String { String(String.UnicodeScalarView(scalars)) }

    private static func pairs(_ chars: [Unicode.Scalar], _ out: inout Set<String>) {
        guard chars.count > 1 else { return }
        for i in 0..<(chars.count - 1) { out.insert(string([chars[i], chars[i + 1]])) }
    }

    /// A Chinese or Japanese part cut at the Chinese grammar words (the panel's `part.split(ZH_SPLIT)`).
    private static func pieces(_ part: [Unicode.Scalar]) -> [[Unicode.Scalar]] {
        var out: [[Unicode.Scalar]] = []
        var piece: [Unicode.Scalar] = []
        var i = 0
        while i < part.count {
            if let w = zhSplit.first(where: { i + $0.count <= part.count && Array(part[i..<(i + $0.count)]) == $0 }) {
                out.append(piece)
                piece = []
                i += w.count
            } else {
                piece.append(part[i])
                i += 1
            }
        }
        out.append(piece)
        return out
    }

    /// The words a text is about, folded, without function words: letters and digits in runs of 3 or more, no bare
    /// numbers; Chinese and Japanese by pairs of characters, a character alone kept, hiragana (grammar) left out;
    /// Korean words by pairs too, their particle off.
    static func of(_ text: String) -> Set<String> {
        var out = Set<String>()
        var runs: [[Unicode.Scalar]] = []
        var run: [Unicode.Scalar] = []
        for s in fold(text).unicodeScalars {
            if inRun(s) { run.append(s) } else if !run.isEmpty { runs.append(run); run = [] }
        }
        if !run.isEmpty { runs.append(run) }
        for run in runs {
            // The run's parts by script, as the panel's PARTS.
            var parts: [(Script, [Unicode.Scalar])] = []
            for s in run {
                let k = script(s)
                if let last = parts.last, last.0 == k { parts[parts.count - 1].1.append(s) } else { parts.append((k, [s])) }
            }
            for (kind, part) in parts {
                switch kind {
                case .hiragana: continue
                case .hanKana:
                    for piece in pieces(part) {
                        if piece.count == 1 {
                            let c = string(piece)
                            if !singleStop.contains(c) { out.insert(c) }
                        } else { pairs(piece, &out) }
                    }
                case .hangul:
                    var word = part
                    if let p = koParticles.map({ Array($0.unicodeScalars) }).first(where: { part.count - $0.count >= 2 && Array(part.suffix($0.count)) == $0 }) { word = Array(part.dropLast(p.count)) }
                    if !stop.contains(string(word)) { pairs(word, &out) }
                case .other:
                    let w = string(part)
                    if part.count >= 3, !part.allSatisfy({ (0x30...0x39).contains($0.value) }), !stop.contains(w) { out.insert(w) }
                }
            }
        }
        return out
    }
}
