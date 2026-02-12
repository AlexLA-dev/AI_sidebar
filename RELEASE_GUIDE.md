# ContextFlow — Полная инструкция: от кода до App Store

Это пошаговое руководство покрывает **весь путь** от текущего состояния проекта
до момента, когда ContextFlow будет доступен в App Store.

**Что уже готово** (сделано в коде):
- Интеграция StoreKit 2 (Swift-менеджер подписок)
- JS-мост между расширением и нативным StoreKit
- Серверная верификация транзакций (Netlify function)
- Двойной PaywallModal (Stripe для Chrome / StoreKit для Safari)
- Privacy Manifest
- Обработка App Store Server Notifications v2

**Что нужно сделать** (эта инструкция):
1. Подготовить окружение (Mac + Xcode)
2. Собрать расширение для Safari
3. Сконвертировать в Xcode-проект
4. Интегрировать StoreKit и нативные Swift-файлы
5. Настроить App Store Connect
6. Настроить серверные переменные
7. Протестировать подписки в Sandbox
8. Собрать архив и отправить на ревью

---

## Часть 1. Подготовка окружения

### 1.1. Требования

- **Mac** с macOS 14 Sonoma или новее
- **Xcode 16+** (обязательно с апреля 2025 для загрузки в App Store Connect)
- **Apple Developer Account** ($99/год) — https://developer.apple.com/programs/
- **Node.js 18+** и **pnpm**

### 1.2. Установить Xcode Command Line Tools

```bash
xcode-select --install
```

### 1.3. Клонировать репозиторий на Mac

```bash
git clone https://github.com/AlexLA-dev/AI_sidebar.git
cd AI_sidebar
git checkout claude/appstore-subscriptions-release-WbgYs
pnpm install
```

---

## Часть 2. Сборка расширения для Safari

### 2.1. Собрать Plasmo-расширение для Safari

```bash
pnpm build --target=safari-mv3
```

Это создаст директорию `build/safari-mv3-prod/` с содержимым:
```
build/safari-mv3-prod/
├── manifest.json          ← MV3 манифест
├── sidepanel.html         ← Главная панель расширения
├── sidepanel.*.js         ← React-бандл
├── sidepanel.*.css        ← Стили Tailwind
├── static/background/     ← Service Worker
├── static/contents/       ← Content Scripts
└── icon*.png              ← Иконки
```

### 2.2. Убедиться, что билд прошёл

```bash
ls -la build/safari-mv3-prod/manifest.json
# Должен существовать файл manifest.json
```

---

## Часть 3. Конвертация в Xcode-проект

Apple предоставляет утилиту `safari-web-extension-converter`, которая **автоматически
создаёт полный Xcode-проект** из билда расширения. Это ключевой шаг.

### 3.1. Запустить конвертер

```bash
xcrun safari-web-extension-converter ./build/safari-mv3-prod \
  --app-name "ContextFlow" \
  --bundle-identifier "com.contextflow.app" \
  --swift \
  --copy-resources \
  --force
```

**Что делают флаги:**
| Флаг | Назначение |
|------|-----------|
| `--app-name` | Имя приложения в Xcode |
| `--bundle-identifier` | Bundle ID (должен совпадать с App Store Connect) |
| `--swift` | Генерировать Swift-код (не Objective-C) |
| `--copy-resources` | Копировать файлы расширения в проект (а не ссылаться) |
| `--force` | Перезаписать если проект уже существует |

**Дополнительные опции:**
- `--macos-only` — только macOS (без iOS)
- `--ios-only` — только iOS
- Без этих флагов — универсальное приложение (macOS + iOS)

### 3.2. Что будет создано

Конвертер создаст папку `ContextFlow/` с полным Xcode-проектом:

```
ContextFlow/
├── ContextFlow.xcodeproj/            ← Xcode проект (открывается в Xcode)
├── ContextFlow/                      ← Основной таргет (контейнер-приложение)
│   ├── AppDelegate.swift             ← Точка входа приложения
│   ├── ViewController.swift          ← Главный экран
│   ├── Main.storyboard               ← UI основного приложения
│   ├── Assets.xcassets/              ← Иконки и ресурсы
│   └── Info.plist
├── ContextFlow Extension/            ← Safari Web Extension таргет
│   ├── SafariWebExtensionHandler.swift  ← Обработчик сообщений расширения
│   ├── Resources/                    ← Файлы расширения (из Plasmo билда)
│   │   ├── manifest.json
│   │   ├── sidepanel.html
│   │   ├── sidepanel.*.js
│   │   └── ...
│   └── Info.plist
└── Shared (App)/                     ← Общие ресурсы (если универсальное)
```

### 3.3. Открыть проект в Xcode

```bash
open ContextFlow/ContextFlow.xcodeproj
```

Xcode автоматически откроется с проектом.

### 3.4. Проверить базовый билд

В Xcode:
1. Выбери схему **ContextFlow (macOS)** или **(iOS)**
2. Нажми **Cmd+B** (Build)
3. Убедись, что нет ошибок компиляции

---

## Часть 4. Интеграция StoreKit 2 и нативных файлов

Теперь нужно добавить в Xcode-проект файлы подписок, которые уже лежат в репозитории.

### 4.1. Добавить Swift-файлы

1. В Xcode, в **Project Navigator** (левая панель), кликни правой кнопкой на папку **ContextFlow** (основной таргет, НЕ Extension)
2. Выбери **Add Files to "ContextFlow"...**
3. Перейди в `AI_sidebar/native/ContextFlow/Sources/`
4. Выбери оба файла:
   - `StoreKitManager.swift`
   - `ExtensionMessageHandler.swift`
5. Убедись, что **Target: ContextFlow** отмечен галочкой (основной таргет)
6. Нажми **Add**

### 4.2. Добавить Privacy Manifest

1. Правый клик на **ContextFlow** → **Add Files to "ContextFlow"...**
2. Выбери `AI_sidebar/native/ContextFlow/PrivacyInfo.xcprivacy`
3. Таргет: **ContextFlow** (основной)
4. **Add**

### 4.3. Добавить capability In-App Purchase

1. В Xcode, кликни на **ContextFlow.xcodeproj** (корень проекта) в навигаторе
2. Выбери таргет **ContextFlow** (основное приложение)
3. Перейди на вкладку **Signing & Capabilities**
4. Нажми **+ Capability**
5. Найди и добавь **In-App Purchase**

### 4.4. Установить Deployment Target

На той же вкладке **General** таргета ContextFlow:
- **macOS Deployment Target**: `13.0` (минимум для StoreKit 2)
- **iOS Deployment Target**: `16.0` (если поддерживаешь iOS)

### 4.5. Подключить ExtensionMessageHandler к WebView

Открой файл `ContextFlow/ViewController.swift` (сгенерирован конвертером).

Найди место, где создаётся или конфигурируется WKWebView, и добавь
регистрацию StoreKit message handler.

**До** (примерно так выглядит сгенерированный код):
```swift
import WebKit

class ViewController: NSViewController, WKNavigationDelegate {
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        // Existing code...
    }
}
```

**После** (добавь регистрацию хэндлера):
```swift
import WebKit

class ViewController: NSViewController, WKNavigationDelegate {
    @IBOutlet var webView: WKWebView!

    // Сохраняем ссылку чтобы не был deallocated
    private let storeKitHandler = ExtensionMessageHandler()

    override func viewDidLoad() {
        super.viewDidLoad()

        // Регистрируем StoreKit bridge для JavaScript
        webView.configuration.userContentController.add(
            storeKitHandler,
            name: "storekit"
        )

        // Existing code...
    }
}
```

> **Важно:** Имя `"storekit"` должно совпадать с тем, что используется в
> `src/lib/appstore.ts` → `webkit.messageHandlers.storekit.postMessage(...)`.

### 4.6. Создать StoreKit Configuration File (для тестирования)

1. В Xcode: **File → New → File...**
2. Найди **StoreKit Configuration File**
3. Назови `Products.storekit`
4. Добавь в таргет **ContextFlow**

В открывшемся редакторе создай два продукта:

**Продукт 1:**
| Поле | Значение |
|------|---------|
| Type | Auto-Renewable Subscription |
| Reference Name | BYOK License |
| Product ID | `com.contextflow.byok.monthly` |
| Price | $1.99 |
| Subscription Duration | 1 Month |
| Subscription Group | `ContextFlow Subscriptions` |

**Продукт 2:**
| Поле | Значение |
|------|---------|
| Type | Auto-Renewable Subscription |
| Reference Name | Pro Subscription |
| Product ID | `com.contextflow.pro.monthly` |
| Price | $6.99 |
| Subscription Duration | 1 Month |
| Subscription Group | `ContextFlow Subscriptions` |

### 4.7. Включить StoreKit Configuration для отладки

1. **Product → Scheme → Edit Scheme...**
2. В секции **Run → Options**
3. **StoreKit Configuration** → выбери `Products.storekit`

---

## Часть 5. Настройка Code Signing

### 5.1. Выбрать Team

1. Кликни на **ContextFlow.xcodeproj** в навигаторе
2. Для **каждого таргета** (ContextFlow и ContextFlow Extension):
   - Вкладка **Signing & Capabilities**
   - **Team**: выбери свой Apple Developer Team
   - **Automatically manage signing**: включи ✅

### 5.2. Убедиться в Bundle Identifiers

Таргет **ContextFlow**: `com.contextflow.app`
Таргет **ContextFlow Extension**: `com.contextflow.app.Extension`

> Extension bundle ID **должен** быть дочерним от основного.

---

## Часть 6. Настройка App Store Connect

Открой https://appstoreconnect.apple.com

### 6.1. Создать приложение

1. **My Apps → +** (New App)
2. Заполни:
   - **Platforms**: macOS (и/или iOS)
   - **Name**: ContextFlow
   - **Primary Language**: English
   - **Bundle ID**: `com.contextflow.app` (должен совпадать с Xcode)
   - **SKU**: `contextflow-safari`
   - **User Access**: Full Access

### 6.2. Создать подписки

1. Перейди в приложение → **Subscriptions** (левое меню)
2. Нажми **+** для создания **Subscription Group**
   - Имя группы: `ContextFlow Subscriptions`
3. Внутри группы создай **два продукта**:

**Подписка 1: BYOK License**
| Поле | Значение |
|------|---------|
| Reference Name | BYOK License |
| Product ID | `com.contextflow.byok.monthly` |
| Subscription Duration | 1 Month |
| Subscription Price | $1.99 (Tier 2) — настрой для всех стран |
| Description | Unlimited interface access. Bring your own OpenAI API key. |

**Подписка 2: Pro Subscription**
| Поле | Значение |
|------|---------|
| Reference Name | Pro Subscription |
| Product ID | `com.contextflow.pro.monthly` |
| Subscription Duration | 1 Month |
| Subscription Price | $6.99 (Tier 7) — настрой для всех стран |
| Description | Full AI assistant. No API key needed. 375 requests per week. |

### 6.3. Настроить App Store Server Notifications v2

1. В App Store Connect → **приложение** → **App Information**
2. Раздел **App Store Server Notifications**
3. **Production Server URL**:
   ```
   https://aisidebar.netlify.app/.netlify/functions/appstore-verify
   ```
4. **Sandbox Server URL** (тот же):
   ```
   https://aisidebar.netlify.app/.netlify/functions/appstore-verify
   ```
5. **Notification Version**: Version 2

### 6.4. Заполнить App Privacy

В App Store Connect → **App Privacy**:

| Тип данных | Использование | Linked | Tracking |
|-----------|--------------|--------|----------|
| Email Address | App Functionality | Yes | No |
| Purchase History | App Functionality | Yes | No |
| Product Interaction | App Functionality, Analytics | Yes | No |

### 6.5. Добавить Privacy Policy и Terms of Service

1. **App Information → Privacy Policy URL**: укажи URL твоей политики
2. **Terms of Service URL**: укажи URL условий

> Если у тебя ещё нет privacy policy — создай через генератор
> (например, https://www.freeprivacypolicy.com) и размести на Netlify.

### 6.6. Создать Sandbox тестового пользователя

1. **Users and Access → Sandbox → Testers**
2. **+** — создай тестовый Apple ID
3. Запиши email и пароль — они нужны для тестирования покупок

---

## Часть 7. Настройка серверных переменных

### 7.1. Получить App Store Server API ключ

1. App Store Connect → **Users and Access → Integrations → In-App Purchase**
2. **Generate In-App Purchase Key**
3. Скачай файл `.p8`
4. Запомни **Key ID** и **Issuer ID** (показаны на странице)

### 7.2. Установить переменные в Netlify

Открой Netlify Dashboard → **Site Settings → Environment Variables**

Добавь:
```
APPSTORE_BUNDLE_ID     = com.contextflow.app
APPSTORE_KEY_ID        = <Key ID из шага 7.1>
APPSTORE_ISSUER_ID     = <Issuer ID из шага 7.1>
APPSTORE_ENVIRONMENT   = sandbox
```

> Поменяй `APPSTORE_ENVIRONMENT` на `production` перед финальным релизом.

### 7.3. Выполнить миграцию базы данных

Открой **Supabase Dashboard → SQL Editor** и выполни содержимое файла
`SUPABASE_MIGRATION_APPSTORE.sql`:

```sql
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS payment_provider TEXT
    CHECK (payment_provider IN ('stripe', 'appstore'))
    DEFAULT NULL;

ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS appstore_original_transaction_id TEXT UNIQUE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_appstore_txn
  ON public.user_subscriptions(appstore_original_transaction_id)
  WHERE appstore_original_transaction_id IS NOT NULL;
```

---

## Часть 8. Тестирование

### 8.1. Локальное тестирование (StoreKit local)

1. В Xcode: **Cmd+R** (Run)
2. Safari откроется → включи расширение в **Safari → Preferences → Extensions**
3. Открой любой сайт → кликни иконку ContextFlow
4. Зарегистрируйся / войди
5. Используй 5 бесплатных запросов
6. Появится PaywallModal
7. Нажми **Subscribe** — откроется нативный StoreKit payment sheet
8. Подтверди покупку (в локальном режиме пароль не нужен)
9. Проверь, что подписка активировалась

### 8.2. Sandbox-тестирование (реальный App Store Sandbox)

1. На Mac: **System Preferences → Apple ID → Media & Purchases → Sign Out**
2. В Safari, при покупке система запросит Apple ID — используй Sandbox тестера из шага 6.6
3. Покупка пройдёт через реальные серверы Apple (но деньги не спишутся)
4. Проверь, что Netlify function `/appstore-verify` получила и обработала транзакцию

### 8.3. Чеклист тестирования

- [ ] Покупка BYOK ($1.99) работает
- [ ] Покупка Pro ($6.99) работает
- [ ] После покупки PaywallModal закрывается
- [ ] В SettingsPanel отображается "Pro License"
- [ ] "Restore Purchases" восстанавливает подписку
- [ ] "Manage Subscription" открывает управление подписками
- [ ] После отмены подписки статус меняется на expired
- [ ] После перезапуска Safari подписка сохраняется
- [ ] Chrome-версия по-прежнему использует Stripe (регрессия!)

---

## Часть 9. Подготовка метаданных для App Store

### 9.1. Иконка приложения

Подготовь иконку 1024x1024 px (PNG, без прозрачности).
Добавь в Xcode: **Assets.xcassets → AppIcon** → перетащи иконку.

Xcode автоматически сгенерирует все необходимые размеры.

### 9.2. Скриншоты

Нужны скриншоты для каждой поддерживаемой платформы:
- **macOS**: минимум 1 скриншот, рекомендуемый размер 2880x1800
- **iOS** (если поддерживается): 6.7" и 5.5" дисплеи

Сделай скриншоты, показывающие:
1. Расширение ContextFlow в боковой панели Safari
2. Чат с AI-ассистентом в контексте веб-страницы
3. PaywallModal с планами подписки

### 9.3. Описание

```
ContextFlow — AI-ассистент прямо в Safari. Задавайте вопросы
о содержимом любой веб-страницы и получайте точные ответы.

• Анализ текста веб-страниц и выделенного текста
• Умный чат с контекстом текущей страницы
• 5 бесплатных запросов для начала
• Два плана подписки: BYOK ($1.99/мес) и Pro ($6.99/мес)
```

### 9.4. Категория и рейтинг

- **Category**: Productivity
- **Age Rating**: 4+ (без ограничений)
- **Content Rights**: Does not contain third-party content

---

## Часть 10. Финальная сборка и отправка

### 10.1. Переключить окружение на production

В Netlify Dashboard:
```
APPSTORE_ENVIRONMENT = production
```

### 10.2. Пересобрать расширение (если были изменения)

```bash
cd AI_sidebar
pnpm build --target=safari-mv3
```

Затем скопировать обновлённые файлы в Xcode-проект:
```bash
cp -R build/safari-mv3-prod/* \
  ContextFlow/"ContextFlow Extension"/Resources/
```

### 10.3. Обновить версию

В Xcode, для **обоих таргетов**:
- **Version**: `1.0.0`
- **Build**: `1`

### 10.4. Запустить Xcode Analyze

1. **Product → Analyze** (Cmd+Shift+B)
2. Исправь все предупреждения (Apple может отклонить при наличии warnings)

### 10.5. Создать архив

1. Выбери схему **ContextFlow (macOS)** (или универсальную)
2. Выбери **Any Mac** (или конкретное устройство) как destination
3. **Product → Archive**
4. Дождись завершения (откроется Organizer)

### 10.6. Validate

В **Xcode Organizer**:
1. Выбери созданный архив
2. Нажми **Validate App**
3. Следуй инструкциям мастера
4. Исправь все ошибки валидации, если есть

### 10.7. Загрузить в App Store Connect

1. В Organizer: **Distribute App**
2. Выбери **App Store Connect**
3. Метод распространения: **Upload**
4. Следуй инструкциям
5. Дождись окончания загрузки

### 10.8. Отправить на ревью

1. Открой **App Store Connect** в браузере
2. Перейди в **ContextFlow → macOS (или iOS) → готовый к отправке билд**
3. В разделе **Build** — выбери загруженный билд
4. Заполни:
   - Скриншоты
   - Описание
   - Ключевые слова
   - Support URL
   - Marketing URL (опционально)
5. Раздел **App Review Information**:
   - **Notes for Reviewer**:
     ```
     This is a Safari Web Extension that provides an AI chat sidebar
     for web pages. The extension uses StoreKit 2 for in-app
     subscriptions. To test purchases, use a Sandbox Apple ID.

     Two subscription products:
     - BYOK License ($1.99/mo): Use your own OpenAI API key
     - Pro ($6.99/mo): Full AI access, no API key needed
     ```
   - **Demo Account** (если нужен для ревью): укажи тестовый логин/пароль Supabase
6. Нажми **Submit for Review**

---

## Часть 11. После ревью

### 11.1. Типичные причины отклонения и решения

| Причина | Решение |
|---------|---------|
| Нет кнопки "Restore Purchases" | Уже есть в PaywallModal ✅ |
| Используется внешняя платёжная система | Safari-билд использует StoreKit ✅ |
| Нет Privacy Policy | Добавь URL в App Store Connect |
| Приложение-пустышка (контейнер ничего не делает) | Нормально для Safari Web Extensions — Apple принимает |
| Нет описания подписки | Заполни Subscription Description в ASC |
| Расширение не работает | Протестируй полный флоу перед сабмитом |

### 11.2. Если приложение одобрено

1. В App Store Connect нажми **Release This Version**
2. Или настрой автоматический релиз после одобрения

### 11.3. Обновление расширения в будущем

```bash
# 1. Внести изменения в код
# 2. Пересобрать
pnpm build --target=safari-mv3

# 3. Скопировать в Xcode-проект
cp -R build/safari-mv3-prod/* \
  ContextFlow/"ContextFlow Extension"/Resources/

# 4. Увеличить Build number в Xcode
# 5. Archive → Upload → Submit for Review
```

---

## Краткая сводка: все команды по порядку

```bash
# === На Mac ===

# 1. Клонировать и установить
git clone https://github.com/AlexLA-dev/AI_sidebar.git
cd AI_sidebar
git checkout claude/appstore-subscriptions-release-WbgYs
pnpm install

# 2. Собрать для Safari
pnpm build --target=safari-mv3

# 3. Сконвертировать в Xcode-проект
xcrun safari-web-extension-converter ./build/safari-mv3-prod \
  --app-name "ContextFlow" \
  --bundle-identifier "com.contextflow.app" \
  --swift \
  --copy-resources \
  --force

# 4. Открыть в Xcode
open ContextFlow/ContextFlow.xcodeproj

# === Далее в Xcode ===
# 5. Добавить Swift-файлы из native/ContextFlow/Sources/
# 6. Добавить PrivacyInfo.xcprivacy
# 7. Добавить capability: In-App Purchase
# 8. Подключить ExtensionMessageHandler в ViewController.swift
# 9. Создать StoreKit Configuration File
# 10. Build & Run (Cmd+R) — тестирование
# 11. Product → Archive → Distribute App → App Store Connect
```

---

## Ссылки

- [Creating a Safari Web Extension (Apple)](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension)
- [Packaging a web extension for Safari (Apple)](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Packaging and distributing via App Store Connect](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)
- [StoreKit 2 (Apple)](https://developer.apple.com/storekit/)
- [Complete Safari Web Extension Guide (MV3, 2025)](https://www.qfqu.com/w/Building_and_Shipping_a_Safari_Web_Extension_on_macOS_(Manifest_V3,_2025_Edition):_A_Complete_Step-by-Step_Guide)
- [Converting Chrome Extensions to Safari (community)](https://gist.github.com/rxliuli/940584d75f55de3a4e9e2c5682bbcae8)
