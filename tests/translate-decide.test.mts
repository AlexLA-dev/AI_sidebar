// 2.7, a page translated in place: whether the pill offers it. The page's text decides when it's clear (`<html lang>` is
// often a template's default); its markup when the guess is weak or shares its letters or words with a neighbour
// (Bulgarian in Cyrillic, Persian in Arabic script, Danish and Norwegian). Too few words: no offer.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let pageLanguage: (htmlLang: string, text: string) => string | null
let offerFor: (pageLang: string | null, ui: string, letters: number) => boolean

before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-decide-")), "decide.mjs")
  await build({ entryPoints: [new URL("../src/content/translate/decide.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  ;({ pageLanguage, offerFor } = await import(pathToFileURL(out).href))
})

const DE = "Die Stadt hat am Montag die neue Brücke über den Fluss eröffnet. Sie ist nicht nur für Autos, sondern auch für Radfahrer und die Fußgänger gedacht."
const EN = "The city opened the new bridge over the river on Monday. It is not only for cars, but also for cyclists and people on foot."
const IT = "Il comune ha aperto il nuovo ponte sul fiume lunedì. Non è solo per le auto, ma anche per chi va in bici e per i pedoni che lo usano."
const TR = "Belediye pazartesi günü nehir üzerindeki yeni köprüyü açtı. Köprü sadece arabalar için değil, bisikletliler ve yayalar için de yapıldı."
const ZH = "市政府星期一开通了河上的新桥。这座桥不仅供汽车通行，也供骑自行车的人和行人使用。"
const LT = "Vyriausybė šiandien pristatė naują mokesčių įstatymo projektą. Pasak ministro, tai svarbus žingsnis, kuris turėtų padėti mažoms įmonėms ir šeimoms su vaikais. Opozicija teigia, kad pakeitimai nėra gerai paruošti, todėl jų priėmimas užtruks ilgiau nei planuota pradžioje."
const AZ = "Bu gün paytaxtda yeni metro stansiyası açıldı. Nazirliyin məlumatına görə, stansiya gündə on min sərnişinə xidmət edəcək və şəhərin şimal hissəsini mərkəzlə birləşdirəcək. Sakinlər bu xəbəri sevinclə qarşıladılar, lakin bəziləri qiymətlərin artacağından narahatdır."
const NB = "Regjeringen la i dag fram en ny plan for å bygge flere boliger i Oslo. Ifølge statsråden er det et viktig steg for å redusere boligmangelen, men kritikerne mener at det ikke er nok, og at prisene vil fortsette å stige for de som vil kjøpe en leilighet av egen lomme."
const RU_KYIV = "Министр иностранных дел заявил, что переговоры продолжатся на следующей неделе. По его словам, делегации встретятся в столице, а официальные заявления будут сделаны после окончания встречи. Местные СМИ со ссылкой на источник в Київській міській раді сообщили, что встреча может пройти в закрытом режиме и продлится несколько дней."
const UK = "Міністр закордонних справ заявив, що переговори продовжаться наступного тижня. За його словами, делегації зустрінуться в столиці, а офіційні заяви зроблять після завершення зустрічі."
const BG = "Общината откри новия мост над реката в понеделник. Той е не само за коли, но и за велосипедисти и пешеходци."

test("the text decides when it's clear, whatever the markup says", () => {
  assert.equal(pageLanguage("en", DE), "de", "a German page left at the template's lang=en")
  assert.equal(pageLanguage("", IT), "it")
  assert.equal(pageLanguage("de-DE", EN), "en")
  assert.equal(pageLanguage("zh-CN", ZH), "zh")
})

test("the markup decides when the text can't tell, or shares its letters with another language", () => {
  assert.equal(pageLanguage("tr", TR), "tr")
  assert.equal(pageLanguage("bg", BG), "bg")
  assert.equal(pageLanguage("ru", BG), "ru")
  assert.equal(pageLanguage("", LT), null, "neither tells: a language the guess has no words for, no markup")
  assert.equal(pageLanguage("x-klingon", LT), null)
  assert.equal(pageLanguage("lt", LT), "lt", "a weak guess gives way to the markup")
  assert.equal(pageLanguage("az", AZ), "az", "Azerbaijani reads as Turkish, its neighbour: the markup says which")
  assert.equal(pageLanguage("no", NB), "nb", "the old code for Norwegian")
})

// The director's audit (2.7, «чтобы все новые функции работали одинаково хорошо для всех»): pages in languages beyond
// the panel's six, each read by its own reader. Before, Turkish, Czech and Hungarian came out as Portuguese, Dutch,
// Swedish and Catalan as Spanish, Romanian as Vietnamese, and their readers were offered a translation into their own
// language on every page.
const PAGES: Record<string, string> = {
  tr: "Bu hafta sonu İstanbul'da yağmur bekleniyor. Meteoroloji uzmanları, sıcaklıkların da düşeceğini ve vatandaşların dikkatli olması gerektiğini söyledi. Belediye ise yollarda ek önlemler aldığını açıkladı. Ulaşımda aksama olabilir, o yüzden erken çıkmanızı öneriyoruz. Bir de hafta içi yeni bir yağış dalgası da gelebilir.",
  nl: "De gemeente heeft besloten om het nieuwe zwembad toch te bouwen. Volgens de wethouder is het een belangrijke stap voor de wijk en zal het in het voorjaar open gaan. Bewoners zijn blij, maar er zijn ook zorgen over de kosten van het project en de drukte op de weg.",
  pl: "W tym tygodniu rząd przedstawił nowy projekt ustawy o podatkach. Według ministra to ważny krok, który ma pomóc małym firmom. Opozycja twierdzi jednak, że zmiany nie są dobrze przygotowane i że to tylko obietnice przed wyborami. Na razie nie wiadomo, kiedy projekt trafi do Sejmu.",
  id: "Pemerintah mengumumkan bahwa harga bahan bakar akan naik mulai bulan depan. Menurut menteri, keputusan ini diambil untuk menjaga anggaran negara. Banyak warga di kota besar khawatir dengan dampaknya terhadap harga makanan dan transportasi umum yang mereka gunakan setiap hari.",
  sv: "Regeringen har presenterat en ny plan för att bygga fler bostäder i Stockholm. Enligt ministern är det ett viktigt steg för att minska bostadsbristen, men kritiker menar att det inte räcker och att priserna fortsätter att stiga för de som vill köpa en lägenhet.",
  cs: "Vláda dnes schválila nový zákon o daních. Podle ministra jde o důležitý krok, který má pomoci malým firmám a rodinám s dětmi. Opozice však tvrdí, že změny nejsou dobře připravené a že to jsou jen sliby před volbami. Zatím není jasné, kdy zákon začne platit.",
  ro: "Guvernul a anunțat că prețul energiei va scădea de la începutul anului viitor. Potrivit ministrului, decizia este un pas important pentru familiile cu venituri mici. Opoziția spune însă că măsura nu este suficientă și că facturile vor rămâne mari pentru cei mai mulți oameni.",
  hu: "A kormány bejelentette, hogy jövő hónaptól csökken az energia ára. A miniszter szerint ez fontos lépés a családok számára, de az ellenzék szerint a döntés nem elég, és a számlák továbbra is magasak maradnak a legtöbb ember számára az országban.",
  ca: "El govern ha anunciat que el preu de l'energia baixarà a partir de l'any vinent. Segons el ministre, és un pas important per a les famílies, però l'oposició diu que la mesura no és suficient i que les factures continuaran sent altes per a la majoria de la gent.",
  tr2: "Yeni telefon modeli bu ay satışa çıkıyor. Şirketin açıklamasına göre fiyatı geçen yılki modelden daha düşük olacak ve pil ömrü de uzayacak. Uzmanlar ise bu kararın rekabeti artıracağını ve diğer markaların da fiyat indirimine gidebileceğini düşünüyor."
}

test("a page in a language beyond the panel's six is read as itself, and its reader isn't offered their own", () => {
  for (const [key, text] of Object.entries(PAGES)) {
    const lang = key.replace(/\d$/, "")
    assert.equal(pageLanguage(lang, text), lang, `${key}, marked`)
    assert.equal(pageLanguage("en", text), lang, `${key}, left at the template's lang=en`)
    assert.equal(pageLanguage("", text), lang, `${key}, no markup`)
    assert.equal(offerFor(pageLanguage(lang, text), lang, 400), false, `${key}: its own reader`)
    assert.equal(offerFor(pageLanguage(lang, text), "en", 400), true, `${key}: an English reader`)
  }
  // The panel's own languages stay as they were.
  assert.equal(pageLanguage("en", DE), "de")
  assert.equal(pageLanguage("", IT), "it")
})

test("a Russian article naming a Ukrainian place is Russian; a Ukrainian one is Ukrainian", () => {
  assert.equal(pageLanguage("ru", RU_KYIV), "ru")
  assert.equal(pageLanguage("", RU_KYIV), "ru")
  assert.equal(offerFor(pageLanguage("ru", RU_KYIV), "ru", 400), false)
  assert.equal(pageLanguage("", UK), "uk")
  assert.equal(offerFor(pageLanguage("uk", UK), "uk", 400), false)
})

test("offered on a page in another language with enough words; never in the person's own", () => {
  assert.equal(offerFor("de", "ru", 400), true)
  assert.equal(offerFor("ru", "ru", 400), false)
  assert.equal(offerFor("zh", "zh", 400), false, "Traditional Chinese reader on a Simplified page: the same language")
  assert.equal(offerFor("de", "ru", 40), false, "a sign-in form, a gallery")
  assert.equal(offerFor(null, "ru", 4000), false)
})
