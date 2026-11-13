# Кастомная страница «Moving from Arc» (2.7, только английский)

Страница для тех, кто уходит с Arc обратно в Safari. Arc Search на iPhone теряет ИИ, потом перестаёт работать Arc для Mac. Этим людям нужен ИИ на странице, к которому они привыкли.

Название, подзаголовок и описание общие с основной страницей. У этой страницы свои:
- скриншоты;
- промо-текст;
- ключевые слова;
- баннеры iOS 27;
- ссылка `…?ppid=<id>` для рекламы и постов.

Загрузку и отправку на ревью делает директор.

## Arc нигде не назван

Ни в картинках, ни в текстах страницы Arc нет (правило App Store 2.3.7). Подписи говорят с людьми, которые уходят из Arc, о том, что они теряют:
- ИИ прямо на странице;
- пересказ;
- ответы из поиска с источниками;
- одни чаты на телефоне и Mac.

Название страницы в App Store Connect («2.7 Moving from Arc») видно только нам.

## Файлы

- **`page.json`** — название, аудитория, промо-текст, ключевые слова, порядок экранов.
- **Скриншоты** — `screenshots/en-US/<iphone|ipad>/NN-*.png`:
  - iPhone 6,9" 1290×2796, iPad 13" 2064×2752;
  - ленты для просмотра лежат в `…/<iphone|ipad>-preview.jpg`.
- **Баннеры iOS 27** — `creative/en-US/`:
  - `header.png` 21:9, 3840×1646;
  - `search.png` 3:2, 3840×2560.
- **Обзорный лист** — `contact-sheet.jpg`.

## Экраны

Каждый экран продаёт одну выгоду. Под заголовком — функция, которая её даёт, в настоящем интерфейсе 2.6. Увеличенная карточка ведёт к ней взгляд.

| # | Подпись | Что на экране |
|---|---|---|
| 1 | AI on the page, right in Safari | вопрос к статье «Would this work for a 10-person startup?» и ответ по странице; иконка приложения и плашка «No sign-up needed», как на первом экране версии |
| 2 | The key points of any page | пересказ: «In short» и первые пункты крупно |
| 3 | Ask the web, get answers with sources | ответ из Google с пронумерованными источниками |
| 4 | Same chats on iPhone, iPad, Mac | один чат на трёх устройствах, «Synced through iCloud» |
| 5 | **Ultra** · Cheaper options, every link checked | «Найти похожее» |

Баннеры:
- **header** — экран 1 (вопрос к странице);
- **search** — ключевые пункты пересказа, чтобы не повторять первый скриншот.

Цен, адресов и «бесплатно» на баннерах нет, адресная строка пустая.

## Промо-текст (160 из 170)

> Going back to Safari? ContextFlow puts AI on every page: ask about it, get the key points, search with sources, and keep the same chats on iPhone, iPad and Mac.

## Ключевые слова

Только из текущего английского списка приложения (`store/metadata/en-US/keywords.txt`). Названий конкурентов нет.

У этой страницы одно слово: **`extension`**. Люди, которые возвращаются в Safari, ищут расширения для него.

Остальные слова из списка уже у других страниц 2.6:
- shopping, price, tracker, stock — покупки;
- pdf, notes, article, tldr — учёба;
- clipboard — работа;
- listen — «Слушать»;
- translate — другие языки.

`summarizer` остаётся за основной страницей: её первый скриншот — пересказ.

## Как пересобрать

Скрипты лежат в `~/ContextFlow-work/store-pages/banners261/`. Оба берут `.claude/heavy.lock` сами.

```bash
./acap.sh              # две новые сцены (askpage, keypoints), iPhone и iPad, на Ultra-стенде → shots26r/raw-en
BANNERS=1 ./acmp.sh    # экраны (compose.mjs, набор cpp-arc) и баннеры (creative26.mjs, страница cpp-arc) → сюда
```
