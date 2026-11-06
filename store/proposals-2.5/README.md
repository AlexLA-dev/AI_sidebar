# Подзаголовок и ключевые слова 2.5: предложение, не финал

Решает владелец, это открытый вопрос на доске «ContextFlow · Штаб». Директор спросит его вместе с подачей 2.5.
Пока решения нет, в `store/metadata/<locale>/subtitle.txt` и `keywords.txt` остаются значения 2.4, как они стоят в App Store Connect.

Источник: cpp-plan.md §5 (заметки store-pages): ключевые слова сведены с кластерами Apple Ads G1–G6.

| Локаль | Подзаголовок | Ключевые слова |
|---|---|---|
| en-US, en-CA | Summarize & ask any web page (было «Summarize, ask & take notes») | `subtitle/`, `keywords/` |
| en-GB, en-AU | Summarise & ask any web page (было «Summarise, ask & take notes») | то же, с `summariser` |
| ru | без изменений: «Пересказ, вопросы, заметки» | `keywords/ru.txt` |
| остальные 10 | без изменений | без изменений |

Что даёт:
- clipboard, history — кластер G5 (быстрая вставка, «Скопированное»);
- price, tracker, stock — кластер G6 (слежение за ценой);
- shopping — G3;
- pdf — G2 (это Pro: у него есть честная Pro-страница; если владелец против, вместо `pdf` поставить `tags`).

Что уходит и почему:
- translate / переводчик: в выдаче большие переводчики, своего кластера нет;
- summary, assistant, chat, reader, explain, research, browser: слабый спрос или слова уже есть в названии и подзаголовке;
- «notes» в EN переезжает из подзаголовка в ключевые слова.

Лимиты: подзаголовок ≤ 30 символов, ключевые слова ≤ 100 (здесь 96–98).
