// 2.7, the director's audit: every feature works alike in every language. A text's topic words (src/shared/words.ts)
// drop function words and read Chinese, Japanese and Korean by pairs of characters; the matching chat (match.ts) and
// «В подборку» by words (collections.ts suggestPlace; the app's Board.suggest via TopicWords.swift) both use them.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { addCard, addSection, COLLECTION_PREFIX, newCollection, suggestPlace } from "../src/shared/collections.ts"
import { titleTopic, wordMatch } from "../src/shared/match.ts"
import type { Thread } from "../src/shared/threads.ts"
import { NAME_STOP, TOPIC_EXTRA, topicWords } from "../src/shared/words.ts"

const words = (text: string) => [...topicWords(text)]

test("function words don't count, in the alphabet languages", () => {
  assert.deepEqual(words("What is the best way to learn Swift?"), ["best", "way", "learn", "swift"])
  assert.deepEqual(words("Что посмотреть в Киото для детей"), ["посмотреть", "киото", "детеи"])
  assert.deepEqual(words("Los mejores restaurantes de Madrid"), ["mejores", "restaurantes", "madrid"])
  assert.deepEqual(words("Warum die Viertagewoche funktioniert"), ["viertagewoche", "funktioniert"])
  assert.deepEqual(words("Pourquoi la semaine de quatre jours marche"), ["semaine", "quatre", "jours", "marche"])
  assert.deepEqual(words("كيف تختار أفضل قهوة"), ["تختار", "افضل", "قهوة"])
  // Numbers alone aren't topics; a model's name with its number is.
  assert.deepEqual(words("iPhone15 2026"), ["iphone15"])
})

test("Chinese and Japanese by pairs of characters, Korean by its words' syllables without the particle", () => {
  // Hiragana is Japanese grammar: «東京の天気» is Tokyo and weather, not «京の», «の天».
  assert.deepEqual(words("東京の天気"), ["東京", "天気"])
  // A character alone is a word too (rain).
  assert.deepEqual(words("東京の雨"), ["東京", "雨"])
  assert.deepEqual(words("iPhone15の価格を比較する"), ["iphone15", "価格", "比較"])
  assert.deepEqual(words("コーヒーの淹れ方"), ["コー", "ーヒ", "ヒー", "淹", "方"])
  // Chinese grammar words part the words around them.
  assert.deepEqual(words("北京的天气"), ["北京", "天气"])
  assert.deepEqual(words("如何评价苹果"), ["评价", "价苹", "苹果"])
  assert.deepEqual(words("我的猫"), ["猫"])
  // Two-syllable Korean words count (they were under the three letters before); «서울의» is «서울».
  assert.deepEqual(words("서울의 날씨 예보"), ["서울", "날씨", "예보"])
  assert.deepEqual(words("부산에서 냉면 먹기"), ["부산", "냉면", "먹기"])
  assert.deepEqual(words("교토 여행은 어떻게"), ["교토", "여행"])
})

test("the matching chat: a title's site goes after an unspaced separator too; function words don't dilute the 85 %", () => {
  assert.equal(titleTopic("東京の天気｜tenki.jp"), "東京の天気")
  assert.equal(titleTopic("東京の天気 ｜ tenki.jp"), "東京の天気")
  assert.equal(titleTopic("苹果发布新款iPhone_新浪科技"), "苹果发布新款iPhone")
  assert.equal(titleTopic("Errors|Paystack API Reference"), "Errors")
  // A Latin underscore is a name's ("read_file"), not a separator.
  assert.equal(titleTopic("read_file in Python"), "read_file in Python")
  assert.equal(titleTopic("Kyoto temples – Japan Guide"), "Kyoto temples")

  let t = 0
  const chat = (question: string, url: string, title: string): Thread => ({
    id: "c", u: 1, a: 1,
    m: [{ role: "user", content: question, t: ++t, id: `q${t}`, page: { url, title, hash: "h", at: t } }, { role: "assistant", content: "…", t: ++t, id: `a${t}` }]
  })
  const ja = chat("東京の天気は？", "https://weather.example/tokyo", "東京の天気 - 日本気象協会")
  // Before: «東京の天気｜tenki.jp» kept «tenki» and the pairs over «の»: 80 %, a new chat.
  assert.equal(wordMatch("東京の天気｜tenki.jp", ja), 100)
  const zh = chat("苹果新款iPhone值得买吗", "https://zhihu.example/q/1", "苹果发布新款iPhone - 知乎")
  assert.equal(wordMatch("苹果发布新款iPhone_新浪科技", zh), 100)
  const ko = chat("서울 날씨 예보", "https://weather.example/seoul", "서울 날씨")
  assert.equal(wordMatch("서울의 날씨 예보 - 네이버", ko), 100)
  // Function words: «how», «for», «the»; «что», «для»; «los», «de» counted against the chat before.
  assert.equal(wordMatch("How to cook rice for the family | Food Blog", chat("cook rice family", "https://a.example/1", "Rice")), 100)
  assert.equal(wordMatch("Что приготовить на ужин для детей", chat("приготовить ужин детей", "https://a.example/2", "Ужин")), 100)
  assert.equal(wordMatch("Los mejores restaurantes de Madrid", chat("mejores restaurantes Madrid", "https://a.example/3", "Madrid")), 100)
  // And still not a match for another topic.
  assert.ok(wordMatch("東京の地下鉄の路線図", ja) < 85)
  assert.ok(wordMatch("北京的天气预报", zh) < 85)
})

test("«В подборку» by words finds the section in Japanese, Chinese and Korean (not the first one by default)", () => {
  let n = 0
  const card = (sec: string, t: string) => ({ id: `k${++n}`, sec, k: "answer" as const, t, at: 1_000 + n })
  const make = (id: string, name: string, first: [string, string], second: [string, string], cards: Array<[string, string]>) => {
    let c = newCollection(`${COLLECTION_PREFIX}${id}`, name, undefined, 1_000, { id: first[0], name: first[1] })
    c = addSection(c, second[0], second[1], 1_001)
    for (const [sec, t] of cards) c = addCard(c, card(sec, t), 1_002 + n)
    return c
  }
  const ja = make("ja", "日本旅行", ["move", "交通"], ["stay", "ホテル"], [["move", "東京の地下鉄は路線が多い。"], ["stay", "浅草のホテルは静かで安い。"]])
  const zh = make("zh", "北京旅行", ["move", "交通"], ["food", "美食"], [["move", "地铁比出租车快。"], ["food", "前门的烤鸭最好吃。"]])
  const ko = make("ko", "서울 여행", ["move", "교통"], ["food", "맛집"], [["move", "지하철 노선이 많다."], ["food", "명동 냉면 맛집은 줄이 길다."]])
  const all = [ja, zh, ko]
  const at = (t: string, title?: string) => {
    const p = suggestPlace(all, { t, ...(title ? { src: { title } } : {}) })
    return [p?.collection, p?.section]
  }
  assert.deepEqual(at("新宿のホテルは便利で高い。"), [ja.id, "stay"])
  assert.deepEqual(at("王府井的烤鸭店推荐"), [zh.id, "food"])
  assert.deepEqual(at("명동에서 냉면 먹기"), [ko.id, "food"])
  assert.deepEqual(at("地下鉄の一日券", "東京メトロ"), [ja.id, "move"])
})

test("the app has the panel's function words (TopicWords.swift = words.ts), and organizing's names share them", () => {
  const swift = readFileSync(new URL("../ContextFlow/Shared (App)/TopicWords.swift", import.meta.url), "utf8")
  const strings = (src: string) => [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  for (const [key, list] of Object.entries(TOPIC_EXTRA)) {
    const m = swift.match(new RegExp(`"${key}": \\[([^\\]]*)\\]`))
    assert.ok(m, `topicExtra ${key}`)
    assert.deepEqual(strings(m[1]), list, `topicExtra ${key}`)
  }
  const names: Record<keyof typeof NAME_STOP, string> = { latin: "Latin", vi: "Vi", cyrillic: "Cyrillic", arabic: "Arabic", hangul: "Hangul" }
  for (const [key, name] of Object.entries(names) as Array<[keyof typeof NAME_STOP, string]>) {
    const m = swift.match(new RegExp(`static let nameStop${name}: Set<String> = \\[([^\\]]*)\\]`))
    assert.ok(m, `nameStop${name}`)
    assert.deepEqual([...new Set(strings(m[1]))], [...NAME_STOP[key]], `nameStop${name}`)
  }
  const organize = readFileSync(new URL("../ContextFlow/Shared (App)/Organize.swift", import.meta.url), "utf8")
  for (const name of Object.values(names)) assert.match(organize, new RegExp(`nameStop${name} = TopicWords\\.nameStop${name}`))
  assert.match(organize, /koParticles = TopicWords\.koParticles/)
  assert.match(readFileSync(new URL("../src/shared/organize.ts", import.meta.url), "utf8"), /import \{ KO_PARTICLES, NAME_STOP \} from "\.\/words\.ts"/)
})
