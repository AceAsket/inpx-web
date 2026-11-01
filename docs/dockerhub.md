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

**В версии 1.8.1:** совместный поиск по названию, автору, ключевым словам и форматам, ISBN-10/13 с вручную подготавливаемым индексом, независимые форматы скачивания/Email/Telegram/OPDS и отправка ZIP. Добавлены задачи, избранные авторы и серии, проверка библиотеки, таймер сна и переходы между текстом и аудио.

Карточки и галереи загружаются по необходимости; общий бюджет архивов, иллюстраций и конвертации ограничивает нагрузку. Доступны профили `auto`, `economy`, `balanced`, `performance` и экономия памяти через `INPX_LOW_MEMORY_MODE=true`. [Профили ресурсов](https://github.com/AceAsket/inpx-web/blob/v1.8.1/docs/resource-profiles.md).

Android-клиент подключается по QR с адресом без паролей. API поддерживает восстановление сессий, события чтения, быстрый снимок главной и отмену озвучки. Для остановки синтеза обновите основной контейнер и Silero. HTTP разрешён с предупреждением; HTTPS поддерживается через reverse proxy. [Контракт клиента](https://github.com/AceAsket/inpx-web/blob/v1.8.1/docs/native-client-protocol.md).

**MOBI:** встроенный лёгкий Kindling конвертирует FB2/EPUB в MOBI7/KF8 без Calibre. Опция выключена по умолчанию: для включения добавьте `-e INPX_MOBI_ENABLED=true` перед именем образа. Совместимость с конкретным Kindle остаётся экспериментальной. [Настройка и ограничения](https://github.com/AceAsket/inpx-web/blob/v1.8.1/README.md#лёгкая-конвертация-mobi-181-rc2).

### Образы и версии

| Тег | Назначение |
| --- | --- |
| `1.8.1` | Стабильный релиз с конвертацией книг. |
| `latest` | Стабильный основной образ; сейчас соответствует `1.8.1`. |
| `1.8.1-silero` | Отдельный сервис озвучки для стабильной версии. |
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
  aceasket/inpx-web-7z:1.8.1
```

Откройте `http://SERVER_IP:12380`. Пути `INPX` и `LIBDIR` указываются **внутри контейнера**. При первом запуске дождитесь индексации; её продолжительность зависит от размера библиотеки. Свой начальный пароль администратора задаётся через `INPX_ADMIN_PASSWORD`. На новой установке без этой настройки пароль генерируется и выводится в журнал запуска. При обновлении пароль существующего профиля сохраняется.

Каталог `/usr/local/bin/.inpx-web` должен быть постоянным: в нём хранятся настройки, профили, позиции чтения, закладки, списки, индекс и кэш. Книги монтируются отдельно, обычно только для чтения. При обновлении пересоздайте контейнер с новым тегом, сохранив свои тома, порты, сеть и переменные окружения.

### Папки и несколько библиотек

В 1.8.1 можно индексировать обычную папку FB2/EPUB без INPX. Добавьте к запуску образа `1.8.1`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"Мои книги","type":"folder","libDir":"/library"}]'
```

Для нескольких INPX-библиотек используйте массив источников:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"Первая библиотека","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Вторая библиотека","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

Это параметры `docker run`, их нужно вставить перед именем образа. После изменения источников выполните переиндексацию. [Настройка библиотек и Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Имена файлов и заголовки в 1.8.1

Основной образ включает fbc **1.9.0**. Добавьте параметры запуска, чтобы получить имя файла и заголовок книги для Kindle вида `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

Номер берётся из каталога. Для книги без номера блок с дефисом исчезнет. Для одного названия используйте `'${TITLE}'`. Первая настройка меняет имя файла, вторая — заголовок внутри EPUB/EPUB3/KEPUB/KFX/AZW8 при конвертации FB2. Без настроек сохраняется прежнее поведение. [Все поля шаблонов и настройки fbc](https://github.com/AceAsket/inpx-web/blob/develop/README.md#имя-файла-и-заголовок-книги).

### Озвучка Silero в 1.8.1

Озвучка **выключена по умолчанию** и включается переменными запуска основного контейнера:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Silero запускается отдельным CPU-контейнером `aceasket/inpx-web-7z:1.8.1-silero`. Оба контейнера должны находиться в одной пользовательской Docker-сети. Смонтируйте постоянный том в `/models`; модели загружаются при первом синтезе. Расстановка ударений через silero-stress включена по умолчанию. Текст передаётся вашему сервису Silero.

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

**In version 1.8.1:** combine title, author, keywords and formats; search validated ISBN-10/13 using a manually prepared index; choose independent download/Email/Telegram/OPDS formats and ZIP delivery. Includes tasks, favorite authors/series, library audit, a sleep timer and text/audio navigation.

Cards and galleries load on demand. A shared archive/image/conversion budget bounds resource use; choose `auto`, `economy`, `balanced` or `performance`, and use `INPX_LOW_MEMORY_MODE=true` on small hosts. [Resource profiles](https://github.com/AceAsket/inpx-web/blob/v1.8.1/docs/resource-profiles.md).

Connect Android through a QR containing the server address without credentials. The compatible API adds session resume, reading events, fast home snapshots and speech cancellation. Update both the web and Silero containers to stop synthesis. HTTP remains allowed with a warning; HTTPS works through a reverse proxy. [Client contract](https://github.com/AceAsket/inpx-web/blob/v1.8.1/docs/native-client-protocol.md).

**MOBI:** bundled lightweight Kindling converts FB2/EPUB to MOBI7/KF8 without Calibre. Disabled by default; add `-e INPX_MOBI_ENABLED=true` before the image name. Compatibility with a particular Kindle remains experimental. [Configuration and limitations](https://github.com/AceAsket/inpx-web/blob/v1.8.1/README.md#лёгкая-конвертация-mobi-181-rc2).

### Images and versions

| Tag | Purpose |
| --- | --- |
| `1.8.1` | Stable release with book conversion. |
| `latest` | Stable main image; currently points to `1.8.1`. |
| `1.8.1-silero` | Separate speech service for the stable release. |
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
  aceasket/inpx-web-7z:1.8.1
```

Open `http://SERVER_IP:12380`. `INPX` and `LIBDIR` must refer to paths **inside the container**. Wait for initial indexing; the time required depends on the library size. Set `INPX_ADMIN_PASSWORD` to supply your own initial admin password. On a new installation without this setting, a password is generated and printed in the startup log. Existing profile passwords are preserved on upgrade.

Keep `/usr/local/bin/.inpx-web` in a persistent volume: it stores settings, profiles, reading positions, bookmarks, lists, the index and caches. Mount your books separately, normally read-only. To update, recreate the container with the new image tag while preserving your volumes, ports, network and environment variables.

### Folders and multiple libraries

1.8.1 can index a folder of FB2/EPUB files without INPX. Add this option when running `1.8.1`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"My books","type":"folder","libDir":"/library"}]'
```

For multiple INPX libraries, specify an array of sources:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"First library","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Second library","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

These are `docker run` options; insert them before the image name. Reindex after changing sources. [Library configuration and Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Filenames and book titles in 1.8.1

The main image includes fbc **1.9.0**. Add these launch options to get a filename and Kindle book title such as `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

The series number comes from the catalogue. The number and separator disappear for unnumbered books. Use `'${TITLE}'` for the title alone. The first option changes download filenames; the second changes internal EPUB/EPUB3/KEPUB/KFX/AZW8 titles when converting FB2. Existing behavior is preserved when these options are unset. [Template fields and fbc settings](https://github.com/AceAsket/inpx-web/blob/develop/README.md#имя-файла-и-заголовок-книги).

### Silero speech in 1.8.1

Speech is **disabled by default**. Enable it through the main container's startup environment:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Run Silero as a separate CPU service using `aceasket/inpx-web-7z:1.8.1-silero`. Place both containers on the same user-defined Docker network. Mount a persistent volume at `/models`; models are downloaded on the first synthesis request. Stress placement with silero-stress is enabled by default. Book text is sent to your own Silero service.

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
