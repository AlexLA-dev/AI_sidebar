// The cookie closer's words (2.7.1, the owner: cookie dialogs blocked typing and cost the agent steps). What a banner
// about cookies says, and what its buttons say, in our 15 languages (en, ru, uk, de, fr, es, it, pt, tr, ar, ja, ko,
// zh-Hans, zh-Hant, vi) and a few more of Europe's, where most of these banners are (nl, pl, sv, da, cs).
//
// Entries follow the agent's word lists (src/shared/agent/match.ts): lower case, compared whole-word; "=" the whole
// label; Chinese, Japanese and Korean anywhere in the label. No imports, so the tests load it as is.

/**
 * A banner or dialog is about cookies when its words say so: the word itself in any script (inside a Chinese or
 * Japanese sentence too, so a substring, not a whole word), or trackers named as such.
 */
export const COOKIE_WORD = /cookie|куки|кукі|çerez|ملفات تعريف الارتباط|ملفات الارتباط|الكوكيز|كوكيز|クッキー|쿠키|traceurs|tracking technolog/i

/**
 * Consent to data use without the word «cookie» (a TCF dialog's «We value your privacy»): enough only with a consent
 * platform's own sign on the page (its API, its frame), never alone.
 */
export const CONSENT_WORD = /privacy|consent|datenschutz|einwilligung|confidentialit|consentement|vie privée|privacidad|consentimiento|riservatezza|consenso|privacidade|consentimento|конфиденциальн|согласи|персональн|приватн|згод|gizlilik|rıza|onay|الخصوصية|موافق|プライバシー|同意|개인정보|동의|隐私|隱私|同意|quyền riêng tư|đồng ý|toestemming|privacybeleid|prywatnoś|zgod|samtyck|samtykke|souhlas/i

/** The privacy-minded answer: reject what isn't needed, keep only what is. */
export const REJECT_LABELS = [
  // en
  "reject all", "reject", "reject cookies", "reject all cookies", "reject optional cookies", "reject non-essential",
  "reject non-essential cookies", "reject additional cookies", "reject analytics cookies", "decline", "decline all",
  "decline cookies", "decline optional cookies", "deny", "deny all", "refuse", "refuse all", "refuse cookies",
  "only necessary", "necessary only", "necessary cookies only", "only necessary cookies", "only essential",
  "essential only", "essential cookies only", "only essential cookies", "strictly necessary only", "required only",
  "only required", "required cookies only", "only required cookies", "use necessary cookies only",
  "use essential cookies only", "allow necessary only", "allow necessary cookies only", "allow essential only",
  "allow only necessary", "allow only essential", "accept only necessary", "accept necessary only",
  "accept only essential", "accept essential only", "accept required only", "accept only required",
  "accept necessary cookies only", "accept only necessary cookies", "continue without accepting",
  "continue without agreeing", "continue without consent", "do not consent", "i do not consent", "don't consent",
  "disagree", "i disagree", "disagree to all", "disagree and close", "do not accept", "i do not accept",
  "object to all", "opt out of all",
  // ru
  "отклонить", "отклонить все", "отклонить всё", "отклонить cookie", "отклонить необязательные", "отказаться",
  "отказаться от всех", "отказаться от cookie", "запретить", "запретить все", "не принимать", "не согласен",
  "не соглашаюсь", "только необходимые", "только обязательные", "только нужные", "только основные",
  "только технические", "разрешить только необходимые", "принять только необходимые", "принять необходимые",
  "использовать только необходимые", "продолжить без согласия", "продолжить без принятия",
  // uk
  "відхилити", "відхилити все", "відхилити всі", "відмовитися", "заборонити", "не приймати", "лише необхідні",
  "тільки необхідні", "лише обов'язкові", "тільки обов'язкові", "прийняти лише необхідні",
  "дозволити лише необхідні", "продовжити без згоди",
  // de
  "ablehnen", "alle ablehnen", "alles ablehnen", "cookies ablehnen", "optionale ablehnen", "nicht einverstanden",
  "verweigern", "alle verweigern", "nur notwendige", "nur notwendige cookies", "nur erforderliche",
  "nur erforderliche cookies", "nur essenzielle", "nur essenzielle cookies", "nur essentielle",
  "nur technisch notwendige", "nur technisch notwendige cookies", "nur funktionale", "nur notwendige zulassen",
  "nur notwendige akzeptieren", "nur erforderliche akzeptieren", "nur erforderliche zulassen",
  "nur notwendige erlauben", "weiter ohne einwilligung", "ohne einwilligung fortfahren", "ohne zustimmung fortfahren",
  "nicht zustimmen", "ich stimme nicht zu", "notwendige cookies verwenden", "nur notwendige verwenden",
  // fr
  "refuser", "tout refuser", "refuser tout", "refuser les cookies", "refuser tous les cookies", "je refuse",
  "refuser et fermer", "continuer sans accepter", "continuer sans accepter →", "continuer sans consentir",
  "uniquement nécessaires", "uniquement les cookies nécessaires", "cookies nécessaires uniquement",
  "nécessaires uniquement", "seulement nécessaires", "accepter uniquement les nécessaires",
  "accepter les cookies nécessaires", "autoriser uniquement les nécessaires", "je ne consens pas", "ne pas consentir",
  "s'opposer à tout",
  // es
  "rechazar", "rechazar todo", "rechazar todas", "rechazar todos", "rechazar cookies", "rechazar las cookies",
  "denegar", "denegar todo", "no acepto", "no aceptar", "solo necesarias", "solo las necesarias",
  "sólo necesarias", "solo cookies necesarias", "solo esenciales", "aceptar solo necesarias",
  "aceptar solo las necesarias", "permitir solo necesarias", "usar solo cookies necesarias",
  "continuar sin aceptar", "no consiento",
  // it
  "rifiuta", "rifiuta tutto", "rifiuta tutti", "rifiuta i cookie", "rifiuta cookie", "nega", "nega tutto",
  "non accetto", "solo necessari", "solo i necessari", "solo cookie necessari", "solo cookie tecnici",
  "solo tecnici", "accetta solo necessari", "accetta solo i necessari", "accetta solo tecnici",
  "consenti solo necessari", "continua senza accettare", "prosegui senza accettare", "non acconsento",
  // pt
  "rejeitar", "rejeitar tudo", "rejeitar todos", "rejeitar cookies", "recusar", "recusar tudo", "recusar todos",
  "recusar cookies", "não aceito", "apenas necessários", "somente necessários", "apenas os necessários",
  "apenas essenciais", "somente essenciais", "aceitar apenas necessários", "aceitar somente necessários",
  "permitir apenas necessários", "continuar sem aceitar", "não concordo",
  // tr
  "reddet", "tümünü reddet", "hepsini reddet", "çerezleri reddet", "reddediyorum", "kabul etmiyorum",
  "yalnızca gerekli", "sadece gerekli", "yalnızca gerekli çerezler", "sadece gerekli çerezler",
  "yalnızca zorunlu", "sadece zorunlu", "zorunlu çerezler", "yalnızca zorunlu çerezler",
  "sadece zorunlu çerezler", "sadece gerekli olanlar", "yalnızca gerekli olanlar", "zorunlu olanları kabul et",
  "sadece gerekli olanları kabul et", "onaylamıyorum",
  // ar
  "رفض", "رفض الكل", "رفض الجميع", "رفض الكل", "أرفض", "رفض ملفات تعريف الارتباط", "الضرورية فقط",
  "الضرورية فقط", "الأساسية فقط", "قبول الضرورية فقط", "السماح بالضرورية فقط", "لا أوافق", "عدم الموافقة",
  "المتابعة دون قبول",
  // ja
  "拒否", "すべて拒否", "全て拒否", "拒否する", "すべて拒否する", "同意しない", "同意しません", "必須のみ",
  "必要なもののみ", "必須cookieのみ", "必須のcookieのみ", "必要なcookieのみ", "必要なクッキーのみ", "必須クッキーのみ",
  "必須のみ許可", "必要なもののみ許可", "必須のみ受け入れる",
  // ko
  "거부", "모두 거부", "전체 거부", "거절", "모두 거절", "필수만", "필수 쿠키만", "필수 항목만", "필수만 허용",
  "필수 쿠키만 허용", "동의하지 않음", "동의 안 함",
  // zh-Hans
  "拒绝", "全部拒绝", "拒绝全部", "拒绝所有", "拒绝所有cookie", "仅必要", "仅限必要", "仅必要的", "仅必要cookie",
  "仅接受必要", "只接受必要", "仅使用必要", "不同意", "不接受",
  // zh-Hant
  "拒絕", "全部拒絕", "拒絕全部", "拒絕所有", "僅必要", "僅限必要", "僅接受必要", "只接受必要", "不同意", "不接受",
  // vi
  "từ chối", "từ chối tất cả", "từ chối cookie", "chỉ cần thiết", "chỉ những cookie cần thiết",
  "chỉ chấp nhận cần thiết", "chỉ cho phép cần thiết", "không đồng ý",
  // nl
  "weigeren", "alles weigeren", "alle weigeren", "afwijzen", "alles afwijzen", "alleen noodzakelijk",
  "alleen noodzakelijke", "alleen noodzakelijke cookies", "alleen functionele", "alleen functionele cookies",
  "niet akkoord",
  // pl
  "odrzuć", "odrzuć wszystkie", "odrzuć wszystko", "odmawiam", "nie zgadzam się", "tylko niezbędne",
  "tylko niezbędne pliki cookie", "tylko wymagane", "zezwól tylko na niezbędne", "akceptuj tylko niezbędne",
  // sv, da, cs
  "avvisa", "avvisa alla", "neka", "neka alla", "endast nödvändiga", "bara nödvändiga", "afvis", "afvis alle",
  "kun nødvendige", "afslå", "odmítnout", "odmítnout vše", "pouze nezbytné"
]

/** Saying yes to what the site wants: never pressed for the person. */
export const ACCEPT_LABELS = [
  "accept", "accept all", "accept cookies", "accept all cookies", "accept and close", "accept & close",
  "accept and continue", "i accept", "agree", "i agree", "agree and close", "agree & close", "agree and continue",
  "allow", "allow all", "allow cookies", "allow all cookies", "=ok", "=okay", "ok, got it", "got it", "i understand",
  "understood", "=continue", "consent", "i consent", "yes, i'm happy", "yes i'm happy", "that's ok", "sounds good",
  "принять", "принять все", "принять всё", "принимаю", "согласен", "согласна", "соглашаюсь", "разрешить",
  "разрешить все", "хорошо", "понятно", "ок", "=да",
  "прийняти", "прийняти все", "приймаю", "погоджуюсь", "дозволити", "дозволити все", "зрозуміло", "добре",
  "akzeptieren", "alle akzeptieren", "alles akzeptieren", "zustimmen", "allen zustimmen", "ich stimme zu",
  "einverstanden", "zulassen", "alle zulassen", "alle cookies zulassen", "erlauben", "alle erlauben",
  "accepter", "tout accepter", "accepter tout", "j'accepte", "accepter et fermer", "accepter et continuer",
  "autoriser", "tout autoriser", "d'accord", "j'ai compris", "compris",
  "aceptar", "aceptar todo", "aceptar todas", "aceptar todos", "acepto", "aceptar y cerrar", "aceptar y continuar",
  "permitir", "permitir todo", "permitir todas", "de acuerdo", "entendido",
  "accetta", "accetta tutto", "accetta tutti", "accetto", "accetta e chiudi", "accetta e continua", "consenti",
  "consenti tutti", "acconsento", "ho capito", "va bene",
  "aceitar", "aceitar tudo", "aceitar todos", "aceito", "concordo", "permitir", "permitir todos", "entendi",
  "kabul et", "kabul ediyorum", "tümünü kabul et", "hepsini kabul et", "tüm çerezleri kabul et", "izin ver",
  "tümüne izin ver", "onaylıyorum", "anladım", "tamam",
  "قبول", "قبول الكل", "قبول الجميع", "أوافق", "موافق", "السماح", "السماح للكل", "فهمت",
  "同意", "同意する", "すべて同意", "すべて受け入れる", "全て受け入れる", "受け入れる", "許可", "すべて許可", "承諾", "了解",
  "동의", "모두 동의", "모두 수락", "수락", "허용", "모두 허용", "확인",
  "接受", "全部接受", "接受全部", "接受所有", "我同意", "允许", "全部允许", "知道了", "好的",
  "全部接受", "接受所有", "允許", "全部允許", "我知道了",
  "chấp nhận", "chấp nhận tất cả", "đồng ý", "tôi đồng ý", "cho phép", "cho phép tất cả", "đã hiểu",
  "accepteren", "alles accepteren", "akkoord", "toestaan", "alles toestaan",
  "akceptuj", "akceptuj wszystkie", "zgadzam się", "zezwól", "zezwól na wszystkie",
  "acceptera", "acceptera alla", "godkänn", "godkänn alla", "tillåt alla", "accepter alle", "tillad alle",
  "přijmout", "přijmout vše", "souhlasím", "povolit vše"
]

/** A banner's way to its settings: pressed only by a platform's own rule, never by the generic closer. */
export const SETTINGS_LABELS = [
  "settings", "cookie settings", "manage", "manage settings", "manage cookies", "manage options", "manage preferences",
  "preferences", "cookie preferences", "customize", "customise", "options", "more options", "show purposes",
  "настройки", "настроить", "параметры", "управлять", "einstellungen", "anpassen", "mehr optionen", "paramètres",
  "personnaliser", "gérer", "configuración", "configurar", "personalizar", "gestionar", "impostazioni",
  "personalizza", "gestisci", "configurações", "gerenciar", "ayarlar", "özelleştir", "tercihler", "الإعدادات",
  "تخصيص", "設定", "カスタマイズ", "설정", "관리", "设置", "管理", "設置", "cài đặt", "tùy chỉnh"
]
