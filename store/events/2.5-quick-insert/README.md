# In-App Event 2.5: «Quick Insert in Safari» (Major Update)

Материалы к шагу 1 плана pro-audiences-2.5-plan.md: событие к выходу 2.5 и номинация на фичеринг (`nomination.md`).
Создаёт и подаёт директор в App Store Connect, это уровень 2. Здесь ничего не загружено.

## Настройки события

| Поле | Значение |
|---|---|
| Reference name (внутреннее, ≤64) | 2.5 Major Update: Quick Insert in Safari |
| Badge | Major Update: в 2.5 действительно новые функции, а не правки интерфейса |
| Purpose | Appropriate for All Users |
| Priority | High (других событий нет) |
| In-App Purchase required | No: быстрая вставка есть и бесплатно |
| Deep link | contextflow://templates: «Open» открывает вкладку «Шаблоны» (Apple требует ссылку при подаче) |
| Primary language | en-US |
| Страны | все |
| Начало | когда 2.5 выйдет в App Store |
| Конец | через 31 день после начала (максимум у Apple) |
| Публикация | одновременно с началом: показывать функцию до выхода 2.5 нельзя |

## Тексты (название ≤30, короткое ≤50, длинное ≤120)

en-GB, en-AU и en-CA — как en-US, es-MX — как es-ES. Все 15 локалей лежат в `event.json`.

| Локаль | Название | Короткое описание | Длинное описание |
|---|---|---|---|
| en-US | Quick Insert in Safari | Templates and recent copies by any text field | New in ContextFlow 2.5: templates fill in names and dates from the page, and what you copied waits by every field. |
| ru | Быстрая вставка в Safari | Шаблоны и скопированное у любого поля | Новое в ContextFlow 2.5: шаблон сам впишет имя и дату со страницы, а скопированное ждёт у любого поля. |
| uk | Швидка вставка в Safari | Шаблони і скопійоване біля будь-якого поля | Нове в ContextFlow 2.5: шаблон сам впише ім’я і дату зі сторінки, а скопійоване чекає біля будь-якого поля. |
| de-DE | Schnelleinfügen in Safari | Vorlagen und Kopiertes an jedem Textfeld | Neu in ContextFlow 2.5: Vorlagen tragen Namen und Datum von der Seite ein, Kopiertes wartet an jedem Feld. |
| fr-FR | Insertion rapide dans Safari | Modèles et copies récentes près de chaque champ | Nouveau dans ContextFlow 2.5 : les modèles reprennent noms et dates de la page, vos copies attendent à chaque champ. |
| es-ES | Inserción rápida en Safari | Plantillas y lo copiado junto a cada campo | Novedad en ContextFlow 2.5: las plantillas rellenan nombres y fechas con la página, y lo copiado espera en cada campo. |
| it | Inserimento rapido in Safari | Modelli e testi copiati accanto a ogni campo | Novità di ContextFlow 2.5: i modelli inseriscono nomi e date dalla pagina e i testi copiati sono pronti in ogni campo. |
| pt-BR | Inserção rápida no Safari | Modelos e textos copiados ao lado de cada campo | Novidade no ContextFlow 2.5: modelos preenchem nomes e datas pela página, e o que você copiou fica em cada campo. |
| ja | Safari でクイック挿入 | どの入力欄にもテンプレートとコピー履歴 | ContextFlow 2.5 の新機能：テンプレートが名前や日付をページから入力し、コピーしたテキストもどの入力欄にもすぐ挿入できます。 |
| ko | Safari에서 빠른 삽입 | 모든 입력란 옆에 템플릿과 복사한 항목 | ContextFlow 2.5 새 기능: 템플릿이 페이지에서 이름과 날짜를 채우고, 복사한 항목은 어느 입력란에나 바로 넣을 수 있습니다. |
| zh-Hans | Safari 快速插入 | 任何输入框旁都有模板和已复制内容 | ContextFlow 2.5 新功能：模板从网页填写姓名和日期，复制过的内容在任何输入框旁一点即可插入。 |

## Медиа

| Что | Размер | en-US | ru |
|---|---|---|---|
| Карточка события (16:9) | 1920×1080 PNG | `en-US/event-card-1920x1080.png` | `ru/event-card-1920x1080.png` |
| Страница события (9:16) | 1080×1920 PNG | `en-US/event-details-1080x1920.png` | `ru/event-details-1080x1920.png` |

- Остальные локали показывают медиа en-US.
- Взято из кадров 2.5, без подписей и плашек. Apple просит не класть текст поверх медиа события и сама добавляет затемнение.
- Карточка: шаблон, заполненный из переписки на Mac (жёлтые имя, дата и время). Заполненный шаблон стоит в середине, потому что внизу Apple пишет название события.
- Страница события: iPhone, поле с синей кнопкой быстрой вставки и список «Скопированное». Всё важное в верхних 60%, низ Apple размывает под текст.
- Как пересобрать: `node compose.mjs <raw> <out> <en|ru> event` (набор EVENT_SETS в tools/store/compose.mjs), затем обрезка в `~/ContextFlow-work/store-pages/event25/`.
