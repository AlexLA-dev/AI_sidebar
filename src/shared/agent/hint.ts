// «Сделать на этой странице?» (2.7.1, the design: «Если обычный вопрос звучит как просьба действовать, под ним появляется
// подсказка»): an ordinary question that asks for an action — it starts with a verb that does something on a page
// («добавь…», «выбери…», «book…», «füge … hinzu») — gets a chip under it that hands it to the agent. The agent never
// starts without that tap. Words in the 15 languages of the panel.

// Word starts (the request's first word or the one after «пожалуйста»/«please»), per language.
const STARTS = [
  // ru, uk
  "добав", "полож", "полож", "выбер", "заполн", "нажм", "забронир", "запиш", "отметь", "постав", "внес", "впиш", "закаж",
  "забук", "купи", "оформ", "зарегистр", "подбер",
  "дода", "поклад", "вибер", "запов", "натисн", "заброн", "відміт",
  // en
  "add", "put", "select", "choose", "fill", "click", "press", "book", "reserve", "tick", "set", "schedule", "sign", "order", "buy", "register",
  // de
  "füg", "leg", "wähl", "füll", "klick", "drück", "buch", "reservier", "trag", "setz", "bestell", "kauf", "meld",
  // fr
  "ajout", "mets", "choisi", "sélectionn", "rempli", "cliqu", "appui", "réserv", "inscri", "coche",
  // es, pt, it
  "añad", "agreg", "pon", "elig", "seleccion", "rellen", "llen", "puls", "reserv", "apúnt", "marc",
  "adicion", "coloqu", "coloca", "escolh", "selecion", "preench", "cliqu", "apert", "agend",
  "aggiung", "mett", "scegl", "selezion", "compil", "clicc", "prenot", "iscriv", "segn",
  // vi
  "thêm", "chọn", "điền", "bấm", "nhấn", "đặt"
]
// Languages without spaces between words, and Arabic: the verb anywhere in the request.
const ANYWHERE = [
  "追加して", "入れて", "選んで", "選択して", "入力して", "押して", "予約して", "記入して",
  "추가해", "담아", "선택해", "입력해", "눌러", "예약해",
  "添加", "加入购物车", "加入購物車", "选择", "選擇", "填写", "填寫", "点击", "點擊", "预订", "預訂", "预约", "預約",
  "أضف", "اختر", "املأ", "اضغط", "احجز"
]
// Turkish puts the verb last («Sepete ekle»): its stems are matched on the last word.
const LAST = ["ekle", "seç", "doldur", "tıkla", "bas", "rezervasyon", "ayırt", "işaretle"]
// A booking or ordering verb as an order anywhere in the request («найди барбера и забронируй на субботу», «can you
// book…»): whole words only, so «booking policy» isn't one.
const ORDER_WORDS = new Set([
  "забронируй", "забронируйте", "забукай", "забукайте", "запиши", "запишите", "закажи", "закажите", "купи", "оформи",
  "забронюй", "замов", "book", "reserve", "order", "buche", "reserviere", "bestelle", "réserve", "réservez", "commande",
  "reserva", "reserve", "prenota", "agende", "đặt"
])
const POLITE = new Set(["пожалуйста", "можешь", "можете", "могли", "бы", "можно", "please", "bitte", "por", "favor", "per", "s'il", "lütfen", "будь", "ласка", "hãy", "vui", "lòng", "can", "could", "you"])

export function asksForAction(text: string): boolean {
  const s = text.normalize("NFC").trim().toLowerCase()
  if (!s || s.length > 400 || s.endsWith("?") && !/^((can|could) you|(можешь|можете|могли бы|можно)\s)/.test(s)) return false
  if (ANYWHERE.some((w) => s.includes(w))) return true
  const words = s.split(/[^\p{L}']+/u).filter(Boolean)
  if (words.some((w) => ORDER_WORDS.has(w))) return true
  const last = words[words.length - 1]
  if (last && LAST.some((stem) => last.startsWith(stem) && last.length <= stem.length + 4)) return true
  const first = words.find((w) => !POLITE.has(w))
  return !!first && first.length >= 2 && STARTS.some((stem) => first.startsWith(stem) && (stem.length >= 4 || first.length <= stem.length + 4))
}
