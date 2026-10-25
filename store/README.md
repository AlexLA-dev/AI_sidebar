# ContextFlow 2.0: пакет для App Store

Здесь всё, что нужно для отправки версии 2.0 на ревью: метаданные на 15 локалей, скриншоты (EN и RU) и готовые ответы для App Store Connect.

```
store/
  metadata/<locale>/      name, subtitle, keywords, description, promotional_text,
                          release_notes, support_url, marketing_url, privacy_url
                          (структура fastlane deliver)
  screenshots/en-US|ru/   iphone/ 1290×2796 (6.9"), ipad/ 2064×2752 (13"), mac/ 2880×1800
                          *-preview.jpg: весь набор одной лентой, только для просмотра
```

Скриншоты собраны из реального интерфейса расширения: `tools/store/capture.mjs` снимает состояния против локального бэкенда (`tools/preview/server.mts`), `tools/store/compose.mjs` собирает финальные кадры. Как пересобрать, описано в конце файла.

---

## 1. Чеклист отправки

**Бэкенд**
- [ ] Смержить PR в `main`.
- [ ] Netlify: сейчас прод — это деплой ветки `claude/appstore-subscriptions-release-WbgYs`, опубликованный вручную. После мержа откройте Deploys и убедитесь, что опубликован свежий деплой из `main`. Если нет, нажмите **Publish deploy**.
- [ ] Проверить, что https://aisidebar.netlify.app/privacy показывает новую политику (раздел «No account»).
- [ ] Netlify → Environment variables: пометить ключи (OpenAI, Supabase service role, Stripe, Resend) как **Secret**. По желанию добавить `CF_IP_PEPPER` — любую случайную строку.
- [ ] С версии 2.1: добавить `GEMINI_API_KEY` (Secret) для ответов с Google — см. раздел 7.

**Сборка**
- [ ] Вариант A (CI): создать ключ App Store Connect API (Users and Access → Integrations, роль **Admin**, нужна для облачной подписи). Добавить в GitHub → Settings → Secrets → Actions: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` (содержимое .p8). Запустить **Actions → Release to App Store Connect** (platforms: both).
- [ ] Вариант B (Xcode): открыть `ContextFlow/ContextFlow.xcodeproj` → схема `ContextFlow (iOS)` → Product → Archive → Distribute App → App Store Connect. То же для `ContextFlow (macOS)`.
- [ ] Версия 2.0. Build number: в CI = 100 + номер запуска, в Xcode = 50. Оба больше прошлых сборок (≤ 40).

**App Store Connect → версия 2.0 (iOS и macOS)**
- [ ] Тексты из `metadata/<locale>/`. Можно вручную или через `fastlane deliver --skip_binary_upload --metadata_path store/metadata` с тем же API-ключом.
- [ ] Скриншоты из `screenshots/`. EN загрузить в en-US, RU в ru. Остальные локали возьмут скриншоты основного языка автоматически.
- [ ] App Review Information: текст из раздела 3. Sign-in required: **No**.
- [ ] App Privacy: ответы из раздела 4.
- [ ] Подписки: раздел 2.
- [ ] Если у приложения ещё нет платформы macOS, добавить её в ту же запись: бандл-ID общий (`com.contextflow.app`), покупка универсальная, и подписка работает на всех устройствах.

---

## 2. Подписки и App Store Server Notifications

| Product ID | Что даёт | Статус |
|---|---|---|
| `com.contextflow.pro.monthly` | Pro: до 375 ответов в неделю на всех устройствах | был в старых сборках |
| `com.contextflow.byok.monthly` | Own key: безлимит через свой ключ OpenAI или Claude (Anthropic) | был в старых сборках |
| `com.contextflow.pro.yearly` | Pro на год | **рекомендую создать**, в той же группе подписок |

- Приложение само покажет годовой тариф и бейдж «Save N%», как только продукт появится в ASC. Код менять не нужно.
- Бесплатный пробный период (Introductory Offer, например 1 неделя для monthly и yearly) тоже подхватится автоматически: кнопка сменится на «Start free trial».
- **App Store Server Notifications V2** (App Information → App Store Server Notifications), Production и Sandbox URL:
  `https://aisidebar.netlify.app/.netlify/functions/appstore-verify`
  Через них сервер узнаёт о продлениях, возвратах и отзывах подписки.

---

## 3. Заметки для ревью (вставить в App Review Information → Notes)

```
ContextFlow is a Safari Web Extension. No account or sign-in is required.

How to test (iPhone / iPad):
1. Open the ContextFlow app and follow the steps on the Home tab:
   Settings → Apps → Safari → Extensions → ContextFlow → turn on, and set "All Websites" to Allow.
2. In Safari open any article, e.g. https://en.wikipedia.org/wiki/Safari_(web_browser)
3. Tap the ✦ button at the bottom right of the page (or Safari's "aA"/extensions menu → ContextFlow).
4. Accept the one-time notice (the page text is sent for processing only when you ask), then tap "Summarize".
5. Select any word or sentence on the page: an "Ask ContextFlow" button appears under the selection
   and opens the panel about that text. "Google" next to it answers with Google Search, with sources.

How to test (Mac):
1. Open the ContextFlow app → "Open Safari Settings" → enable ContextFlow in Safari → Settings → Extensions.
2. Open any article and click the ContextFlow toolbar icon (or press Control-Shift-E).

Free: 5 answers per day, no sign-up.
Subscriptions are sold only inside the app (Pro tab): Pro and Own key.
After a sandbox purchase the extension shows the Pro allowance (375 answers per week).
Restore Purchases, Manage Subscription, Terms of Use (EULA) and Privacy Policy are on the same screen.

Answers are generated by OpenAI models through our server; "Google" answers are generated by Google
(Gemini API with Grounding with Google Search) and show their sources and Google search suggestions.
Page text is processed only on request and is not stored. The app has no ads and no tracking.

With the Pro or Own key plan, the user can paste their own OpenAI or Anthropic (Claude) API key in the
extension settings; requests then go directly from the device to that provider.
```

В поле Contact Information укажите свои имя, телефон и e-mail.

---

## 4. App Privacy (ответы в анкете)

Совпадают с `PrivacyInfo.xcprivacy` в сборке.

- **Do you or your third-party partners collect data from this app?** Yes.
- **Tracking:** No (ни для одного типа данных).

| Тип данных | Назначение | Linked to user | Tracking |
|---|---|---|---|
| User Content → Other User Content (вопрос и текст страницы, отправленные для ответа; не хранятся, но обрабатываются OpenAI, а ответы с Google — Google) | App Functionality | No | No |
| Identifiers → Device ID (случайный install ID для дневного лимита) | App Functionality | No | No |
| Purchases → Purchase History (подписанная Apple транзакция для проверки подписки) | App Functionality | No | No |
| Usage Data → Product Interaction (счётчики ответов, тип действия) | App Functionality, Analytics | No | No |

---

## 5. Прочие поля

- **Category:** Primary Productivity, Secondary Utilities.
- **Age rating:** отвечайте по анкете честно. Генеративный ИИ может выдать произвольный текст по запросу пользователя, поэтому у аналогичных приложений обычно 13+ (ChatGPT, Perplexity). Рейтинг 4+ с ИИ-чатом рискует получить замечание на ревью.
- **Copyright:** © 2026 ContextFlow.
- **Price:** Free, со встроенными подписками.
- **Export compliance:** в Info.plist стоит `ITSAppUsesNonExemptEncryption = NO` (только HTTPS), вопрос при загрузке не появится.

---

## 6. Что изменено в листинге и почему (рост конверсии и охвата)

| Было | Стало | Эффект |
|---|---|---|
| Название без ключей | «ContextFlow: AI for Safari» | «AI» и «Safari» в названии весят больше всего для поиска |
| Подзаголовок общий | «Summarize & translate any page» | два главных сценария и ключи summarize/translate |
| Keywords | 100 символов без повторов слов из названия и подзаголовка | охват summarizer, tldr, reader, research, study… |
| 1 локаль | 15 локалей (en-US/GB/AU/CA, ru, uk, de, fr, es-ES/MX, it, pt-BR, ja, ko, zh-Hans) | индексация в каждом сторфронте отдельно, + ключи каждой локали |
| Старые скриншоты | 5 iPhone + 4 iPad + 4 Mac, EN и RU | первые 3 кадра в поиске показывают ценность без прокрутки |
| Нет годового тарифа и триала | приложение готово к yearly и intro offer | годовой тариф и пробный период обычно заметно повышают конверсию в оплату |

**Следующие шаги, когда версия выйдет (по убыванию ожидаемого эффекта):**
1. Создать `com.contextflow.pro.yearly` и 1-недельный бесплатный триал.
2. **Product Page Optimization:** A/B-тест первого скриншота («Summarize» против «Translate») и иконки. Достаточно трёх вариантов на 50% трафика.
3. **Custom Product Pages** под отдельные сценарии (перевод, учёба, исследование) для Apple Search Ads.
4. **Apple Search Ads Basic** с небольшим бюджетом на ключи summarize/translate/safari extension. Это даёт данные о том, какие ключи конвертят.
5. Promotional Text меняется без ревью. Его можно использовать под сезонные сценарии (учёба, отпуск и перевод).

---

## Как пересобрать скриншоты

```bash
pnpm install
CF_API_BASE=http://localhost:8787 node scripts/build-extension.mjs --out=/tmp/ext-local
node --experimental-strip-types tools/preview/server.mts &        # локальный бэкенд с заготовленными ответами
# Playwright нужен в той же папке, что и скрипты (npm i playwright):
node tools/store/capture.mjs /tmp/ext-local /tmp/raw-en en         # ONLY=iphone,ipad,mac ограничит устройства
node tools/store/compose.mjs /tmp/raw-en /tmp/shots-en en          # → iphone/ ipad/ mac/ + strip.png
```

Подписи и выноски лежат в `COPY` в `tools/store/compose.mjs`, демо-ответы в `tools/preview/answers.json`, демо-статьи в `tools/preview/article*.html`.

## Как пересобрать видео-превью (iPhone 6.9")

`store/previews/<locale>/iphone.mp4` (папка в `.gitignore`: файлы по ~30 МБ в репозиторий не кладём): 886×1920, 30 fps, H.264 High 4.0, ~10 Мбит/с, беззвучная стерео-дорожка AAC, до 30 с. Загружены в iOS 2.0 (en-US и ru, слот iPhone 6.9"). Сценарий: «Кратко» → «Главное» → свой вопрос, затем объяснение выделенного текста и перевод. Нужен `ffmpeg` с libx264.

```bash
STREAM_DELAY_MS=22 node --experimental-strip-types tools/preview/server.mts &   # ответы печатаются в читаемом темпе
node tools/store/preview-record.mjs /tmp/ext-local /tmp/rec-en en               # дубли с реальным интерфейсом
node tools/store/preview-render.mjs /tmp/rec-en store/previews/en-US/iphone.mp4 en
```

Подписи совпадают со скриншотами (`COPY` в `tools/store/preview-render.mjs`), финальная карточка берёт название из `metadata/<locale>/name.txt`.

## Заголовок и результаты поиска (iOS / iPadOS 27+)

Новые материалы страницы продукта, вкладка «Заголовок и результаты поиска» в версии. Делаются из того же записанного интерфейса, что и видео:

```bash
node tools/store/creative.mjs /tmp/rec-en store/previews/en-US en   # → header.png 3840×1646 (21:9), search.png 3840×2560 (3:2)
```

- **Безопасная зона заголовка** (проверено в «Предпросмотре» App Store Connect): на iPhone верхние ~22% закрыты статус-баром, Dynamic Island и кнопками «Назад» / «Поделиться»; iPad показывает только среднюю полосу (примерно 14–86% высоты), сверху по центру лежит панель вкладок. Всё важное — в пределах y 540–1400 и x 440–3400.
- По правилам Apple в материалах нельзя: цены и «бесплатно», URL, ©, логотипы других платформ, награды Apple. Текст — короткая фраза, локализованная.
- Загрузка в App Store Connect принимает только PNG без альфа-канала. Пока версия в черновике заявки, медиа заблокированы: сначала уберите её из черновика, после загрузки добавьте снова.

## 7. Google в ContextFlow (с версии 2.1)

Кнопка «Google» (в панели, в чипах действий и рядом с выделенным текстом) отвечает по результатам поиска Google, как Google AI Mode: сервер вызывает Gemini API с инструментом `google_search` (Grounding with Google Search), расставляет ссылки на источники и отдаёт блок Search Suggestions. Ответ идёт только через наш сервер, даже со своим ключом OpenAI или Claude.

- **Ключ:** Google AI Studio → API keys → создать ключ в проекте **с включённым биллингом** (на платном тарифе Google не использует запросы для улучшения своих продуктов). В Netlify добавить `GEMINI_API_KEY` как Secret. Без ключа кнопка показывает «Ответы с Google сейчас недоступны», остальное работает.
- **Модель:** `GEMINI_MODEL=auto` берёт самую новую стабильную Gemini Flash из списка моделей (сейчас `gemini-3.8-flash`), запасные — `GEMINI_FALLBACK_MODELS`.
- **Стоимость:** для Gemini 3+ платится каждый поисковый запрос модели: первые 5 000 в месяц бесплатно, дальше $14 за 1 000, плюс токены Flash. Поэтому у ответов с Google своя квота поверх обычной: Free — 3 в день (из 5), Pro — 100 в неделю (из 375), всего — 1 500 в день (`SEARCH_*_LIMIT`). Счётчики видно в Supabase (`search:*`), в логах событие `chat` с `mode: "google"` и `search_queries`.
- **Условия Google:** источники и Search Suggestions показываются вместе с ответом (сниппет выводится как есть, ссылки открываются в новой вкладке), текст ответа хранится только в истории чатов на устройстве.

## 8. Аналитика

Страница **https://aisidebar.netlify.app/analytics** (не индексируется, нигде не слинкована). Показывает запросы за 7/30/90/180 дней в трёх разрезах:

| Сегмент | Что это |
|---|---|
| Наш ключ · ИИ | обычные ответы через наш сервер (OpenAI) |
| Наш ключ · Google | ответы с Google: Gemini + поиск Google, с числом поисковых запросов |
| Ключ пользователя | ответы со своим ключом OpenAI / Claude: идут напрямую с устройства, расширение присылает только счётчики (модель, токены, время, успех/ошибка) |

Для каждого: запросы, устройства, токены вход/выход, среднее время, ошибки; график по дням, разбивка по моделям, упоры в лимиты и ошибки провайдеров.

- **Настройка:** в Netlify добавить `ADMIN_TOKEN` (Secret, длинная случайная строка), передеплоить. На странице ввести этот токен: он хранится только в браузере. Без `ADMIN_TOKEN` эндпоинт отвечает 404.
- **Данные:** события `chat` в `contextflow.events` (Supabase) с полями `key` (`ours`/`own`), `mode` (`google`/`chat`), `provider`, `model`, токены, `search_queries`, `ms`, `ok`. Отчёт считает SQL-функция `public.cf_usage_report(days)` (миграция `20261025120000_contextflow_usage_report.sql`); её же можно вызвать в SQL editor.
- Ответы со своим ключом видны начиная со сборки, в которую попал этот отчёт (следующая после 2.1). Отчёты ограничены `OWN_KEY_REPORT_DAILY_LIMIT` на установку в день.
