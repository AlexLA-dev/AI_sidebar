// Meaning results and the message each opens at (tests/meaning-spot.test.mts; the app's side: meaning-spot-parity).
// One chat per shipped language: a question about the four-day week, one about coffee and sleep, one about dinner;
// the description and the server's "why" are about coffee and sleep. `expect`: the message's index (null: the end).
export type SpotCase = { name: string; texts: string[]; query: string; why: string; expect: number | null }

const chat = (q1: string, a1: string, q2: string, a2: string, q3: string, a3: string) => [q1, a1, q2, a2, q3, a3]

export const CASES: SpotCase[] = [
  { name: "en", texts: chat("Summarize\nWhy the four-day week works", "In short: 61 companies cut hours by 20%; burnout fell and revenue held.", "Does coffee after 4 pm hurt sleep?\nCoffee and sleep", "Caffeine has a half-life of about 5 hours, so a 4 pm coffee can delay sleep.", "Recipe for a quick dinner?\nPasta in 15 minutes", "Boil pasta, add garlic, olive oil and chili."),
    query: "the article about sleep and coffee", why: "You asked whether coffee in the afternoon hurts sleep.", expect: 2 },
  { name: "ru", texts: chat("Кратко\nПочему четырёхдневка работает", "Коротко: 61 компания сократила неделю на 20%, выгорание упало.", "Кофе после 16:00 мешает сну?\nКофе и сон", "Период полувыведения кофеина — около 5 часов, так что кофе в 16:00 может сдвинуть сон.", "Рецепт быстрого ужина?\nПаста за 15 минут", "Сварите пасту, добавьте чеснок, масло и перец чили."),
    query: "статья про сон и кофе", why: "Вы спрашивали, мешает ли кофе после обеда сну.", expect: 2 },
  { name: "uk", texts: chat("Коротко\nЧому чотириденка працює", "Коротко: 61 компанія скоротила тиждень на 20%.", "Кава після 16:00 заважає сну?\nКава і сон", "Період напіввиведення кофеїну — близько 5 годин, тож кава о 16:00 може зсунути сон.", "Рецепт швидкої вечері?\nПаста за 15 хвилин", "Зваріть пасту, додайте часник і олію."),
    query: "стаття про сон і каву", why: "Ви питали, чи заважає кава після обіду сну.", expect: 2 },
  { name: "de", texts: chat("Zusammenfassen\nWarum die Viertagewoche funktioniert", "Kurz: 61 Firmen kürzten die Woche um 20 %.", "Stört Kaffee nach 16 Uhr den Schlaf?\nKaffee und Schlaf", "Koffein hat eine Halbwertszeit von etwa 5 Stunden, Kaffee um 16 Uhr kann den Schlaf verschieben.", "Rezept für ein schnelles Abendessen?\nPasta in 15 Minuten", "Pasta kochen, Knoblauch und Öl dazugeben."),
    query: "der Artikel über Schlaf und Kaffee", why: "Du hast gefragt, ob Kaffee am Nachmittag den Schlaf stört.", expect: 2 },
  { name: "fr", texts: chat("Résumer\nPourquoi la semaine de quatre jours marche", "En bref : 61 entreprises ont réduit la semaine de 20 %.", "Le café après 16 h nuit-il au sommeil ?\nCafé et sommeil", "La caféine a une demi-vie d’environ 5 heures : un café à 16 h peut retarder le sommeil.", "Recette de dîner rapide ?\nPâtes en 15 minutes", "Faites cuire les pâtes, ajoutez ail et huile."),
    query: "l’article sur le sommeil et le cafe", why: "Vous avez demandé si le café de l’après-midi nuit au sommeil.", expect: 2 },
  { name: "es", texts: chat("Resumir\nPor qué funciona la semana de cuatro días", "En resumen: 61 empresas recortaron la semana un 20 %.", "¿El café después de las 16:00 afecta al sueño?\nCafé y sueño", "La cafeína tiene una vida media de unas 5 horas: un café a las 16:00 puede retrasar el sueño.", "¿Receta de cena rápida?\nPasta en 15 minutos", "Hierve la pasta, añade ajo y aceite."),
    query: "el artículo sobre el sueño y el cafe", why: "Preguntaste si el café de la tarde afecta al sueño.", expect: 2 },
  { name: "it", texts: chat("Riassumi\nPerché la settimana di quattro giorni funziona", "In breve: 61 aziende hanno ridotto la settimana del 20%.", "Il caffè dopo le 16 disturba il sonno?\nCaffè e sonno", "La caffeina ha un'emivita di circa 5 ore: un caffè alle 16 può ritardare il sonno.", "Ricetta per una cena veloce?\nPasta in 15 minuti", "Cuoci la pasta, aggiungi aglio e olio."),
    query: "l'articolo su sonno e caffè", why: "Hai chiesto se il caffè del pomeriggio disturba il sonno.", expect: 2 },
  { name: "pt-BR", texts: chat("Resumir\nPor que a semana de quatro dias funciona", "Em resumo: 61 empresas cortaram a semana em 20%.", "Café depois das 16h atrapalha o sono?\nCafé e sono", "A cafeína tem meia-vida de cerca de 5 horas: um café às 16h pode atrasar o sono.", "Receita de jantar rápido?\nMacarrão em 15 minutos", "Cozinhe o macarrão, junte alho e azeite."),
    query: "o artigo sobre sono e cafe", why: "Você perguntou se café à tarde atrapalha o sono.", expect: 2 },
  { name: "ja", texts: chat("要約\n週休3日制がうまくいく理由", "要するに、61社が労働時間を20%減らしました。", "午後4時以降のコーヒーは睡眠に悪い？\nコーヒーと睡眠", "カフェインの半減期は約5時間なので、午後4時のコーヒーは睡眠を遅らせます。", "簡単な夕食のレシピは？\n15分パスタ", "パスタをゆでて、にんにくとオイルを加えます。"),
    query: "睡眠とコーヒーの記事", why: "午後のコーヒーが睡眠に悪いか質問していました。", expect: 2 },
  { name: "ko", texts: chat("요약\n주 4일제가 효과적인 이유", "요약하면 61개 회사가 근무 시간을 20% 줄였습니다.", "오후 4시 이후 커피가 수면에 나쁜가요?\n커피와 수면", "카페인의 반감기는 약 5시간이라 오후 4시 커피는 수면을 늦출 수 있습니다.", "빠른 저녁 레시피?\n15분 파스타", "파스타를 삶고 마늘과 오일을 넣으세요."),
    query: "수면과 커피에 관한 기사", why: "오후의 커피가 수면에 나쁜지 물었습니다.", expect: 2 },
  { name: "zh-Hans", texts: chat("总结\n为什么四天工作制有效", "简而言之：61家公司把工时缩短了20%。", "下午4点后喝咖啡会影响睡眠吗？\n咖啡与睡眠", "咖啡因的半衰期约为5小时，下午4点的咖啡可能推迟睡眠。", "快手晚餐食谱？\n15分钟意面", "煮好意面，加入大蒜和橄榄油。"),
    query: "关于睡眠和咖啡的文章", why: "你问过下午喝咖啡是否影响睡眠。", expect: 2 },
  { name: "zh-Hant", texts: chat("摘要\n為什麼四天工作制有效", "簡而言之：61家公司把工時縮短了20%。", "下午4點後喝咖啡會影響睡眠嗎？\n咖啡與睡眠", "咖啡因的半衰期約為5小時，下午4點的咖啡可能延後睡眠。", "快速晚餐食譜？\n15分鐘義大利麵", "煮好義大利麵，加入大蒜和橄欖油。"),
    query: "關於睡眠和咖啡的文章", why: "你問過下午喝咖啡是否影響睡眠。", expect: 2 },
  { name: "vi", texts: chat("Tóm tắt\nVì sao tuần làm việc bốn ngày hiệu quả", "Tóm lại: 61 công ty đã cắt giảm 20% giờ làm.", "Uống cà phê sau 4 giờ chiều có hại giấc ngủ không?\nCà phê và giấc ngủ", "Caffeine có thời gian bán thải khoảng 5 giờ, nên cà phê lúc 4 giờ chiều có thể làm chậm giấc ngủ.", "Công thức bữa tối nhanh?\nMì Ý 15 phút", "Luộc mì, thêm tỏi và dầu ô liu."),
    query: "bài viết về giấc ngủ và ca phe", why: "Bạn đã hỏi cà phê buổi chiều có hại giấc ngủ không.", expect: 2 },
  { name: "ar", texts: chat("لخّص\nلماذا ينجح أسبوع العمل من أربعة أيام", "باختصار: خفّضت 61 شركة ساعات العمل بنسبة 20%.", "هل تضر القهوة بعد الرابعة عصرًا بالنوم؟\nالقهوة والنوم", "عمر النصف للكافيين نحو 5 ساعات، لذا قد تؤخر قهوة الرابعة النوم.", "وصفة عشاء سريعة؟\nمعكرونة في 15 دقيقة", "اسلق المعكرونة وأضف الثوم والزيت."),
    query: "المقال عن النوم والقهوة", why: "سألت إن كانت قهوة العصر تضر بالنوم.", expect: 2 },
  // Nothing in common: the chat opens at its end, as before.
  { name: "nothing shared", texts: chat("Summarize\nWhy the four-day week works", "In short: 61 companies cut hours by 20%.", "Recipe for a quick dinner?\nPasta in 15 minutes", "Boil pasta, add garlic.", "Best hiking boots?\nBoots", "Look for a stiff sole."),
    query: "the article about sleep and coffee", why: "About caffeine late in the day.", expect: null },
  // Only words every message has: not a message of its own (the end).
  { name: "common words only", texts: ["what about the week", "the week about what", "about the week what"], query: "what about the week", why: "", expect: null },
  // A tie: the earlier message.
  { name: "a tie", texts: ["coffee notes", "pasta", "coffee notes", "bread"], query: "coffee", why: "", expect: 0 },
  // A short word alone ("the" in one message) picks nothing; with a longer one it adds.
  { name: "a short word alone", texts: ["the plan", "pasta", "bread", "rice"], query: "the", why: "", expect: null }
]
