# INPX Web

[Русский](#русский) · [English](#english) · [GitHub](https://github.com/AceAsket/inpx-web) · [Releases](https://github.com/AceAsket/inpx-web/releases)

## Русский

Веб-каталог домашней электронной библиотеки со встроенной FB2-читалкой. Работает с INPX-индексами и книгами в ZIP/7z, включая коллекции fLibrary. Подходит для Docker, Unraid, Proxmox LXC и домашних серверов.

### Возможности

- Поиск по автору, названию, серии, жанру, языку и источнику; несколько библиотек в одном каталоге.
- Обложки и их кэширование, поддержка WebP и JXL.
- Чтение FB2 в браузере: темы, шрифты, закладки, заметки, сохранение позиции и отдельный PWA-ярлык читалки.
- Профили читателей, личные списки, отметки «прочитано», OPDS и персональные OPDS-ссылки.
- Конвертация в EPUB, EPUB3, KEPUB, KFX, AZW8 и PDF в основном образе через fb2cng и MuPDF.
- Отправка книг в Telegram и по электронной почте при настройке доставки.
- Панель администратора, журнал событий, резервное копирование и восстановление, управление источниками, health checks и метрики Prometheus.

**В версии 1.8.0:** компактный мобильный поиск, библиотеки из обычных папок FB2/EPUB без INPX, умные полки по фильтрам, ZIP-скачивание подборок, защита прогресса от устаревшего устройства, перенос позиции недоступной книги на выбранную замену и провайдер метаданных Audiobookshelf. Опциональная серверная озвучка русских FB2 через Silero: по главам, проба голоса, настройка пауз, высоты голоса и произношения, сохранение позиции аудио, скорость воспроизведения в плеере.

В 1.8.0 исправлены пустые страницы результатов поиска: списки веб-интерфейса и OPDS используют те же правила поиска по словам, что и сервер.

**Для проверки MOBI в 1.8.1-rc.10:** используйте этот тег основного образа и добавьте `-e INPX_MOBI_ENABLED=true` перед именем образа. Лёгкий Kindling уже включён в образ; Calibre не требуется. FB2 конвертируется через промежуточный EPUB, готовый EPUB — напрямую. По умолчанию опция выключена, настраивается только при запуске. Результат содержит MOBI7/KF8; совместимость с конкретным Kindle экспериментальная. [Параметры и ограничения](https://github.com/AceAsket/inpx-web/blob/develop/README.md#лёгкая-конвертация-mobi-181-rc2).

**Начиная с RC5:** внизу каталога рядом с версией добавлена ссылка на [Telegram-сообщество форка](https://t.me/inpxweb), доступная также на мобильных экранах.

**Начиная с RC6:** профили ресурсов `auto`, `economy`, `balanced`, `performance`, общий бюджет архивов, изображений и конвертации и ручной бенчмарк с рекомендуемым пресетом. Настройки задаются через `INPX_RESOURCE_*` при запуске контейнера; интерфейс готовит параметры Docker/Compose. [Настройка и ограничения](https://github.com/AceAsket/inpx-web/blob/develop/docs/resource-profiles.md).

**Начиная с RC3:** авторы и серии в описании книги OPDS стали ссылками на соответствующие разделы каталога. Выбранный профиль сохраняется при переходах; поддерживаются соавторы, несколько серий FB2 и ссылки в метаданных Atom.

**Начиная с RC7:** карточка FB2 открывается сразу, описание и отзывы загружаются отдельно, галерея — при прокрутке к ней. Кэш учитывает обновление индекса и источника; фоновая подготовка соблюдает ресурсные лимиты, устаревшие ответы закрытых карточек игнорируются.

**В RC8:** формат скачивания и отправки задаётся отдельно в настройках каждого профиля. Добавлен приоритет карточек и чтения перед обложками списка; фоновая очередь ограничена, закрытые запросы снимаются сразу, временно отсутствующие каталоги NAS проверяются повторно.

**В RC9:** независимые форматы скачивания, Email, Telegram и OPDS; отдельная упаковка в ZIP для Email и Telegram. В персональном OPDS выбранный формат предлагается первым, остальные варианты сохраняются.

### Образы и версии

| Тег | Назначение |
| --- | --- |
| `1.8.0` | Стабильный релиз с конвертацией книг. |
| `latest` | Стабильный основной образ; сейчас соответствует `1.8.0`. |
| `1.8.0-silero` | Отдельный сервис озвучки для стабильной версии. |
| `1.8.1-rc.10` | Фильтр числа голосов, полки и отзывы OPDS, Tolino, совместимость удалённых библиотек и резервная копия перед обновлением. |
| `1.8.1-rc.10-silero` | Сервис озвучки для RC; существующий Silero из 1.8.0 совместим. |
| `lite`, `*-lite` | Облегчённые сборки без конвертации; их версии могут отставать от основного образа. |

Опубликованные образы предназначены для Linux x64 (`linux/amd64`). Для воспроизводимой установки используйте конкретный тег версии. RC — предварительные сборки; история изменений доступна в [CHANGELOG](https://github.com/AceAsket/inpx-web/blob/develop/CHANGELOG.md).

### Быстрый запуск

Замените пути на свои. В `/path/to/library` должны находиться INPX-индекс и архивы библиотеки.

```sh
docker run -d \
  --name inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -v /path/to/data:/usr/local/bin/.inpx-web \
  -v /path/to/library:/library:ro \
  aceasket/inpx-web-7z:1.8.0
```

Откройте `http://SERVER_IP:12380`. Пути `INPX` и `LIBDIR` указываются **внутри контейнера**. При первом запуске дождитесь индексации; её продолжительность зависит от размера библиотеки. Свой начальный пароль администратора задаётся через `INPX_ADMIN_PASSWORD`. На новой установке без этой настройки пароль генерируется и выводится в журнал запуска. При обновлении пароль существующего профиля сохраняется.

Каталог `/usr/local/bin/.inpx-web` должен быть постоянным: в нём хранятся настройки, профили, позиции чтения, закладки, списки, индекс и кэш. Книги монтируются отдельно, обычно только для чтения. При обновлении пересоздайте контейнер с новым тегом, сохранив свои тома, порты, сеть и переменные окружения.

### Папки и несколько библиотек

В 1.8.0 можно индексировать обычную папку FB2/EPUB без INPX. Добавьте к запуску образа `1.8.0`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"Мои книги","type":"folder","libDir":"/library"}]'
```

Для нескольких INPX-библиотек используйте массив источников:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"Первая библиотека","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Вторая библиотека","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

Это параметры `docker run`, их нужно вставить перед именем образа. После изменения источников выполните переиндексацию. [Настройка библиотек и Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Имена файлов и заголовки в 1.8.0

Основной образ включает fbc **1.9.0**. Добавьте параметры запуска, чтобы получить имя файла и заголовок книги для Kindle вида `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

Номер берётся из каталога. Для книги без номера блок с дефисом исчезнет. Для одного названия используйте `'${TITLE}'`. Первая настройка меняет имя файла, вторая — заголовок внутри EPUB/EPUB3/KEPUB/KFX/AZW8 при конвертации FB2. Без настроек сохраняется прежнее поведение. [Все поля шаблонов и настройки fbc](https://github.com/AceAsket/inpx-web/blob/develop/README.md#имя-файла-и-заголовок-книги).

### Озвучка Silero в 1.8.0

Озвучка **выключена по умолчанию** и включается переменными запуска основного контейнера:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Silero запускается отдельным CPU-контейнером `aceasket/inpx-web-7z:1.8.0-silero`. Оба контейнера должны находиться в одной пользовательской Docker-сети. Смонтируйте постоянный том в `/models`; модели загружаются при первом синтезе. Расстановка ударений через silero-stress включена по умолчанию. Текст передаётся вашему сервису Silero.

[Готовые команды и Compose для Silero](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md).

### Полезные настройки

| Переменная | Назначение |
| --- | --- |
| `DATA_DIR` | Данные приложения; по умолчанию `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX-индекс и архивы одной библиотеки. |
| `INPX_LIBRARY_SOURCES` | Несколько источников INPX и папки FB2/EPUB. |
| `INPX_ADMIN_PASSWORD` | Пароль администратора при создании профиля. |
| `INPX_COVER_CACHE_SIZE_MB` | Лимит кэша обложек; по умолчанию `512` МБ. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Включение Silero и адрес сервиса. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Включение и токен провайдера Audiobookshelf. |
| `INPX_METRICS_ENABLED` | Метрики Prometheus при значении `true`. |

OPDS: `http://SERVER_IP:12380/opds`. Проверка состояния: `/health`, `/ready`, `/api/index-status`; метрики: `/metrics`, если включены. Для внешнего доступа поддерживается авторизация за доверенным reverse proxy — [документация](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

Книги и архивы библиотек в образ не входят. Полный резервный архив приложения не содержит библиотеку, поисковый индекс и временные кэши: сами книги сохраняйте отдельно.

---

## English

A self-hosted web catalog for your ebook library with a built-in FB2 reader. Supports INPX indexes and ZIP/7z book archives, including fLibrary collections. Suitable for Docker, Unraid, Proxmox LXC and home servers.

### Features

- Search by author, title, series, genre, language and source; multiple libraries in one catalog.
- Cover extraction and caching, including WebP and JXL support.
- Browser-based FB2 reading with themes, fonts, bookmarks, notes, saved positions and a dedicated reader PWA shortcut.
- Reader profiles, personal lists, read/unread marks, OPDS and profile-specific OPDS links.
- Conversion to EPUB, EPUB3, KEPUB, KFX, AZW8 and PDF in the main image using fb2cng and MuPDF.
- Send books through Telegram or email when delivery is configured.
- Admin dashboard, event log, backup/restore, source management, health checks and Prometheus metrics.

**In version 1.8.0:** compact mobile search, index folders of FB2/EPUB files without INPX, filter-based smart shelves, ZIP downloads of book selections, protection against stale progress updates, manual replacement of unavailable books while keeping reading positions, and an Audiobookshelf metadata provider. Optional server-side Russian FB2 speech using Silero includes chapter playback, voice previews, pause/pitch/pronunciation settings, saved audio positions and playback speed control in the player.

**Test MOBI in 1.8.1-rc.10:** use that main image tag and add `-e INPX_MOBI_ENABLED=true` before the image name. The bundled lightweight Kindling converter needs no Calibre. FB2 uses an intermediate EPUB; existing EPUB converts directly. This launch-only option is off by default. Output contains both MOBI7 and KF8; compatibility with your particular Kindle remains experimental. [Configuration and limitations](https://github.com/AceAsket/inpx-web/blob/develop/README.md#лёгкая-конвертация-mobi-181-rc2).

Version 1.8.0 fixes empty search-result pages: web lists and OPDS use the same word-matching rules as the server.

**Since RC5:** the catalog footer includes a link to the [fork’s Telegram community](https://t.me/inpxweb), also available on mobile screens.

**Since RC6:** launch-time resource profiles (`auto`, `economy`, `balanced`, `performance`), a shared budget for archives, images and conversion, and a manual benchmark with preset recommendations. Configure `INPX_RESOURCE_*` when starting the container; the admin panel prepares Docker/Compose parameters. [Configuration and limitations](https://github.com/AceAsket/inpx-web/blob/develop/docs/resource-profiles.md).

**Since RC3:** authors and series in OPDS book descriptions link to their catalog feeds. Navigation preserves the selected profile and supports coauthors, multiple FB2 series and Atom metadata links.

**Since RC7:** FB2 cards open immediately, descriptions and reviews load separately, and the gallery loads when scrolled into view. Card caches track index/source changes, background preparation respects resource limits, and closed cards discard stale responses.

**RC8:** each profile can choose its default download and delivery format. Cards and reading take priority over list covers; the background queue is bounded, closed requests leave it immediately, and missing NAS directories are checked again.

**RC9:** independent formats for downloads, Email, Telegram and OPDS, with separate ZIP delivery options for Email and Telegram. Personal OPDS feeds offer the preferred format first and keep the other available formats.

### Images and versions

| Tag | Purpose |
| --- | --- |
| `1.8.0` | Stable release with book conversion. |
| `latest` | Stable main image; currently points to `1.8.0`. |
| `1.8.0-silero` | Separate speech service for the stable release. |
| `1.8.1-rc.10` | Vote count filters, OPDS shelves and reviews, Tolino, remote library compatibility and pre-upgrade snapshots. |
| `1.8.1-rc.10-silero` | Speech service for the RC; existing Silero 1.8.0 remains compatible. |
| `lite`, `*-lite` | Smaller builds without conversion; their versions may lag behind the main image. |

Published images target Linux x64 (`linux/amd64`). Pin a version tag for reproducible deployments. RC tags are prereleases; see the [CHANGELOG](https://github.com/AceAsket/inpx-web/blob/develop/CHANGELOG.md) for changes.

### Quick start

Replace the host paths below. `/path/to/library` must contain your INPX index and book archives.

```sh
docker run -d \
  --name inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -v /path/to/data:/usr/local/bin/.inpx-web \
  -v /path/to/library:/library:ro \
  aceasket/inpx-web-7z:1.8.0
```

Open `http://SERVER_IP:12380`. `INPX` and `LIBDIR` must refer to paths **inside the container**. Wait for initial indexing; the time required depends on the library size. Set `INPX_ADMIN_PASSWORD` to supply your own initial admin password. On a new installation without this setting, a password is generated and printed in the startup log. Existing profile passwords are preserved on upgrade.

Keep `/usr/local/bin/.inpx-web` in a persistent volume: it stores settings, profiles, reading positions, bookmarks, lists, the index and caches. Mount your books separately, normally read-only. To update, recreate the container with the new image tag while preserving your volumes, ports, network and environment variables.

### Folders and multiple libraries

1.8.0 can index a folder of FB2/EPUB files without INPX. Add this option when running `1.8.0`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"My books","type":"folder","libDir":"/library"}]'
```

For multiple INPX libraries, specify an array of sources:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"First library","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Second library","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

These are `docker run` options; insert them before the image name. Reindex after changing sources. [Library configuration and Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Filenames and book titles in 1.8.0

The main image includes fbc **1.9.0**. Add these launch options to get a filename and Kindle book title such as `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

The series number comes from the catalogue. The number and separator disappear for unnumbered books. Use `'${TITLE}'` for the title alone. The first option changes download filenames; the second changes internal EPUB/EPUB3/KEPUB/KFX/AZW8 titles when converting FB2. Existing behavior is preserved when these options are unset. [Template fields and fbc settings](https://github.com/AceAsket/inpx-web/blob/develop/README.md#имя-файла-и-заголовок-книги).

### Silero speech in 1.8.0

Speech is **disabled by default**. Enable it through the main container's startup environment:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Run Silero as a separate CPU service using `aceasket/inpx-web-7z:1.8.0-silero`. Place both containers on the same user-defined Docker network. Mount a persistent volume at `/models`; models are downloaded on the first synthesis request. Stress placement with silero-stress is enabled by default. Book text is sent to your own Silero service.

[Silero commands and Compose instructions](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md).

### Useful settings

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | App data; defaults to `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX index and archives for a single library. |
| `INPX_LIBRARY_SOURCES` | Multiple INPX sources and FB2/EPUB folders. |
| `INPX_ADMIN_PASSWORD` | Initial admin profile password. |
| `INPX_COVER_CACHE_SIZE_MB` | Cover cache limit; defaults to `512` MB. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Enable Silero and set its service URL. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Enable the Audiobookshelf provider and set its token. |
| `INPX_METRICS_ENABLED` | Enable Prometheus metrics with `true`. |

OPDS: `http://SERVER_IP:12380/opds`. Health endpoints: `/health`, `/ready`, `/api/index-status`; metrics: `/metrics` when enabled. Authentication behind a trusted reverse proxy is supported for external access — see the [documentation](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

Book collections are not included in the image. Full application backups exclude book files, the search index and temporary caches; back up your library separately.

## Links

- [Source code and documentation](https://github.com/AceAsket/inpx-web)
- [Release downloads](https://github.com/AceAsket/inpx-web/releases)
- [Report an issue](https://github.com/AceAsket/inpx-web/issues)
- [Silero setup](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md)
