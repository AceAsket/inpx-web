# 1.8.2-rc.14

## Изменения

Встроенная проверка производительности использует ограниченную пробу каталога
по первичному ключу. После таймаута следующая проба ждёт завершения предыдущей.
Это устраняет найденный в RC13 путь к исчерпанию heap потока базы на большой таблице.
Если поток всё же завершится, проверка останавливается, readiness показывает отказ,
а административные метрики процесса и контейнера остаются доступны. Записи не
повторяются автоматически; для восстановления каталога нужен перезапуск сервера.
В диагностике очереди ресурсов появились счётчики отказов по коду и виду операции
(`failedByCode`, `failedByKind`) и последний отказ. Категории ограничены, тексты
ошибок и содержимое запросов в метрики не включаются.

«Свои значения» проверяют один указанный набор параллельности. В форме есть общий
лимит, изображения, архивы и конвертации; значения проверяются по жёсткому бюджету.
Показаны текущая занятость CPU, память, пик и прирост во время проверки. Область
измерения подписана: контейнер или только Node.js. Нельзя менять профиль во время
проверки или копировать неверные значения. Для применения параметров запуска
контейнер по-прежнему пересоздаётся вручную. Подробнее: [профили ресурсов](resource-profiles.md).

Клик по книге в новом оформлении снова открывает превью поверх каталога или полки.
Закрытие не меняет текущий поиск; «Полная карточка» ведёт на отдельный `#/book`.
Вкладки и сведения об авторе используют общее оформление загрузки.
Отзывы и оценки показывают отдельные измеримые этапы; неизвестный объём не
превращается в выдуманный процент. Повтор после ошибки и старый API сохранены.

Подсказки поиска от трёх символов читают существующие индексы ограниченным запросом. Подготовки
полного каталога и повторного опроса больше нет: обычный поиск доступен сразу,
даже для короткого запроса по Enter и пока ответ с подсказками ещё не пришёл. Частичная выдача помечается; если
точное число книг в выбранных фильтрах неизвестно, число не показывается.
Выбор книги из подсказки открывает то же превью и сохраняет область поиска.

Галерея карточки больше не ждёт полной подготовки книги. Отдельный путь превью
возвращает до 18 иллюстраций: не более 2 МиБ на изображение и 8 МиБ суммарно,
при размере распакованного FB2 XML до 32 МиБ. Обложка и повторы исключаются;
изображение сверх лимита пропускается целиком. Ограничение показано рядом с галереей,
в том числе если подходящих для превью изображений нет. Остальные доступны в читалке.

Администратор может выбрать для Telegram прямое соединение, прокси из переменных
`HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` окружения сервера или свой HTTP/HTTPS/SOCKS5.
Адрес, порт и авторизация задаются отдельно; пароль хранится в SecretStore и
возвращается в форму только отметкой сохранения. «Проверить» сохраняет настройки
и проверяет выбранный маршрут. IPv4/IPv6 применяется к соединению с прокси;
в SOCKS5 — ещё и к локальному разрешению адреса Telegram. SOCKS5 с DNS через
прокси передаёт разрешение имени прокси-серверу. Настройки ОС и PAC не читаются.

Сохраняются изменения RC13: изоляция прогресса профилей, стабильные UID при обновлении
INPX, отдельное хранение фонов и бюджеты кэшей. [Диагностика стенда RC13](rc13-stand-review.md)
описывает отказ и повторные замеры после перезапуска.

## Обновление и проверки

- Основной образ: `aceasket/inpx-web-7z:1.8.2-rc.14`.
- Silero из того же исходного тега: `aceasket/inpx-web-7z:1.8.2-rc.14-silero`.
- [GitHub Release и standalone-файлы](https://github.com/AceAsket/inpx-web/releases/tag/v1.8.2-rc.14).
- Стабильный `latest` остаётся на 1.8.1. Опубликованный RC13 не заменяется RC14.

Перед обновлением сохраните резервную копию и прежние тома. Если DB worker уже
завершился в RC13, после обновления перезапустите сервер и дождитесь успешного
`/ready`. Не запускайте проверку производительности, пока каталог недоступен.
[Порядок обновления и отката](upgrade-rollback.md).

Регрессии покрывают отказ DB worker, ограниченные пробы, свои лимиты, события
прогресса и старый сервер. Браузерные сценарии проверяют превью и deep link,
вкладки, custom-форму и отмену. Полный CI, сборка платформенных артефактов и проверки
реальных конвертеров видны в [GitHub Actions](https://github.com/AceAsket/inpx-web/actions).

## English

RC14 fixes the catalog probe used by the performance check: it reads one primary-key
record instead of selecting the whole book table before applying a limit. Timed-out
probes do not overlap. A database-worker failure stops the check, reports an unavailable
catalog through readiness, and leaves process/container metrics accessible. Writes are
not retried automatically; restart the server to restore the catalog.
Resource diagnostics include bounded failure counters by code and operation kind
(`failedByCode`, `failedByKind`) and the last failure, without request contents or error messages.

Custom concurrency values are now tested and validated against the hard budget.
The UI shows CPU usage, memory, peak/delta and the measurement scope. It locks profile
selection while running and prevents invalid launch settings from being copied.
The check does not change the running configuration.

Clicking a book opens a preview again; the full `#/book` page remains available through
an explicit link. Author information uses the shared loading style. Reviews and ratings
show separate progress for measurable phases; unknown totals stay indeterminate.
Late events, retry after errors and servers without progress events are covered by regressions.

Search suggestions from three characters use bounded queries over existing indexes without a full-catalog
warmup or polling. Regular search, including short queries submitted with Enter, is available before suggestions arrive. Partial
results are labelled and unknown scoped counts are omitted. Selecting a book suggestion
opens its preview while retaining the search scope.

The card gallery reads a separate bounded preview instead of preparing the complete
book: up to 18 illustrations, 2 MiB per image, 8 MiB in total and 32 MiB of unpacked
FB2 XML. Covers and duplicates are excluded; oversized images are skipped whole.
Limited previews, including empty ones, are labelled. Other illustrations remain
available in the reader.

Administrators can choose direct Telegram access, server-environment proxies
(`HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`) or a custom HTTP/HTTPS/SOCKS5 proxy.
Host, port and authentication are separate fields; passwords stay in SecretStore
and are returned only as a saved-value marker. The connection test saves and uses
the selected route. IPv4/IPv6 controls the proxy connection and, with SOCKS5, local
destination lookup. SOCKS5h delegates destination DNS to the proxy. OS/PAC settings
are not read.

RC13 profile isolation, stable book identities, separate background files and bounded
caches remain included. Stable `latest` stays on 1.8.1. Published RC13 artifacts are unchanged.
