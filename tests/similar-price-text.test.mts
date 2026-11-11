// Find similar's price from an item page's text (2.6), when the page states none for machines: the first clean
// price after the item's heading. Skipped, in the app's languages: struck-through, was and list prices, savings,
// shipping, per-month, cart totals and order minimums, hidden text, comments, other items' sections. When unsure, none.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, textPrice } = await import("../netlify/shared/pagecheck.mts")

const page = (title: string, body: string, lang = "en") => `<html lang="${lang}"><head><title>${title} | Shop</title></head><body><main><h1>${title}</h1>${body}<p>${"About this item, its care and what comes in the box. ".repeat(8)}</p></main></body></html>`
const read = (html: string, url = "https://shop.example.com/item") => describePage(html, url, url, 200, 0).price

test("the first clean price after the item's heading, its sign or code read by the shop's country", () => {
  assert.deepEqual(read(page("Cabin Pak'r", "<p>Colour: Black</p><p>&euro; 84,95</p><button>Add to cart</button>")), { amount: 84.95, currency: "EUR" })
  assert.deepEqual(read(page("Mirra 2 Chair", "<p>&#36; 459.99</p><p>Quantity</p>")), { amount: 459.99, currency: "USD" })
  assert.deepEqual(read(page("ケトル KT-1", "<p>¥ 5,478（税込）</p><button>カートに入れる</button>", "ja"), "https://shop.example.co.jp/item"), { amount: 5478, currency: "JPY" })
  assert.deepEqual(read(page("Чайник Т-1", "<p>3 990 ₽</p><button>В корзину</button>", "ru"), "https://shop.example.ru/item"), { amount: 3990, currency: "RUB" })
  assert.deepEqual(read(page("세럼 30ml", "<p>판매가 59,000원</p><button>장바구니 담기</button>", "ko"), "https://shop.example.co.kr/item"), { amount: 59000, currency: "KRW" })
  // No sign: "378.-" or after a price label, in the country's money; a bare number alone (an SKU) never.
  assert.deepEqual(read(page("Küchenmaschine K5", "<p>378.- inkl. MwSt.</p>", "de"), "https://shop.example.de/item"), { amount: 378, currency: "EUR" })
  assert.equal(read(page("Desk D1", "<p>SKU: 6010</p><p>Item 48213</p><button>Add to cart</button>")), undefined)
})

test("not the price to pay now: struck-through, was, list, savings, shipping, per month, a cart or an order minimum", () => {
  const cart = "<button>Add to cart</button>"
  assert.deepEqual(read(page("Bike B7", `<p><del>£650.00</del> £399.00</p>${cart}`), "https://shop.example.co.uk/item"), { amount: 399, currency: "GBP" })
  assert.deepEqual(read(page("Bike B7", `<p><span class="price--compare">£650.00</span> <span>£399.00</span></p>${cart}`), "https://shop.example.co.uk/item"), { amount: 399, currency: "GBP" })
  assert.deepEqual(read(page("Dachbox X", `<p>Ab: 1.290,00 € 899,00 €</p>${cart}`, "de"), "https://shop.example.de/item"), { amount: 899, currency: "EUR" })
  assert.deepEqual(read(page("Mixer M", `<p>UVP 499 € — jetzt 379 €</p>${cart}`, "de"), "https://shop.example.de/item"), { amount: 379, currency: "EUR" })
  assert.deepEqual(read(page("ケトル KT-2", "<p>定価 ¥12,800 販売価格 ¥9,980</p><button>カートに入れる</button>", "ja"), "https://shop.example.co.jp/item"), { amount: 9980, currency: "JPY" })
  assert.deepEqual(read(page("Lamp L", `<p>You save $20.00</p><p>$79.00</p>${cart}`)), { amount: 79, currency: "USD" })
  assert.deepEqual(read(page("Sofa S", `<p>Shipping: $49</p><p>$899</p>${cart}`)), { amount: 899, currency: "USD" })
  assert.deepEqual(read(page("Laptop L", `<p>$41.58/mo with financing</p><p>$999.00</p>${cart}`)), { amount: 999, currency: "USD" })
  assert.deepEqual(read(page("Moka M", `<p>95,00 € o 3 rate da 31,67 € senza interessi</p><p>Quantità</p>`, "it"), "https://shop.example.it/item"), { amount: 95, currency: "EUR" })
  assert.deepEqual(read(page("Pizza P", `<p>Min. order €15.00</p><p>€23.99</p>${cart}`)), { amount: 23.99, currency: "EUR" })
  assert.deepEqual(read(page("Lamp L2", `<p>Cart €0,00</p><p>€15,90</p>${cart}`, "it"), "https://shop.example.it/item"), { amount: 15.9, currency: "EUR" })
})

test("when unsure, no price: a heading that isn't the item's, other items' sections, sizes listed with prices, hidden or commented text, no item page", () => {
  const cart = "<button>Add to cart</button>"
  // A brand's banner heading, not the item's name.
  assert.equal(read(`<html><head><title>Serum 30ml | Brand</title></head><body><h1>Dermatological laboratory for sensitive skin</h1><p>$59.00</p>${cart}</body></html>`), undefined)
  // The first heading that names the item is the one read ("Shopping cart" isn't).
  assert.deepEqual(read(`<html><head><title>Earbuds T200 | Shop</title></head><body><h1>Shopping cart</h1><p>Cart $0.00</p><h1>Earbuds T200</h1><p>$29.99</p>${cart}</body></html>`), { amount: 29.99, currency: "USD" })
  // Other items' prices after their section's title.
  assert.equal(read(page("Chair C", `<p>Price on request</p><h2>You may also like</h2><p>Stool $49</p>${cart}`)), undefined)
  // Sizes with prices one after another: which one is theirs isn't told.
  assert.equal(read(page("Backpack P", `<p>20L: $279</p><p>30L: $299</p>${cart}`)), undefined)
  // Hidden or commented-out text isn't on the page.
  assert.equal(read(page("Kettle K", `<!-- <p>Online store ¥10,800</p> --><div class="d-none">¥10,800</div>${cart}`, "ja"), "https://maker.example.co.jp/item"), undefined)
  // Not an item page: no buy button, quantity or tax line (a pricing or tuition page), and the App Store.
  assert.equal(read(page("Tuition", "<p>The full course costs $149 for the year.</p>")), undefined)
  assert.equal(textPrice(page("Notes App", `<p>$11.99</p>${cart}`), "https://apps.apple.com/us/app/notes/id1", ["Notes App"], true), undefined)
})

test("numbers as prices write them: one kind of separator, Indian grouping; a size before a price in any language (the overfit review, S12)", () => {
  const cart = "<button>Add to cart</button>"
  // "$1,299 256 GB" is 1,299 and a capacity, not 1.299256; "₹1,23,456" is a lakh grouping, not 1.23.
  assert.deepEqual(read(page("Phone P1", `<p>$1,299 256 GB</p>${cart}`)), { amount: 1299, currency: "USD" })
  assert.deepEqual(read(page("Phone P1", `<p>₹1,23,456</p>${cart}`), "https://shop.example.in/item"), { amount: 123456, currency: "INR" })
  assert.deepEqual(read(page("Phone P1", `<p>₹12,34,567.50</p>${cart}`), "https://shop.example.in/item"), { amount: 1234567.5, currency: "INR" })
  assert.deepEqual(read(page("Чайник Ч", "<p>79 990 ₽</p><button>В корзину</button>", "ru"), "https://shop.example.ru/item"), { amount: 79990, currency: "RUB" })
  assert.deepEqual(read(page("Nồi N", "<p>1.290.000₫</p><button>Thêm vào giỏ</button>", "vi"), "https://shop.example.vn/item"), { amount: 1290000, currency: "VND" })
  // Sizes with their own prices, in the shop's language: which one is theirs isn't told.
  assert.equal(read(page("Кофе К", "<p>250 г – 590 ₽ 500 г – 1 090 ₽</p><button>В корзину</button>", "ru"), "https://shop.example.ru/item"), undefined)
  assert.equal(read(page("お米 R", "<p>5kg ¥3,980 10kg ¥7,480</p><button>カートに入れる</button>", "ja"), "https://shop.example.co.jp/item"), undefined)
  assert.equal(read(page("우유 M", "<p>1리터 3,900원 2리터 6,900원</p><button>장바구니 담기</button>", "ko"), "https://shop.example.co.kr/item"), undefined)
  assert.equal(read(page("Café C", `<p>250 g – 5,90 € 1 kg – 19,90 €</p>${cart}`, "fr"), "https://shop.example.fr/item"), undefined)
  // A unit price isn't the item's ("9,32 € / 100ml", "1 kg = 15,96 €"); a price per piece is.
  assert.deepEqual(read(page("Baume B", `<p>Tube 75 ml (9,32 € / 100ml)</p><p>6,99 €</p>${cart}`, "fr"), "https://shop.example.fr/item"), { amount: 6.99, currency: "EUR" })
  assert.deepEqual(read(page("Kaffee K", `<p>1 kg = 15,96 €</p><p>3,99 €</p>${cart}`, "de"), "https://shop.example.de/item"), { amount: 3.99, currency: "EUR" })
  assert.deepEqual(read(page("Becher B", `<p>4,99 € / Stück</p>${cart}`, "de"), "https://shop.example.de/item"), { amount: 4.99, currency: "EUR" })
})
