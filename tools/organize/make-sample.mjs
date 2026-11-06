// Synthetic chats for calibrating "organizing" (2.5) without anybody's data: 32 topic chats in English, Russian and
// Korean (some questions about pages in another language), the user's tags on some answers and notes (plus "later"-
// like tags that mean an intention, not a topic), and four "everything in one chat" piles like the owner's. Written
// in the app's chats.json format ({id: {updatedAt, data}}), messages with 2.5 ids and times or without (older ones).
//   node tools/organize/make-sample.mjs <out.json>
// Next to it, <out>.truth.json: for each pile, which chat each of its blocks belongs in (null: none, a new chat).
import { writeFileSync } from "node:fs"

const out = process.argv[2]
if (!out) {
  console.log("node tools/organize/make-sample.mjs <out.json>")
  process.exit(1)
}

// Each topic: its chat's name, the user's tag for it, pages, questions with answers, a note or two.
const topics = {
  // ---------------------------------------------------------------- English
  japan: { tag: "travel", pages: [["https://www.japan-guide.com/e/e2361.html", "Japan Rail Pass guide"], ["https://www.japan-guide.com/e/e3011.html", "Kyoto temples and shrines"], ["https://www.timeout.com/tokyo/restaurants/best-ramen-in-tokyo", "The best ramen in Tokyo"]],
    qa: [["Is the JR Pass still worth it for Tokyo, Kyoto and Osaka in 10 days?", "For that route alone, single Shinkansen tickets usually cost less since the 2023 price rise; the pass pays off only with extra day trips such as Hiroshima or Kanazawa."],
      ["Which Kyoto temples are least crowded early in the morning?", "Fushimi Inari before 7 am, Kiyomizu-dera at opening and the grounds of Nanzen-ji are quiet; Kinkaku-ji stays busy all day."],
      ["Best ramen near Shinjuku station?", "Fuunji for tsukemen, Menya Musashi for thick pork broth and Nagi in Golden Gai for niboshi ramen; expect queues at lunch."],
      ["How many days do I need in Kyoto?", "Three full days cover the main temples, Arashiyama and Nara as a day trip; add a fourth if you want Kurama or Uji."]],
    notes: ["Book Fushimi Inari for day 2 at sunrise, then breakfast near Inari station"] },
  sourdough: { tag: "cooking", pages: [["https://www.theperfectloaf.com/beginners-sourdough-bread/", "Beginner's sourdough bread"], ["https://www.kingarthurbaking.com/recipes/sourdough-starter-recipe", "Sourdough starter"]],
    qa: [["Why is my sourdough dense and gummy inside?", "Usually underproofing or slicing it warm: let bulk fermentation go until the dough has risen about 50% and wait an hour before cutting."],
      ["How often should I feed a starter kept in the fridge?", "Once a week; take it out the day before baking and give it two feedings at room temperature so it's active again."],
      ["What hydration should a first loaf have?", "Around 70% is forgiving: the dough is easy to shape and still opens up; go higher only once shaping feels comfortable."],
      ["Can I bake sourdough without a Dutch oven?", "Yes: a baking stone or tray with a pan of boiling water on the lower rack gives enough steam for a good crust."]],
    notes: ["Next bake: 75% hydration, 10% whole wheat, cold retard overnight"] },
  react: { tag: "work", pages: [["https://react.dev/reference/react/memo", "memo – React"], ["https://react.dev/reference/react/useMemo", "useMemo – React"], ["https://web.dev/articles/inp", "Interaction to Next Paint (INP)"]],
    qa: [["When does React.memo actually help?", "When a component re-renders often with the same props and its render is expensive; it doesn't help if the props are new objects every time."],
      ["Should I wrap every callback in useCallback?", "No — only callbacks passed to memoized children or used in effect dependencies; elsewhere it adds cost without benefit."],
      ["How do I find what hurts INP on a page?", "Record an interaction in the Performance panel and look for long tasks after the input; split them or defer work that isn't urgent."],
      ["Is useMemo worth it for filtering a list of 200 items?", "Rarely: filtering 200 items takes well under a millisecond; memoize when the computation is measurably slow or feeds a memoized child."]] },
  kubernetes: { tag: "work", pages: [["https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/", "Pod Lifecycle | Kubernetes"], ["https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/", "Configure Liveness, Readiness and Startup Probes"]],
    qa: [["Why does my pod keep restarting with CrashLoopBackOff?", "The container exits soon after starting; check `kubectl logs --previous` for the error and make sure the liveness probe isn't killing it before the app is ready."],
      ["What's the difference between readiness and liveness probes?", "Readiness decides whether the pod gets traffic; liveness decides whether the container is restarted. A slow start needs a startup probe, not a long liveness delay."],
      ["How do I set memory limits without OOMKills?", "Measure real usage, set the request near the typical value and the limit with headroom over the peak; JVM and Node apps also need their heap sized below the limit."],
      ["Should I run one replica per node for availability?", "Use a PodDisruptionBudget and topology spread constraints instead of pinning; they keep replicas apart without manual placement."]] },
  marathon: { tag: "health", pages: [["https://www.runnersworld.com/training/a20812270/marathon-training-plans/", "Marathon training plans"], ["https://www.strava.com/articles/zone-2-training", "Zone 2 training"]],
    qa: [["How many long runs do I need before a first marathon?", "Most plans build to three or four runs of 28–32 km in the last two months, with an easier week every third or fourth week."],
      ["What heart rate is zone 2 for me at 38?", "Roughly 60–70% of max; with an estimated max of 182 that's about 110–128 bpm, better checked with a talk test."],
      ["What should I eat during a marathon?", "Aim for 40–60 g of carbohydrate an hour from about 45 minutes in, as gels or drink, and practise it on long runs first."],
      ["How do I taper in the last three weeks?", "Cut weekly distance by about 20%, 40% and 60% while keeping some race-pace running, so the legs stay sharp but rested."]] },
  espresso: { tag: "cooking", pages: [["https://www.home-barista.com/grinders/", "Grinder buying guide"], ["https://coffeegeek.com/guides/espresso-dialing-in/", "Dialing in espresso"]],
    qa: [["Is a hand grinder fine for espresso?", "Yes, a good conical hand grinder such as the Kingrinder K6 or 1Zpresso J-Max grinds fine enough; it's just slower."],
      ["My shot runs in 15 seconds and tastes sour — what do I change?", "Grind finer first, then check the dose; aim for about a 1:2 ratio in 25–30 seconds."],
      ["Light or medium roast for a beginner espresso machine?", "Medium roast: it extracts more easily on entry machines; light roasts need finer grinding and higher temperature to avoid sourness."],
      ["How do I steam milk for latte art?", "Stretch briefly at the start until the jug feels lukewarm, then sink the tip to spin the milk until about 60 °C for a glossy microfoam."]] },
  mortgage: { tag: "money", pages: [["https://www.nerdwallet.com/article/mortgages/fixed-vs-adjustable-rate-mortgage", "Fixed vs. adjustable-rate mortgage"], ["https://www.bankrate.com/mortgages/amortization-calculator/", "Mortgage amortization calculator"]],
    qa: [["Fixed or adjustable rate if I plan to move in five years?", "A 5/1 ARM can be cheaper if you're sure to sell before the first reset; a fixed rate is safer if the plan might change."],
      ["Is it worth paying extra on the principal each month?", "Extra payments cut total interest and shorten the term; compare the mortgage rate with what the money would earn elsewhere first."],
      ["How much house can I afford on a 120k salary?", "Lenders often cap total debt payments near 36% of gross income; that's about 3,600 a month including taxes and insurance."],
      ["What are points and should I buy them?", "A point is 1% of the loan paid upfront to lower the rate; it pays off only if you keep the loan past the break-even, often 5–7 years."]] },
  garden: { tag: "garden", pages: [["https://extension.umn.edu/vegetables/growing-tomatoes", "Growing tomatoes in home gardens"], ["https://www.rhs.org.uk/vegetables/tomatoes/grow-your-own", "How to grow tomatoes / RHS"]],
    qa: [["Why are my tomato leaves turning yellow from the bottom?", "Often early blight or simply old leaves; remove the lowest leaves, water at the base and mulch to stop soil splashing."],
      ["How often should I water tomatoes in pots?", "Daily in hot weather, deeply enough that water runs out of the bottom; uneven watering causes blossom end rot."],
      ["Should I prune tomato suckers?", "On indeterminate varieties, yes, to keep one or two main stems; bush varieties don't need it."],
      ["When should I plant tomatoes outside?", "After the last frost when nights stay above 10 °C; harden seedlings off for a week first."]] },
  photo: { tag: "photo", pages: [["https://www.dpreview.com/articles/aperture-explained", "Aperture explained"], ["https://petapixel.com/night-photography-tips/", "Night photography tips"]],
    qa: [["Which aperture for portraits with a blurred background?", "f/1.8 to f/2.8 on a short telephoto lens, with the subject well away from the background."],
      ["How do I photograph stars without trails?", "Use the 500 rule as a start: 500 divided by the focal length gives the longest exposure in seconds; shoot wide open at ISO 3200."],
      ["What shutter speed freezes a running dog?", "1/1000 s or faster with continuous autofocus and burst mode."],
      ["RAW or JPEG for travel photos?", "RAW keeps more room to fix exposure and white balance; shoot RAW+JPEG if you want quick sharing too."]] },
  ev: { tag: "cars", pages: [["https://www.deepal.com/s05/specs", "Deepal S05 specifications"], ["https://insideevs.com/reviews/deepal-s05-range-test/", "Deepal S05 range test"], ["https://ev-database.org/compare/deepal-s05-vs-tesla-model-y", "Deepal S05 vs Tesla Model Y"]],
    qa: [["What's the real winter range of the Deepal S05?", "Tests show about 380 km on the motorway in winter against the 520 km rated, roughly 25–30% less, mostly from heating and cold battery."],
      ["How fast does it charge from 10 to 80%?", "About 30 minutes on a fast charger that can deliver 150 kW or more; slower chargers stretch it to about an hour."],
      ["Deepal S05 or Tesla Model Y for a family?", "The Model Y has more boot space and a stronger charging network; the S05 costs less and is better equipped at its price."],
      ["Is a heat pump important in an EV?", "Yes in cold climates: it can save 10–20% of the range lost to heating in winter."],
      ["Does the Deepal S05 support vehicle-to-load?", "Yes, with the V2L adapter it powers devices up to about 3.3 kW, enough for a kettle or camping gear."],
      ["What warranty does the S05 battery have?", "Eight years or 160,000 km for the battery, with at least 70% capacity guaranteed over that time."]] },
  sleep: { tag: "health", pages: [["https://www.sleepfoundation.org/nutrition/caffeine-and-sleep", "Caffeine and sleep"], ["https://www.health.harvard.edu/staying-healthy/blue-light-has-a-dark-side", "Blue light has a dark side"]],
    qa: [["How many hours after coffee can I fall asleep easily?", "Caffeine's half-life is about five hours, so the last cup is best at least eight hours before bed."],
      ["Do phone screens really hurt sleep?", "Bright light late in the evening delays melatonin; dim the screen and stop scrolling 30–60 minutes before sleep."],
      ["Is it bad to sleep in on weekends?", "A long lie-in shifts your body clock; keep wake-up time within an hour of weekdays."],
      ["Does magnesium help with sleep?", "Evidence is weak; it may help people who are low in magnesium, but regular sleep times matter far more."]] },
  home: { tag: "home", pages: [["https://www.ikea.com/us/en/p/kivik-sofa-hillared-anthracite-s59305616/", "KIVIK Sofa - IKEA"], ["https://www.wirecutter.com/reviews/best-standing-desk/", "The best standing desk"]],
    qa: [["Will the KIVIK three-seat sofa fit through a 76 cm door?", "Yes: it comes flat-packed, the largest box is about 70 cm wide, and the arms attach after."],
      ["Which standing desk is stable at full height?", "Frames with two motors and a crossbar, like the Uplift V2 or the Fully Jarvis, wobble least when raised."],
      ["How high should my desk be for typing?", "With elbows at about 90° and shoulders relaxed; for most people around 70–75 cm sitting."],
      ["Is a sofa cover worth it with a cat?", "A tightly woven or microfibre cover resists claws better than loose weaves and can be washed."]] },
  kosmos: { tag: "work", pages: [["https://kosmos.example/privacy", "Kosmos — Privacy Policy"]],
    qa: [["What data does this privacy policy say they collect?", "Account details, usage analytics and device identifiers; payment data goes to the payment processor, not to them."],
      ["Do they share data with advertisers?", "Only aggregated analytics; the policy says personal data isn't sold, and you can opt out of analytics."],
      ["How long do they keep my data after I delete the account?", "Up to 30 days in backups, then it's erased; billing records are kept as the law requires."]] },

  // ---------------------------------------------------------------- Russian
  vychet: { tag: "деньги", pages: [["https://www.nalog.gov.ru/rn77/taxation/taxes/ndfl/nalog_vichet/", "Налоговые вычеты"], ["https://www.banki.ru/news/daytheme/?id=10985361", "Вычет за лечение"]],
    qa: [["Можно ли получить вычет за лечение родителей?", "Да, социальный вычет можно получить за оплату лечения родителей, если договор и чеки оформлены на вас."],
      ["Сколько лет можно подавать на вычет задним числом?", "Декларацию 3-НДФЛ можно подать за последние три года, то есть в 2026 году — за 2023, 2024 и 2025."],
      ["Какие документы нужны для вычета за квартиру?", "Договор купли-продажи, выписка из ЕГРН, платёжки и справка о доходах; через личный кабинет многое подтягивается само."],
      ["Можно ли получить вычет через работодателя?", "Да, после подтверждения права из налоговой работодатель перестанет удерживать НДФЛ до исчерпания вычета."]],
    notes: ["Собрать чеки за стоматологию за 2025 и заказать справку об оплате мед. услуг"] },
  rust: { tag: "работа", pages: [["https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html", "What is Ownership? - The Rust Programming Language"], ["https://habr.com/ru/articles/566668/", "Время жизни в Rust"]],
    qa: [["Почему нельзя взять две изменяемые ссылки на одну переменную?", "Правило заимствования исключает гонки данных на этапе компиляции: в один момент либо одна &mut, либо сколько угодно &."],
      ["Когда нужно явно писать lifetime?", "Когда функция возвращает ссылку и компилятор не может вывести, с каким из входов она связана."],
      ["Чем Box отличается от Rc?", "Box — единственный владелец данных в куче, Rc — подсчёт ссылок для нескольких владельцев в одном потоке."],
      ["Как в Rust обработать ошибку без unwrap?", "Возвращать Result и пробрасывать оператором ?, а для приложений удобно anyhow с контекстом ошибки."]] },
  remont: { tag: "дом", pages: [["https://www.forumhouse.ru/articles/house/7894", "Как спланировать ремонт кухни"], ["https://www.ikea.com/ru/ru/rooms/kitchen/", "Кухни IKEA"]],
    qa: [["С чего начать ремонт кухни?", "С плана: расстановка техники, мойки и розеток, затем электрика и сантехника, и только потом стены и пол."],
      ["Какая столешница лучше: кварц или ламинат?", "Кварц прочнее и не боится влаги на стыках, ламинат дешевле, но разбухает у мойки при плохой герметизации."],
      ["Нужна ли вытяжка над индукционной плитой?", "Да, индукция не убирает пар и запахи; вытяжка с отводом в вентиляцию работает лучше рециркуляции."],
      ["Сколько розеток нужно на кухне?", "Обычно 6–8: под встраиваемую технику отдельно и 3–4 над столешницей для мелкой техники."]] },
  gruzia: { tag: "путешествия", pages: [["https://www.tripadvisor.ru/Tourism-g294195-Georgia-Vacations.html", "Грузия — путеводитель"], ["https://www.georgia.travel/kazbegi", "Казбеги"]],
    qa: [["Когда лучше ехать в Грузию?", "Май–июнь и сентябрь–октябрь: тепло, но без жары, и открыты горные дороги."],
      ["Как добраться из Тбилиси в Казбеги?", "Маршрутка с Дидубе идёт около трёх часов, удобнее трансфер с остановками у Ананури и на перевале."],
      ["Сколько дней нужно на Тбилиси?", "Три дня хватит на старый город, серные бани, Мтацминду и поездку в Мцхету."],
      ["Можно ли там расплачиваться картой?", "В Тбилиси и Батуми почти везде, в горах лучше иметь наличные лари."]] },
  ielts: { tag: "учёба", pages: [["https://www.ielts.org/for-test-takers/test-format", "IELTS test format"], ["https://ielts.idp.com/prepare/writing-task-2", "IELTS Writing Task 2"]],
    qa: [["Как подготовиться к IELTS за два месяца на 7.0?", "Каждый день по одному разделу на время, эссе Task 2 проверять по критериям band descriptors и разбирать ошибки."],
      ["Сколько слов писать в Writing Task 2?", "Не меньше 250; оптимально 270–300, больше — меньше времени на проверку."],
      ["Как улучшить Listening?", "Слушать подкасты с транскриптом, тренировать запись чисел и имён, делать полные тесты в формате экзамена."],
      ["Что сдавать: Academic или General?", "Для учёбы нужен Academic, для иммиграции и работы обычно General Training."]] },
  shenok: { tag: "собака", pages: [["https://www.purina.ru/articles/dogs/puppy/feeding", "Кормление щенка"], ["https://www.akc.org/expert-advice/training/how-to-potty-train-a-puppy/", "How to potty train a puppy"]],
    qa: [["Сколько раз в день кормить щенка в 3 месяца?", "Четыре раза в день небольшими порциями, к шести месяцам можно перейти на три."],
      ["Как приучить щенка к туалету на улице?", "Выводить сразу после сна и еды, хвалить на месте и не ругать за промахи дома."],
      ["Когда можно гулять после прививок?", "Через 10–14 дней после второй прививки, до этого — только на руках."],
      ["Что делать, если щенок кусает руки?", "Сразу прекращать игру и давать игрушку взамен, чтобы он понял, что зубы — конец веселья."]] },
  iis: { tag: "деньги", pages: [["https://www.banki.ru/investment/iis/", "ИИС третьего типа"], ["https://journal.tinkoff.ru/obligacii/", "Облигации для начинающих"]],
    qa: [["Какой лимит вычета по ИИС третьего типа?", "Вычет на взносы — до 400 тысяч рублей в год, то есть до 52 тысяч возврата НДФЛ."],
      ["Что надёжнее: ОФЗ или корпоративные облигации?", "ОФЗ надёжнее, корпоративные платят больше за риск; смотреть рейтинг эмитента и дюрацию."],
      ["Как облагаются купоны по облигациям?", "Купоны облагаются НДФЛ 13%, брокер удерживает налог сам."],
      ["Сколько лет держать ИИС-3?", "Минимум пять лет для открытых в 2024–2026 годах, срок будет расти до десяти."]] },
  beg: { tag: "здоровье", pages: [["https://www.championat.com/lifestyle/article-4553521.html", "Почему болят колени после бега"], ["https://www.runnersworld.com/health-injuries/a20812405/runners-knee/", "Runner's knee"]],
    qa: [["Почему после бега болят колени?", "Чаще всего из-за резкого роста объёма, слабых ягодичных мышц и тяжёлого приземления на пятку."],
      ["Какие упражнения укрепят колени?", "Приседания на одной ноге, ягодичный мостик и боковые шаги с резинкой три раза в неделю."],
      ["Нужны ли беговые кроссовки с амортизацией?", "Подбирать по комфорту: мягкая амортизация помогает на длинных пробежках, но не лечит технику."],
      ["Можно ли бегать каждый день новичку?", "Лучше три-четыре раза в неделю с днём отдыха между тренировками первые месяцы."]] },
  noutbuk: { tag: "техника", pages: [["https://www.ixbt.com/notebook/apple-macbook-air-m4-review.html", "Обзор MacBook Air M4"], ["https://www.dns-shop.ru/catalog/noutbuki/", "Ноутбуки — каталог"]],
    qa: [["MacBook Air M4 или Pro для программирования?", "Air хватит для веба и мобильной разработки, Pro нужен для долгих сборок и тяжёлых контейнеров из-за охлаждения."],
      ["Сколько оперативной памяти брать?", "16 ГБ — минимум для разработки, 24 ГБ, если запускаете Docker и эмуляторы одновременно."],
      ["Стоит ли переплачивать за 1 ТБ?", "Если храните фото и проекты локально — да, внешний диск неудобен в поездках."],
      ["Какой ноутбук на Windows похож на Air?", "ASUS Zenbook 14 OLED и Lenovo Yoga Slim 7x: лёгкие, тихие и с долгой батареей."]] },
  borsh: { tag: "готовка", pages: [["https://eda.ru/recepty/supy/borsch-klassicheskij-26017", "Борщ классический"], ["https://www.povarenok.ru/recipes/show/1234/", "Пампушки с чесноком"]],
    qa: [["Как сохранить яркий цвет борща?", "Свёклу тушить отдельно с ложкой уксуса или лимонного сока и добавлять в конце, не давая кипеть."],
      ["Сколько варить говядину для борща?", "Около двух часов на слабом огне, снимая пену в начале."],
      ["Можно ли сварить борщ без мяса?", "Да, на грибном или овощном бульоне с фасолью — получится постный борщ."],
      ["Как приготовить пампушки к борщу?", "Дрожжевое тесто на молоке, маленькие булочки печь 20 минут, сразу смазать чесночным маслом с укропом."]] },

  // ---------------------------------------------------------------- Korean
  jeju: { tag: "여행", pages: [["https://www.visitjeju.net/kr/detail/view?contentsid=CONT_000000000500349", "한라산 등반 코스"], ["https://www.mangoplate.com/top_lists/jeju", "제주 맛집 리스트"]],
    qa: [["한라산 성판악 코스는 몇 시간 걸려요?", "정상 왕복 약 8~9시간이며 진달래밭 대피소 통제 시간이 있어 새벽에 출발해야 합니다."],
      ["제주에서 렌터카 없이 여행할 수 있나요?", "급행버스와 택시로 가능하지만 동쪽과 서쪽 해안을 함께 보려면 렌터카가 훨씬 편합니다."],
      ["제주 흑돼지 맛집 추천해 주세요", "제주시 돈사돈과 서귀포 숙성도가 유명하며 저녁에는 대기 시간이 깁니다."],
      ["우도는 반나절이면 충분한가요?", "전기자전거나 스쿠터로 섬을 한 바퀴 도는 데 3~4시간이면 충분합니다."]] },
  kimchi: { tag: "요리", pages: [["https://www.10000recipe.com/recipe/6835543", "김치찌개 황금레시피"], ["https://www.maangchi.com/recipe/kimchi-jjigae", "Kimchi stew (Maangchi)"]],
    qa: [["김치찌개에 신 김치를 써야 하나요?", "잘 익은 신 김치를 써야 깊은 맛이 나고, 덜 익었다면 식초를 조금 넣으면 됩니다."],
      ["돼지고기는 어느 부위가 좋아요?", "목살이나 앞다리살이 기름과 살코기가 적당해서 찌개에 잘 맞습니다."],
      ["참치 김치찌개는 어떻게 끓이나요?", "김치를 먼저 볶고 물을 부어 끓인 뒤 마지막에 참치를 넣어 5분만 더 끓입니다."],
      ["두부는 언제 넣어야 하나요?", "불을 끄기 3~4분 전에 넣어야 부서지지 않고 양념이 배어듭니다."]] },
  etf: { tag: "투자", pages: [["https://www.investing.com/etfs/spdr-s-p-500", "SPY ETF"], ["https://finance.naver.com/sise/etf.naver", "국내 ETF 시세"]],
    qa: [["S&P500 ETF는 국내 상장과 미국 상장 중 뭐가 나아요?", "연금계좌나 ISA를 쓰면 국내 상장이 세제 혜택이 크고, 일반 계좌에서는 미국 상장의 보수가 더 낮습니다."],
      ["ETF 적립식 투자는 매달 언제 사는 게 좋나요?", "날짜보다 꾸준함이 중요해서 월급날 자동 매수로 정해두는 게 좋습니다."],
      ["배당 ETF와 성장 ETF 중 뭘 고를까요?", "은퇴 전에는 성장 ETF로 자산을 키우고, 현금 흐름이 필요할 때 배당 ETF 비중을 늘리는 방식이 일반적입니다."],
      ["ISA 계좌 만기는 몇 년인가요?", "의무 가입 기간은 3년이며 만기 후 연금계좌로 옮기면 추가 세액공제를 받을 수 있습니다."]] },
  toeic: { tag: "공부", pages: [["https://exam.toeic.co.kr/", "TOEIC 시험 안내"], ["https://www.hackers.co.kr/toeic/", "해커스 토익 LC 전략"]],
    qa: [["토익 한 달 만에 800점 가능할까요?", "현재 650점 이상이면 하루 3시간씩 실전 모의고사와 오답 정리로 충분히 가능합니다."],
      ["LC 파트 2가 너무 어려워요", "첫 단어 의문사에 집중하고 오답 패턴(같은 단어 반복, 유사 발음)을 외우면 정답률이 오릅니다."],
      ["RC 시간이 부족해요", "파트 5를 10분 안에 끝내고 파트 7은 질문을 먼저 읽고 지문에서 근거를 찾는 연습을 하세요."],
      ["단어장은 뭘 쓰면 좋아요?", "토익 빈출 단어장 하나를 정해 매일 50개씩 반복하는 것이 여러 권보다 낫습니다."]] },
  iphonephoto: { tag: "사진", pages: [["https://support.apple.com/ko-kr/guide/iphone/iph3c2c84a5e/ios", "iPhone 카메라 인물 사진 모드"], ["https://www.apple.com/kr/iphone/photography-how-to/", "iPhone으로 촬영하는 방법"]],
    qa: [["아이폰 인물 사진 모드에서 배경 흐림 조절하는 법?", "사진 앱에서 편집을 누르고 f 버튼으로 심도를 조절하면 촬영 후에도 바꿀 수 있습니다."],
      ["야간 모드는 언제 켜지나요?", "어두운 환경에서 자동으로 켜지며 노란 아이콘을 눌러 노출 시간을 직접 늘릴 수 있습니다."],
      ["ProRAW는 언제 쓰는 게 좋아요?", "노출과 색을 많이 보정할 풍경이나 야경 사진에 좋고 용량이 커서 일상 사진에는 HEIC가 낫습니다."],
      ["음식 사진 잘 찍는 팁이 있나요?", "창가의 자연광에서 45도 각도로 찍고 2배 망원으로 왜곡을 줄이면 맛있어 보입니다."]] },
  diet: { tag: "건강", pages: [["https://health.chosun.com/site/data/html_dir/2026/05/12/2026051201234.html", "간헐적 단식 효과"], ["https://www.health.harvard.edu/staying-healthy/the-truth-about-metabolism", "The truth about metabolism"]],
    qa: [["간헐적 단식 16:8 효과가 있나요?", "총 섭취 칼로리가 줄어 체중 감량에 도움이 되지만 일반 식단 조절과 효과 차이는 크지 않습니다."],
      ["근력 운동은 주 몇 번 해야 하나요?", "초보자는 주 3회 전신 운동으로 시작해 각 부위를 일주일에 두 번 자극하는 것이 좋습니다."],
      ["단백질은 하루 얼마나 먹어야 해요?", "운동한다면 체중 1kg당 1.6g 정도가 근육 유지와 성장에 충분합니다."],
      ["유산소와 근력 운동 순서는?", "근력 운동을 먼저 하고 유산소를 나중에 하면 근력 운동의 질이 떨어지지 않습니다."]] },
  jeonse: { tag: "부동산", pages: [["https://www.molit.go.kr/USR/policyData/m_34681/dtl.jsp?id=4567", "전세 사기 예방 안내"], ["https://www.khug.or.kr/hug/web/ig/dr/igdr000001.jsp", "전세보증금 반환보증"]],
    qa: [["전세 계약 전에 꼭 확인할 것은?", "등기부등본의 근저당과 소유자, 건축물대장, 집주인의 세금 체납 여부를 확인해야 합니다."],
      ["전세보증보험은 꼭 들어야 하나요?", "보증금을 지키는 가장 확실한 방법이라 HUG 반환보증 가입을 권합니다."],
      ["확정일자는 언제 받아야 해요?", "잔금일에 전입신고와 함께 받아야 다음 날 0시부터 대항력과 우선변제권이 생깁니다."],
      ["전세 대출 금리 비교는 어떻게 하나요?", "주택도시기금 버팀목과 시중은행 상품을 금융감독원 금융상품통합비교공시에서 비교할 수 있습니다."]] },
  python: { tag: "개발", pages: [["https://docs.python.org/3/tutorial/datastructures.html", "Data Structures — Python 3 documentation"], ["https://wikidocs.net/book/1", "점프 투 파이썬"]],
    qa: [["파이썬 리스트와 튜플의 차이가 뭔가요?", "리스트는 수정할 수 있고 튜플은 수정할 수 없어서 딕셔너리 키나 고정된 값에 튜플을 씁니다."],
      ["딕셔너리에서 키가 없을 때 에러 없이 꺼내려면?", "get 메서드를 쓰거나 collections.defaultdict를 사용하면 됩니다."],
      ["가상환경은 왜 써야 하나요?", "프로젝트마다 패키지 버전을 분리해서 충돌을 막기 위해서이며 python -m venv로 만듭니다."],
      ["리스트 컴프리헨션이 for문보다 빠른가요?", "보통 조금 더 빠르고 짧지만 복잡한 로직은 for문이 읽기 쉽습니다."]] },
  dog: { tag: "반려견", pages: [["https://www.akc.org/expert-advice/training/teach-dog-to-come/", "How to teach a dog to come"], ["https://mypetlife.co.kr/dog-training/", "강아지 산책 훈련"]],
    qa: [["강아지가 산책할 때 줄을 너무 당겨요", "당길 때마다 멈추고 줄이 느슨해지면 다시 걷는 연습을 반복하면 됩니다."],
      ["부르면 오게 하려면 어떻게 훈련해요?", "집 안에서 이름을 부르고 오면 간식으로 보상하는 것부터 시작해 거리를 늘려갑니다."],
      ["분리불안이 있는 것 같아요", "짧게 외출하고 돌아오는 연습을 반복하고 외출 전후로 과하게 반응하지 않는 것이 중요합니다."],
      ["강아지 산책은 하루 몇 번 해야 하나요?", "소형견도 하루 두 번, 한 번에 20~30분 정도가 적당합니다."]] },
  cafe: { tag: "카페", pages: [["https://www.timeout.com/seoul/restaurants/best-cafes-in-seoul", "The best cafés in Seoul"], ["https://www.instagram.com/explore/tags/성수카페/", "#성수카페"]],
    qa: [["성수동에서 작업하기 좋은 카페 있나요?", "대림창고와 어니언 성수는 넓지만 붐비고, 조용한 곳은 골목 안쪽의 작은 로스터리 카페가 낫습니다."],
      ["을지로 감성 카페 추천해 주세요", "커피한약방과 호텔수선화가 유명하며 오래된 건물 분위기를 즐길 수 있습니다."],
      ["서울에서 핸드드립 맛집은?", "프릳츠, 테라로사 서울숲점, 커피리브레가 원두가 좋아 핸드드립으로 유명합니다."],
      ["카페에서 노트북 오래 써도 되나요?", "프랜차이즈는 대체로 괜찮지만 작은 카페는 2시간 정도면 추가 주문을 하는 게 예의입니다."]] }
}

// The chats' languages and names; the piles at the end.
const lang = { japan: "en", sourdough: "en", react: "en", kubernetes: "en", marathon: "en", espresso: "en", mortgage: "en", garden: "en", photo: "en", ev: "en", sleep: "en", home: "en", kosmos: "en",
  vychet: "ru", rust: "ru", remont: "ru", gruzia: "ru", ielts: "ru", shenok: "ru", iis: "ru", beg: "ru", noutbuk: "ru", borsh: "ru",
  jeju: "ko", kimchi: "ko", etf: "ko", toeic: "ko", iphonephoto: "ko", diet: "ko", jeonse: "ko", python: "ko", dog: "ko", cafe: "ko" }
// Tags meaning an intention, not a topic: on unrelated answers. They shouldn't be suggested.
const intent = { en: "later", ru: "потом", ko: "나중에" }

const DAY = 86_400_000
let clock = Date.UTC(2026, 8, 1)
const tick = (hours = 7) => (clock += hours * 3_600_000)
let seq = 0
const id = () => `s${(++seq).toString(36).padStart(11, "0")}`

/**
 * One block: a question (and its answer) on a page, maybe a note after it, or only notes (`notes`); `modern`: 2.5
 * ids and times.
 */
function block(topic, k, { modern = true, tag = false, intentTag = false, note = null, noteTag = false, page = null, notes = null } = {}) {
  const t = topics[topic]
  const [url, title] = page ?? t.pages[k % t.pages.length]
  const [q, a] = t.qa[k % t.qa.length]
  const at = tick()
  const m = []
  const pageRef = { url, title, hash: (url.length * 2654435761 >>> 0).toString(16).padStart(8, "0"), at }
  if (notes) {
    return notes.map((text, i) => ({ role: "user", content: text, note: true, page: { ...pageRef, at: at + i * 60_000 }, ...(modern ? { id: id(), t: at + i * 60_000 } : {}) }))
  }
  m.push({ role: "user", content: q, page: pageRef, ...(modern ? { id: id(), t: at } : {}) })
  const tags = [...(tag ? [t.tag] : []), ...(intentTag ? [intent[lang[topic]]] : [])]
  m.push({ role: "assistant", content: a, ...(tags.length ? { tags } : {}), ...(modern ? { id: id(), t: at + 20_000 } : {}) })
  if (note) m.push({ role: "user", content: note, note: true, page: { ...pageRef, at: at + 60_000 }, ...(noteTag ? { tags: [t.tag] } : {}), ...(modern ? { id: id(), t: at + 60_000 } : {}) })
  return m
}

const chats = {}
function save(name, m, extra = {}) {
  const a = Math.max(...m.map((e) => e.t ?? e.page?.at ?? 0))
  chats[name] = { updatedAt: a + 1_000, data: JSON.stringify({ m, a, ...extra }) }
}

// Topic chats: the first block or two from before 2.5 (no ids), tags on two answers or more (and on a note), an
// "intention" tag here and there, a chat tag on a few.
const order = Object.keys(topics)
let n = 0
for (const topic of order) {
  const t = topics[topic]
  const m = []
  const blocks = topic === "kosmos" ? 2 : 3
  for (let k = 0; k < blocks; k++) {
    m.push(...block(topic, k, {
      modern: k > 0,
      tag: k !== 1 || n % 2 === 0,
      intentTag: n % 5 === k,
      note: k === 1 && t.notes ? t.notes[0] : null,
      noteTag: k === 1 && n % 3 === 0
    }))
  }
  save(topic, m, n % 4 === 3 ? { tags: [t.tag] } : {})
  n++
  tick(30)
}

// Piles, written last: blocks that belong in other chats, in a chat started for something else.
const truth = {}
function pile(name, parts) {
  const m = []
  const expected = []
  for (const [topic, k, opts = {}] of parts) {
    m.push(...block(topic, k, opts))
    expected.push(opts.expect === undefined ? topic : opts.expect)
  }
  save(name, m)
  truth[name] = expected
}
tick(48)
pile("pile-en", [["react", 3], ["japan", 3], ["sleep", 3], ["espresso", 3]])
pile("pile-ru", [["remont", 3], ["iis", 3], ["shenok", 3], ["borsh", 3]])
pile("pile-ko", [["jeju", 3], ["etf", 3], ["kimchi", 3], ["dog", 3]])
// Like the owner's chat: a sofa, a calendar service, three questions about a car, an analytics page and two
// notes on the privacy page another chat is about. The calendar and the analytics page belong nowhere.
topics.calendar = { tag: "work", pages: [["https://www.taskcal.example/features", "TaskCal — calendar for tasks"]], qa: [["Can TaskCal sync tasks to Google Calendar both ways?", "Yes, two-way sync is in the paid plan; the free plan only shows tasks as read-only events."]] }
topics.analytics = { tag: "work", pages: [["https://analytics.example/dashboard/retention", "Retention dashboard"]], qa: [["Why does day-7 retention drop for the iOS cohort?", "The iOS cohort came mostly from one ad campaign whose users installed and left; segment by source before comparing."]] }
lang.calendar = "en"
lang.analytics = "en"
pile("pile-owner", [
  ["home", 3, { page: ["https://www.ikea.com/us/en/p/kivik-sofa-hillared-anthracite-s59305616/", "KIVIK Sofa - IKEA"] }],
  ["calendar", 0, { expect: null }],
  ["ev", 3], ["ev", 4], ["ev", 5],
  ["analytics", 0, { expect: null }],
  ["kosmos", 2, { notes: ["Тест заметки: проверить раздел про cookies и сроки хранения", "Ещё одна заметка к политике: сравнить с нашей"] }]
])

writeFileSync(out, JSON.stringify(chats, null, 1))
writeFileSync(out.replace(/\.json$/, "") + ".truth.json", JSON.stringify(truth, null, 1))
const messages = Object.values(chats).reduce((s, c) => s + JSON.parse(c.data).m.length, 0)
console.log(`${Object.keys(chats).length} chats, ${messages} messages → ${out}`)
