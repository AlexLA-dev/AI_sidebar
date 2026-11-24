// The agent's words for buttons and fields in the 15 languages of the panel (en, ru, uk, de, fr, es, it, pt, tr,
// ar, ja, ko, zh-Hans, zh-Hant, vi). Code decides a step's class by them (classify.ts), the model never does.
//
// How an entry matches a label (normalized: lower case, NFKC, punctuation and extra spaces gone):
// - "word" or "two words": the whole word or phrase, anywhere in the label (letters or digits around it don't count
//   as a boundary: "pay" isn't in "display");
// - "stem*": the word and any ending ("оплат*" is in «Оплатить», «Оплата», «Оплатите»);
// - "=word": only when the whole label is that word (short words with other meanings: «Like», «Seguir»);
// - in Chinese, Japanese and Korean labels there are no spaces: an entry in those scripts matches anywhere.
// When several entries match, the longest phrase wins («Отправить заявку» is a request, not a message;
// «Перейти в корзину» is going to the cart, not adding to it); a tie goes to the stricter kind.

export type WordKind =
  // The person only (classify: self).
  | "pay" | "send" | "post" | "rate" | "account" | "auth" | "consent"
  // The «Сделать?» card first.
  | "submit" | "weak"
  // Free: going on, looking, searching; a consent dialog's «only necessary».
  | "nav" | "reject"

export const WORDS: Record<WordKind, string[]> = {
  // Buying and paying: the agent brings the person to this button and stops.
  pay: [
    // en
    "buy", "buy now", "pay", "pay now", "place order", "place your order", "complete purchase", "complete order",
    "confirm order", "confirm purchase", "confirm payment", "purchase", "order now", "submit order", "checkout and pay",
    // What else spends money (2.7.1, the security review): upgrades, trials that turn into a charge, bids, gifts, rents.
    "upgrade", "upgrade now", "go premium", "get premium", "start free trial", "start trial", "start my trial", "try it free",
    "try for free", "place bid", "bid now", "donate", "donate now", "rent", "rent now", "pre-order", "preorder",
    "пожертвовать", "задонатить", "арендовать", "сделать ставку", "попробовать бесплатно", "оформить пробный период", "улучшить тариф",
    "spenden", "jetzt spenden", "mieten", "gebot abgeben", "kostenlos testen", "jetzt upgraden",
    "faire un don", "louer", "enchérir", "essai gratuit", "essayer gratuitement",
    "donar", "alquilar", "pujar", "prueba gratis", "probar gratis",
    "dona", "noleggia", "fai un'offerta", "prova gratis",
    "doar", "alugar", "dar lance", "teste grátis", "experimente grátis",
    // ru
    "купить", "купите", "оплат*", "оформить заказ", "подтвердить заказ", "подтвердить оплату", "заказать",
    "завершить покупку", "оформить подписку",
    // uk
    "купити", "придбати", "оплат*", "сплатити", "оформити замовлення", "підтвердити замовлення", "замовити",
    // de
    "kaufen", "jetzt kaufen", "kostenpflichtig bestellen", "zahlungspflichtig bestellen", "bezahlen", "jetzt bezahlen",
    "bestellung abschicken", "bestellung aufgeben", "bestellen", "kauf abschließen",
    // fr
    "acheter", "acheter maintenant", "payer", "commander", "passer la commande", "valider la commande",
    "confirmer la commande", "finaliser la commande", "régler", "valider le paiement", "confirmer le paiement",
    // es
    "comprar", "comprar ahora", "pagar", "realizar pedido", "hacer pedido", "confirmar pedido", "finalizar compra",
    "confirmar compra", "tramitar pedido", "confirmar pago",
    // it
    "acquista", "acquista ora", "compra", "paga", "ordina", "conferma ordine", "completa l'ordine",
    "conferma l'acquisto", "effettua ordine", "inoltra ordine",
    // pt
    "comprar", "comprar agora", "pagar", "finalizar compra", "finalizar pedido", "confirmar pedido", "fazer pedido",
    "confirmar pagamento",
    // tr
    "satın al", "hemen al", "şimdi al", "öde", "ödeme yap", "siparişi tamamla", "siparişi onayla", "sipariş ver",
    "alışverişi tamamla", "ödemeyi tamamla",
    // ar
    "شراء", "اشتر", "اشتري", "ادفع", "دفع", "إتمام الطلب", "تأكيد الطلب", "إتمام الشراء", "اطلب الآن", "تأكيد الدفع",
    // ja
    "購入", "今すぐ購入", "注文を確定", "注文する", "注文確定", "支払う", "お支払い", "決済",
    // ko
    "구매", "구매하기", "바로 구매", "결제", "결제하기", "주문하기", "주문 완료", "주문 확정",
    // zh-Hans
    "购买", "立即购买", "支付", "付款", "提交订单", "确认订单", "确认付款", "下单", "立即支付",
    // zh-Hant
    "購買", "立即購買", "提交訂單", "確認訂單", "確認付款", "下單", "結帳",
    // vi
    "mua", "mua ngay", "thanh toán", "đặt hàng", "xác nhận đơn hàng", "hoàn tất đơn hàng", "đặt mua"
  ],

  // A message to a person in the person's name: a mail, a chat, a reply. A plain «Send» on a form with fields
  // (a request to a business) is a submit (classify.ts looks at where the button is).
  send: [
    "send", "send message", "send email", "send reply",
    "отправить", "отправить сообщение", "отправить письмо",
    "надіслати", "відправити", "надіслати повідомлення",
    "senden", "absenden", "abschicken", "nachricht senden",
    "envoyer", "envoyer le message",
    "enviar", "enviar mensaje", "enviar mensagem",
    "invia", "invia messaggio",
    "gönder", "mesaj gönder",
    "إرسال", "أرسل", "ارسال",
    "送信", "送る", "メッセージを送信",
    "보내기", "전송", "메시지 보내기",
    "发送", "发送消息",
    "傳送", "發送", "送出訊息",
    "gửi", "gửi tin nhắn"
  ],

  // Publishing: a post, a comment, a reply in public.
  post: [
    "=post", "publish", "post comment", "reply", "comment", "tweet", "post reply", "submit comment",
    "опубликовать", "опубликов*", "ответить", "комментировать", "прокомментировать", "оставить комментарий",
    "опублікувати", "відповісти", "коментувати", "залишити коментар",
    "veröffentlichen", "posten", "antworten", "kommentieren", "kommentar abschicken",
    "publier", "répondre", "commenter", "poster",
    "publicar", "responder", "comentar",
    "pubblica", "rispondi", "commenta",
    "yayınla", "yanıtla", "cevapla", "yorum yap", "yorum gönder",
    "نشر", "انشر", "رد", "تعليق", "أضف تعليقا",
    "投稿", "投稿する", "返信", "公開", "コメントする",
    "게시", "게시하기", "답장", "댓글 달기", "댓글 등록", "올리기",
    "发布", "回复", "评论", "提交评论",
    "發布", "發佈", "回覆", "留言",
    "đăng", "trả lời", "bình luận", "phản hồi"
  ],

  // Reviews, ratings, votes, likes, follows (App Store 3.2.2: never on the person's behalf).
  rate: [
    "=like", "=follow", "rate", "vote", "upvote", "downvote", "submit review", "write a review", "post review",
    "оценить", "проголосовать", "голосовать", "=нравится", "=лайк", "оставить отзыв", "отправить отзыв",
    "оцінити", "проголосувати", "=подобається", "залишити відгук",
    "bewerten", "abstimmen", "=gefällt mir", "=folgen", "bewertung abschicken", "bewertung schreiben",
    "noter", "voter", "=j'aime", "=suivre", "laisser un avis", "publier un avis",
    "valorar", "votar", "=me gusta", "=seguir", "calificar", "escribir una reseña", "enviar reseña",
    "vota", "valuta", "=mi piace", "=segui", "scrivi una recensione", "invia recensione",
    "avaliar", "votar", "=curtir", "=seguir", "escrever avaliação", "enviar avaliação",
    "oy ver", "değerlendir", "=beğen", "takip et", "puan ver", "yorum ve puan",
    "قيم", "تقييم", "صوت", "تصويت", "=أعجبني", "=تابع",
    "評価する", "投票", "=いいね", "=フォロー", "レビューを投稿", "レビューを書く",
    "평가", "투표", "=좋아요", "=팔로우", "리뷰 작성", "리뷰 등록",
    "评分", "投票", "点赞", "=赞", "=关注", "发表评价",
    "評分", "按讚", "=讚", "=追蹤", "=關注", "發表評論",
    "đánh giá", "bình chọn", "=thích", "=theo dõi", "viết đánh giá"
  ],

  // The account itself: deleting it, cancelling an order or a subscription.
  account: [
    "delete account", "delete my account", "close account", "deactivate account", "cancel order", "cancel subscription",
    "удалить аккаунт", "удалить учетную запись", "удалить профиль", "отменить заказ", "отменить подписку",
    "видалити акаунт", "видалити обліковий запис", "скасувати замовлення", "скасувати підписку",
    "konto löschen", "konto schließen", "bestellung stornieren", "abo kündigen", "kündigen",
    "supprimer le compte", "supprimer mon compte", "annuler la commande", "résilier",
    "eliminar cuenta", "eliminar mi cuenta", "cancelar pedido", "cancelar suscripción",
    "elimina account", "elimina il mio account", "annulla ordine", "annulla abbonamento", "disdici",
    "excluir conta", "cancelar pedido", "cancelar assinatura",
    "hesabı sil", "hesabımı sil", "siparişi iptal et", "aboneliği iptal et",
    "حذف الحساب", "إلغاء الطلب", "إلغاء الاشتراك",
    "アカウントを削除", "退会", "注文をキャンセル", "解約",
    "계정 삭제", "회원 탈퇴", "주문 취소", "구독 취소",
    "删除账户", "删除账号", "注销账号", "取消订单", "取消订阅",
    "刪除帳戶", "刪除帳號", "取消訂單", "取消訂閱",
    "xóa tài khoản", "hủy đơn hàng", "hủy đăng ký"
  ],

  // Signing in and up: passwords and codes are the person's (Safari AutoFill and Passwords).
  auth: [
    "log in", "login", "sign in", "sign up", "register", "create account", "create an account", "continue with google",
    "continue with apple", "sign in with google", "sign in with apple",
    "войти", "вход", "зарегистрироваться", "регистрация", "создать аккаунт", "создать учетную запись",
    "увійти", "вхід", "зареєструватися", "реєстрація", "створити акаунт",
    "anmelden", "einloggen", "registrieren", "konto erstellen",
    "se connecter", "connexion", "s'inscrire", "créer un compte",
    "iniciar sesión", "acceder", "registrarse", "crear cuenta", "crear una cuenta",
    "accedi", "registrati", "crea account", "crea un account",
    "entrar", "iniciar sessão", "cadastrar", "cadastre-se", "criar conta",
    "giriş yap", "oturum aç", "kayıt ol", "üye ol", "hesap oluştur",
    "تسجيل الدخول", "دخول", "إنشاء حساب", "تسجيل",
    "ログイン", "サインイン", "新規登録", "会員登録", "アカウント作成",
    "로그인", "회원가입", "가입하기",
    "登录", "注册", "创建账户",
    "登入", "註冊", "建立帳戶",
    "đăng nhập", "đăng ký", "tạo tài khoản"
  ],

  // Agreeing to terms, consent to data use, «Accept all» cookies: the person's own choice.
  consent: [
    "i agree", "=agree", "accept terms", "i accept", "accept and continue", "accept all", "allow all", "=accept",
    "accept cookies", "i consent",
    "согласен", "согласна", "принимаю", "принять условия", "принять все", "разрешить все", "даю согласие", "=принять",
    "погоджуюсь", "погоджуюся", "приймаю", "прийняти все", "дозволити все", "=прийняти",
    "ich stimme zu", "zustimmen", "akzeptieren", "alle akzeptieren", "alle zulassen", "einverstanden",
    "j'accepte", "accepter", "tout accepter", "autoriser tout", "accepter et continuer",
    "acepto", "aceptar", "aceptar todo", "aceptar todas", "permitir todo", "estoy de acuerdo",
    "accetto", "accetta", "accetta tutto", "accetta tutti", "consenti tutto",
    "aceito", "aceitar", "aceitar tudo", "aceitar todos", "permitir todos", "concordo",
    "kabul ediyorum", "kabul et", "tümünü kabul et", "hepsini kabul et", "onaylıyorum",
    "أوافق", "موافق", "قبول", "قبول الكل", "السماح للكل",
    "同意する", "同意", "すべて受け入れる", "すべて許可", "承諾",
    "동의", "동의합니다", "모두 수락", "모두 허용",
    "我同意", "接受", "全部接受", "接受全部",
    "đồng ý", "tôi đồng ý", "chấp nhận", "chấp nhận tất cả"
  ],

  // Sending a form that does something: a booking, a request, a subscription, the cart, deleting an item.
  submit: [
    "submit", "confirm", "book", "book now", "reserve", "apply now", "subscribe", "add to cart", "add to basket",
    "add to bag", "add to trolley", "remove", "delete", "request", "send request", "schedule", "make an appointment",
    "book appointment", "send application", "get a quote",
    "подтвердить", "забронировать", "бронировать", "записаться", "оставить заявку", "отправить заявку", "подписаться",
    "в корзину", "добавить в корзину", "удалить", "убрать", "заказать звонок", "отправить запрос", "записаться на прием",
    "підтвердити", "забронювати", "записатися", "залишити заявку", "надіслати заявку", "підписатися", "у кошик",
    "в кошик", "додати в кошик", "видалити", "прибрати", "надіслати запит",
    "bestätigen", "buchen", "jetzt buchen", "reservieren", "termin buchen", "anfragen", "anfrage senden",
    "abonnieren", "in den warenkorb", "zum warenkorb hinzufügen", "entfernen", "löschen",
    "confirmer", "valider", "réserver", "prendre rendez-vous", "s'abonner", "ajouter au panier", "supprimer",
    "retirer", "demander un devis", "envoyer la demande",
    "confirmar", "reservar", "pedir cita", "solicitar", "suscribirse", "añadir al carrito", "agregar al carrito",
    "añadir a la cesta", "eliminar", "quitar", "borrar", "enviar solicitud",
    "conferma", "prenota", "prenota ora", "richiedi", "iscriviti", "abbonati", "aggiungi al carrello", "rimuovi",
    "elimina", "invia richiesta",
    "confirmar", "reservar", "agendar", "solicitar", "inscrever-se", "assinar", "adicionar ao carrinho",
    "adicionar à sacola", "remover", "excluir", "apagar", "enviar solicitação",
    "onayla", "rezervasyon yap", "randevu al", "başvur", "abone ol", "sepete ekle", "kaldır", "sil", "talep gönder",
    "تأكيد", "أكد", "احجز", "حجز", "اشترك", "أضف إلى السلة", "إضافة إلى السلة", "إزالة", "حذف", "احذف", "قدم طلب",
    "確認する", "確定", "予約する", "予約", "申し込む", "申込", "カートに入れる", "カートに追加", "削除", "購読",
    "예약", "예약하기", "신청", "신청하기", "구독", "장바구니 담기", "장바구니에 추가", "삭제", "제거", "제출",
    "提交", "确认", "预订", "预约", "申请", "订阅", "加入购物车", "添加到购物车", "删除", "移除",
    "送出", "確認", "預訂", "預約", "申請", "訂閱", "加入購物車", "刪除",
    "xác nhận", "đặt chỗ", "đặt lịch", "đặt bàn", "đăng ký nhận tin", "gửi yêu cầu", "thêm vào giỏ",
    "thêm vào giỏ hàng", "xóa", "gỡ"
  ],

  // Words that do something only inside a form someone fills in («Apply» on a catalog's filters is free).
  weak: [
    "=ok", "save", "apply", "=done", "=yes",
    "сохранить", "применить", "=да", "=готово",
    "зберегти", "застосувати", "=так", "=готово",
    "speichern", "anwenden", "übernehmen", "=ja",
    "enregistrer", "appliquer", "=oui",
    "guardar", "aplicar", "=sí",
    "salva", "applica", "=sì",
    "salvar", "aplicar", "=sim",
    "kaydet", "uygula", "=evet", "=tamam",
    "حفظ", "تطبيق", "=نعم",
    "保存", "適用", "=はい", "=ok",
    "저장", "적용", "=확인", "=예",
    "保存", "应用", "=是", "=好",
    "儲存", "套用", "=是",
    "lưu", "áp dụng", "=có"
  ],

  // Going on through the site and looking: next, continue, the cart, the checkout page, more, search.
  nav: [
    "next", "continue", "proceed to checkout", "go to checkout", "checkout", "view cart", "go to cart", "view basket",
    "show more", "load more", "see more", "search", "back", "continue shopping", "next step",
    "далее", "продолжить", "перейти к оформлению", "к оформлению", "оформить", "перейти в корзину", "в корзину перейти",
    "показать еще", "показать больше", "загрузить еще", "найти", "поиск", "следующий шаг", "назад", "продолжить покупки",
    "далі", "продовжити", "до оформлення", "перейти до кошика", "перейти в кошик", "показати ще", "показати більше",
    "знайти", "пошук", "наступний крок", "назад",
    "weiter", "fortfahren", "zur kasse", "warenkorb anzeigen", "zum warenkorb", "mehr anzeigen", "mehr laden",
    "suchen", "zurück", "weiter einkaufen",
    "suivant", "continuer", "passer à la caisse", "voir le panier", "afficher plus", "voir plus", "rechercher",
    "retour", "continuer mes achats",
    "siguiente", "continuar", "seguir comprando", "ir a la caja", "ver carrito", "ir al carrito", "ver más",
    "mostrar más", "buscar", "volver",
    "avanti", "continua", "procedi", "vai alla cassa", "vai al carrello", "mostra altro", "carica altro", "cerca",
    "indietro", "continua lo shopping",
    "próximo", "continuar", "ir para o carrinho", "ver carrinho", "ver mais", "carregar mais", "buscar", "pesquisar",
    "voltar", "continuar comprando",
    "ileri", "devam", "devam et", "sepete git", "sepeti görüntüle", "daha fazla göster", "daha fazla", "ara", "geri",
    "alışverişe devam et",
    "التالي", "متابعة", "استمرار", "الذهاب إلى السلة", "عرض السلة", "عرض المزيد", "بحث", "رجوع",
    "次へ", "続ける", "レジに進む", "購入手続きへ", "カートを見る", "もっと見る", "検索", "戻る", "買い物を続ける",
    "다음", "계속", "계속하기", "장바구니 보기", "장바구니로 이동", "더 보기", "더보기", "검색", "뒤로", "쇼핑 계속하기",
    "下一步", "继续", "去结算", "结算", "查看购物车", "加载更多", "查看更多", "搜索", "返回", "继续购物",
    "繼續", "前往結帳", "查看購物車", "載入更多", "搜尋", "繼續購物",
    "tiếp theo", "tiếp tục", "đến giỏ hàng", "xem giỏ hàng", "xem thêm", "tải thêm", "tìm kiếm", "quay lại",
    "tiếp tục mua sắm"
  ],

  // In a cookie or consent dialog: refusing or keeping only what's needed (free: the privacy-minded choice).
  reject: [
    "reject all", "reject", "decline", "decline all", "only necessary", "necessary only", "essential only",
    "use necessary cookies only", "deny", "refuse all",
    "отклонить", "отклонить все", "только необходимые", "отказаться",
    "відхилити", "відхилити все", "лише необхідні", "тільки необхідні",
    "ablehnen", "alle ablehnen", "nur notwendige", "nur erforderliche", "nur essenzielle",
    "refuser", "tout refuser", "continuer sans accepter", "uniquement nécessaires",
    "rechazar", "rechazar todo", "solo necesarias", "solo las necesarias",
    "rifiuta", "rifiuta tutto", "solo necessari",
    "rejeitar", "recusar", "rejeitar tudo", "apenas necessários", "somente necessários",
    "reddet", "tümünü reddet", "yalnızca gerekli", "sadece gerekli",
    "رفض", "رفض الكل", "الضرورية فقط",
    "拒否", "すべて拒否", "必要なもののみ", "必須のみ",
    "거부", "모두 거부", "필수만",
    "拒绝", "全部拒绝", "仅必要", "不同意",
    "拒絕", "全部拒絕", "僅必要",
    "từ chối", "từ chối tất cả", "chỉ cần thiết"
  ]
}

// A dialog or banner is about cookies or consent when its words say so.
export const CONSENT_DIALOG = [
  "cookie", "cookies", "куки", "файлы cookie", "файли cookie", "çerez", "çerezler", "ملفات تعريف الارتباط",
  "クッキー", "쿠키", "consent", "согласие на обработку", "datenschutz", "privacy", "конфиденциальност", "gdpr"
]

/**
 * Fields the agent never reads or types into, by their label (besides their type and autocomplete, fields.ts):
 * passwords, cards, bank accounts, documents, national numbers, one-time codes, health.
 */
export const SECRET_FIELD = [
  // passwords and PINs
  "password", "passcode", "=pin", "pin code", "парол*", "пин-код", "passwort", "kennwort", "mot de passe",
  "contraseña", "parola", "senha", "şifre", "parola", "كلمة المرور", "كلمة السر", "パスワード", "暗証番号",
  "비밀번호", "密码", "密碼", "mật khẩu",
  // cards
  "card number", "credit card", "debit card", "cardholder", "expiry date", "expiration date", "=cvv", "=cvc", "cvv2",
  "cvc2", "security code", "card verification", "номер карты", "срок действия карты", "код безопасности", "cvv-код",
  "номер картки", "термін дії картки", "kartennummer", "prüfnummer", "kreditkarte", "numéro de carte", "cryptogramme",
  "date d'expiration", "número de tarjeta", "código de seguridad", "fecha de caducidad", "numero di carta",
  "codice di sicurezza", "data di scadenza", "número do cartão", "código de segurança", "data de validade",
  "kart numarası", "güvenlik kodu", "son kullanma tarihi", "رقم البطاقة", "رمز الأمان", "تاريخ الانتهاء", "カード番号",
  "セキュリティコード", "有効期限", "카드 번호", "카드번호", "보안 코드", "유효기간", "卡号", "安全码", "有效期", "卡號",
  "安全碼", "số thẻ", "mã bảo mật", "ngày hết hạn",
  // bank accounts
  "=iban", "iban", "=bic", "swift", "routing number", "account number", "sort code", "номер счета", "расчетный счет",
  "=бик", "номер рахунку", "kontonummer", "bankleitzahl", "numéro de compte", "número de cuenta", "numero di conto",
  "número da conta", "hesap numarası", "رقم الحساب", "口座番号", "계좌번호", "銀行帳號", "银行账号", "số tài khoản",
  // documents and national numbers
  "passport", "паспорт*", "reisepass", "passeport", "pasaporte", "passaporto", "passaporte", "pasaport", "جواز السفر",
  "パスポート", "여권", "护照", "護照", "hộ chiếu", "social security", "=ssn", "national insurance", "tax id",
  "taxpayer", "=инн", "=снилс", "=іпн", "рнокпп", "steuer-id", "steueridentifikationsnummer", "steuernummer",
  "personalausweis", "sécurité sociale", "=dni", "=nie", "=nif", "codice fiscale", "=cpf", "=rg", "tc kimlik",
  "kimlik no", "kimlik numarası", "الرقم القومي", "رقم الهوية", "マイナンバー", "주민등록번호", "身份证", "身分證",
  "=cccd", "=cmnd", "số căn cước", "driver's license", "driving licence", "водительское удостоверение",
  "посвідчення водія", "führerschein", "permis de conduire", "licencia de conducir", "patente di guida",
  "carteira de motorista", "ehliyet", "رخصة القيادة", "運転免許", "운전면허", "驾驶证", "駕照", "bằng lái",
  // one-time codes
  "one-time code", "verification code", "sms code", "otp", "2fa", "authentication code", "код из смс",
  "код подтверждения", "код из sms", "код підтвердження", "bestätigungscode", "code de vérification",
  "código de verificación", "codice di verifica", "código de verificação", "doğrulama kodu", "رمز التحقق",
  "認証コード", "確認コード", "인증번호", "확인 코드", "验证码", "驗證碼", "mã xác minh", "mã otp",
  // health
  "diagnosis", "medical condition", "allergies", "medication", "health insurance number", "диагноз", "аллерги*",
  "лекарств*", "діагноз", "алергі*", "diagnose", "allergien", "diagnostic", "allergies", "diagnóstico", "alergias",
  "diagnosi", "allergie", "teşhis", "alerji", "تشخيص", "حساسية", "診断", "アレルギー", "진단", "알레르기", "诊断",
  "过敏", "診斷", "過敏", "chẩn đoán", "dị ứng"
]

/** Personal fields: the model sees whether they're filled, never what's in them. */
export const PERSONAL_FIELD = [
  "name", "first name", "last name", "full name", "surname", "e-mail", "email", "phone", "mobile", "telephone",
  "address", "street", "city", "zip", "postal code", "postcode", "date of birth", "birthday", "birth date",
  "имя", "имени", "фамили*", "отчеств*", "фио", "почт*", "телефон*", "адрес*", "улиц*", "город", "индекс",
  "дата рождения", "ім'я", "прізвищ*", "по батькові", "пошт*", "телефон*", "адрес*", "вулиц*", "місто",
  "дата народження", "vorname", "nachname", "e-mail-adresse", "telefon", "anschrift", "straße", "stadt", "postleitzahl",
  "geburtsdatum", "prénom", "nom", "courriel", "téléphone", "adresse", "rue", "ville", "code postal",
  "date de naissance", "nombre", "apellido", "apellidos", "correo", "teléfono", "dirección", "calle", "ciudad",
  "código postal", "fecha de nacimiento", "nome", "cognome", "telefono", "indirizzo", "via", "città", "cap",
  "data di nascita", "sobrenome", "telefone", "endereço", "rua", "cidade", "cep", "data de nascimento", "ad", "soyad",
  "ad soyad", "e-posta", "adres", "şehir", "posta kodu", "doğum tarihi", "الاسم", "اسم", "البريد الإلكتروني", "الهاتف",
  "رقم الهاتف", "العنوان", "المدينة", "الرمز البريدي", "تاريخ الميلاد", "氏名", "名前", "=姓", "=名", "メールアドレス",
  "電話番号", "住所", "郵便番号", "生年月日", "이름", "성명", "이메일", "전화번호", "휴대폰", "주소", "우편번호", "생년월일",
  "姓名", "名字", "邮箱", "电子邮件", "电话", "手机", "地址", "邮编", "出生日期", "電子郵件", "電話", "手機", "郵遞區號",
  "họ tên", "tên", "họ", "số điện thoại", "điện thoại", "địa chỉ", "thành phố", "mã bưu điện", "ngày sinh"
]

/** A checkbox about terms, conditions, an offer or the use of personal data: the person ticks it. */
export const TERMS_BOX = [
  "terms", "conditions", "terms of service", "privacy policy", "personal data",
  "услови*", "оферт*", "политика конфиденциальности", "политики конфиденциальности", "политикой конфиденциальности", "персональных данных", "обработку данных",
  "умов*", "оферт*", "персональних даних",
  "bedingungen", "nutzungsbedingungen", "agb", "datenschutzerklärung", "ich stimme",
  "conditions générales", "cgu", "cgv", "politique de confidentialité", "données personnelles",
  "términos", "condiciones", "política de privacidad", "datos personales",
  "termini", "condizioni", "informativa sulla privacy", "dati personali",
  "termos", "condições", "política de privacidade", "dados pessoais",
  "koşul*", "şartlar*", "sözleşme*", "kvkk", "aydınlatma metni", "kişisel veri*",
  "الشروط", "شروط الخدمة", "سياسة الخصوصية", "البيانات الشخصية",
  "規約", "利用規約", "プライバシーポリシー", "個人情報",
  "약관", "개인정보", "이용약관",
  "条款", "服务条款", "隐私政策", "个人信息",
  "條款", "服務條款", "隱私權政策", "個人資料",
  "điều khoản", "chính sách bảo mật", "dữ liệu cá nhân"
]

// A day or a time the page shows as not choosable, in its own words (an aria-label «Sat 26, not available», a slot
// «Fully booked»): read on date and time controls only.
export const UNAVAILABLE_WORDS = [
  "not available", "unavailable", "fully booked", "booked up", "sold out", "no availability", "no times available", "no slots", "not bookable", "closed",
  "недоступ*", "нет мест", "мест нет", "нет свободн*", "всё занято", "все занято", "занято", "закрыто",
  "недоступн*", "немає місць", "немає вільн*", "зайнято", "зачинено",
  "nicht verfügbar", "ausgebucht", "keine verfügbarkeit", "keine termine", "belegt", "geschlossen",
  "indisponible", "non disponible", "complet", "aucune disponibilité", "fermé",
  "no disponible", "agotado", "completo", "sin disponibilidad", "cerrado",
  "non disponibile", "esaurito", "al completo", "nessuna disponibilità", "chiuso",
  "indisponível", "não disponível", "esgotado", "lotado", "sem disponibilidade", "fechado",
  "müsait değil", "uygun değil", "dolu", "tükendi", "kapalı",
  "غير متاح", "غير متوفر", "محجوز بالكامل", "لا توجد مواعيد", "مغلق",
  "予約不可", "満席", "空きなし", "受付終了", "定休日", "休業",
  "예약 불가", "예약불가", "마감", "매진", "휴무",
  "不可预订", "已约满", "约满", "已满", "无空位", "已售罄",
  "不可預訂", "已約滿", "約滿", "已滿", "無空位",
  "không có sẵn", "hết chỗ", "đã kín", "hết lịch", "đóng cửa"
]

// A booking page's cancellation terms («Free cancellation until …», «Non-refundable», «Условия отмены»): the first
// booking on a site that shows them gets a recap before its last press (2.7.1, B2).
export const CANCEL_TERMS_WORDS = [
  "cancellation*", "cancelation*", "non-refundable", "nonrefundable", "refundable", "cancel for free", "free cancel*",
  "бесплатная отмена", "бесплатной отмен*", "бесплатно отменить", "отменить бесплатно", "условия отмены", "правила отмены", "отмена брони", "отмена записи", "невозвратн*", "без возврата",
  "скасуван*", "безкоштовне скасування", "неповоротн*",
  "stornierung*", "storno*", "kostenlos stornier*", "nicht erstattbar",
  "annulation*", "non remboursable", "remboursable",
  "cancelación*", "cancelacion*", "no reembolsable", "reembolsable",
  "cancellazione*", "disdetta*", "non rimborsabile", "rimborsabile",
  "cancelamento*", "não reembolsável", "reembolsável",
  "iptal*", "iade edilmez", "ücretsiz iptal",
  "إلغاء", "الإلغاء", "غير قابل للاسترداد",
  "キャンセル", "返金不可",
  "취소", "환불 불가",
  "取消", "退款", "不可退",
  "hủy", "hoàn tiền", "không hoàn"
]

// A page naming its next free day or time («next available», «available from …»).
export const NEXT_FREE_WORDS = [
  "next available", "available from", "first available", "earliest available", "next opening",
  "ближайшее свободн*", "ближайший свободн*", "ближайшая свободн*", "ближайшее доступн*", "ближайшая доступн*", "свободно с", "доступно с",
  "найближчий вільн*", "найближча вільн*", "найближче вільн*", "найближча доступн*", "доступно з",
  "nächster freier termin", "nächste verfügbarkeit", "verfügbar ab",
  "prochaine disponibilité", "disponible à partir", "disponible dès",
  "próxima disponibilidad", "primera disponibilidad", "disponible desde",
  "prossima disponibilità", "disponibile dal", "disponibile da",
  "próxima disponibilidade", "disponível a partir",
  "en yakın müsait", "ilk müsait", "itibaren müsait",
  "أقرب موعد متاح", "متاح من",
  "次の空き", "最短",
  "다음 예약 가능", "가장 빠른",
  "下一个可预订", "最早可约",
  "下一個可預訂", "最早可約",
  "lịch trống tiếp theo", "có sẵn từ"
]

// Words of booking in another site's frame (its title, name or address): a reservation or appointment form.
export const BOOKING_WORDS = [
  "book*", "reserv*", "appointment*", "schedul*",
  "бронир*", "брониров*", "заброн*", "запис*", "резерв*",
  "бронюв*", "заброню*", "запис*",
  "buchen", "buchung*", "termin*", "reservierung*",
  "réserv*", "rendez-vous",
  "cita*", "agenda*",
  "prenot*",
  "agendament*", "marcaç*",
  "rezervasyon*", "randevu*",
  "حجز", "موعد",
  "予約",
  "예약",
  "预订", "预约",
  "預訂", "預約", "訂位",
  "đặt bàn", "đặt lịch", "đặt chỗ"
]

// What a count next to a total counts in a booking's or shop's summary bar («1 item», «2 услуги», «3 Artikel»).
export const CHOSEN_COUNT_WORDS = [
  "item*", "service*", "treatment*", "product*",
  "услуг*", "товар*", "позици*",
  "послуг*", "товар*", "позиці*",
  "artikel", "leistung*", "produkt*",
  "article*", "prestation*", "produit*",
  "artículo*", "servicio*", "producto*",
  "articol*", "serviz*", "prodott*",
  "itens", "item", "serviço*", "produto*",
  "ürün*", "hizmet*",
  "عنصر", "عناصر", "خدمة", "خدمات", "منتج*",
  "点", "件", "サービス",
  "개", "서비스", "상품",
  "项", "服务",
  "項", "服務",
  "sản phẩm", "dịch vụ", "mục"
]

// What a layer over the page that isn't the task is about: rewards and points, a newsletter, the site's app, a discount,
// notifications, the person's location (closed as a free step; cookie banners have their own closer).
export const PROMO_WORDS = [
  "newsletter", "subscribe to our", "rewards", "earn points", "collect points", "loyalty", "download the app", "download our app", "get the app", "open in app", "open the app", "use the app", "install the app", "% off", "discount code", "promo code", "coupon", "exclusive offer", "turn on notifications", "enable notifications", "allow notifications", "your location", "use my location", "share your location",
  "рассылк*", "подпишитесь", "бонус*", "балл*", "кешбэк", "скачайте приложение", "скачать приложение", "в приложении", "промокод", "скидк*", "уведомлени*", "геолокаци*", "местоположени*",
  "розсилк*", "бонус*", "бал*", "завантажте застосунок", "у застосунку", "промокод", "знижк*", "сповіщен*", "геолокаці*",
  "newsletter", "abonnieren", "prämien", "punkte sammeln", "treuepunkte", "app herunterladen", "in der app", "rabatt*", "gutschein*", "benachrichtigungen", "standort",
  "newsletter", "abonnez-vous", "récompenses", "points de fidélité", "cumulez des points", "télécharger l'application", "dans l'application", "réduction", "code promo", "notifications", "localisation", "votre position",
  "boletín", "suscríbete", "recompensas", "puntos", "descarga la app", "descargar la aplicación", "en la app", "descuento", "código promocional", "cupón", "notificaciones", "ubicación",
  "newsletter", "iscriviti", "premi", "punti fedeltà", "scarica l'app", "nell'app", "sconto", "codice promozionale", "coupon", "notifiche", "posizione",
  "newsletter", "inscreva-se", "recompensas", "pontos", "baixe o app", "baixar o aplicativo", "no app", "desconto", "cupom", "código promocional", "notificações", "localização",
  "bülten", "abone ol", "ödül*", "puan*", "uygulamayı indir", "uygulamada", "indirim*", "kupon", "promosyon kodu", "bildirim*", "konum*",
  "النشرة", "اشترك", "مكافآت", "نقاط", "حمّل التطبيق", "تنزيل التطبيق", "في التطبيق", "خصم", "كوبون", "رمز الترويج", "الإشعارات", "موقعك",
  "メルマガ", "ニュースレター", "ポイント", "アプリをダウンロード", "アプリで開く", "クーポン", "割引", "通知", "位置情報",
  "뉴스레터", "구독", "포인트", "적립", "앱 다운로드", "앱에서 열기", "쿠폰", "할인", "알림", "위치",
  "订阅", "积分", "奖励", "下载应用", "下载app", "在应用中打开", "优惠券", "折扣", "通知", "位置",
  "訂閱", "積分", "獎勵", "下載應用程式", "下載app", "在應用程式中開啟", "優惠券", "折扣", "通知", "位置",
  "bản tin", "đăng ký nhận", "phần thưởng", "tích điểm", "tải ứng dụng", "mở trong ứng dụng", "giảm giá", "mã khuyến mãi", "phiếu giảm giá", "thông báo", "vị trí"
]

// A control that closes such a layer without agreeing to anything: «Close», «Not now», «No thanks», «Skip», «Maybe later»,
// «Continue in the browser» (never «Accept», «Allow», «Subscribe», «Install», «Open the app»).
export const CLOSE_WORDS = [
  "=close", "=dismiss", "not now", "no thanks", "no, thanks", "=skip", "skip for now", "maybe later", "=later", "remind me later", "continue in browser", "continue on web", "stay on the website", "=×", "=✕", "=x", "close dialog", "close popup", "close modal",
  "=закрыть", "не сейчас", "нет, спасибо", "нет спасибо", "=пропустить", "=позже", "напомнить позже", "продолжить в браузере", "остаться на сайте",
  "=закрити", "не зараз", "ні, дякую", "=пропустити", "=пізніше", "продовжити в браузері",
  "=schließen", "nicht jetzt", "nein danke", "nein, danke", "=überspringen", "=später", "vielleicht später", "im browser fortfahren",
  "=fermer", "pas maintenant", "non merci", "non, merci", "=passer", "=ignorer", "plus tard", "continuer sur le navigateur",
  "=cerrar", "ahora no", "no gracias", "no, gracias", "=omitir", "=saltar", "más tarde", "continuar en el navegador",
  "=chiudi", "non ora", "no grazie", "no, grazie", "=salta", "più tardi", "continua nel browser",
  "=fechar", "agora não", "não, obrigado", "não obrigado", "=pular", "mais tarde", "continuar no navegador",
  "=kapat", "şimdi değil", "hayır teşekkürler", "hayır, teşekkürler", "=atla", "daha sonra", "tarayıcıda devam et",
  "=إغلاق", "ليس الآن", "لا شكرا", "لا، شكرا", "=تخطي", "لاحقا", "المتابعة في المتصفح",
  "=閉じる", "今はしない", "後で", "=スキップ", "ブラウザで続ける",
  "=닫기", "나중에", "=건너뛰기", "괜찮습니다", "브라우저로 계속",
  "=关闭", "以后再说", "=跳过", "不用了", "继续使用浏览器",
  "=關閉", "以後再說", "=跳過", "不用了", "繼續使用瀏覽器",
  "=đóng", "để sau", "=bỏ qua", "không, cảm ơn", "tiếp tục trên trình duyệt"
]

// A card the site puts first for money or by its own choice («Featured», «Sponsored», «Реклама»): never first for that.
export const PROMOTED_WORDS = [
  "featured", "sponsored", "promoted", "=ad", "advertisement",
  "реклама", "спонсор*", "продвигается",
  "реклама", "спонсор*",
  "gesponsert", "anzeige", "hervorgehoben",
  "sponsorisé", "à la une", "mis en avant",
  "patrocinado", "destacado", "anuncio",
  "sponsorizzato", "in evidenza",
  "patrocinado", "destaque", "anúncio",
  "sponsorlu", "öne çıkan", "reklam",
  "إعلان", "مُموَّل", "مميز",
  "広告", "pr", "スポンサー",
  "광고", "스폰서",
  "广告", "推广", "赞助",
  "廣告", "推廣", "贊助",
  "quảng cáo", "tài trợ", "nổi bật"
]
