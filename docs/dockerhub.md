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

**В предварительной ветке 1.7.9:** компактный мобильный поиск, библиотеки из обычных папок FB2/EPUB без INPX, умные полки по фильтрам, ZIP-скачивание подборок, защита прогресса от устаревшего устройства, перенос позиции недоступной книги на выбранную замену и провайдер метаданных Audiobookshelf. Опциональная серверная озвучка русских FB2 через Silero: по главам, проба голоса, настройка пауз, высоты голоса и произношения, сохранение позиции аудио, скорость воспроизведения в плеере.

### Образы и версии

| Тег | Назначение |
| --- | --- |
| `1.7.8` | Стабильный релиз с конвертацией книг. |
| `latest` | Стабильный основной образ; сейчас соответствует `1.7.8`. |
| `1.7.9-rc.16` | Текущий предварительный релиз для проверки новых возможностей. |
| `1.7.9-rc.16-silero` | Отдельный сервис озвучки для предварительного релиза. |
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
  aceasket/inpx-web-7z:1.7.8
```

Откройте `http://SERVER_IP:12380`. Пути `INPX` и `LIBDIR` указываются **внутри контейнера**. При первом запуске дождитесь индексации; её продолжительность зависит от размера библиотеки. Свой начальный пароль администратора задаётся через `INPX_ADMIN_PASSWORD`. Без этой настройки в стабильной `1.7.8` используется `admin/admin`, а на новой установке RC16 пароль генерируется и выводится в журнал запуска.

Каталог `/usr/local/bin/.inpx-web` должен быть постоянным: в нём хранятся настройки, профили, позиции чтения, закладки, списки, индекс и кэш. Книги монтируются отдельно, обычно только для чтения. При обновлении пересоздайте контейнер с новым тегом, сохранив свои тома, порты, сеть и переменные окружения.

### Папки и несколько библиотек

В RC16 можно индексировать обычную папку FB2/EPUB без INPX. Добавьте к запуску образа `1.7.9-rc.16`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"Мои книги","type":"folder","libDir":"/library"}]'
```

Для нескольких INPX-библиотек используйте массив источников:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"Первая библиотека","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Вторая библиотека","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

Это параметры `docker run`, их нужно вставить перед именем образа. После изменения источников выполните переиндексацию. [Настройка библиотек и Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Озвучка Silero в RC16

Озвучка **выключена по умолчанию** и включается переменными запуска основного контейнера:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Silero запускается отдельным CPU-контейнером `aceasket/inpx-web-7z:1.7.9-rc.16-silero`. Оба контейнера должны находиться в одной пользовательской Docker-сети. Смонтируйте постоянный том в `/models`; модели загружаются при первом синтезе. Расстановка ударений через silero-stress включена по умолчанию. Текст передаётся вашему сервису Silero.

[Готовые команды и Compose для Silero](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md).

### Полезные настройки

| Переменная | Назначение |
| --- | --- |
| `DATA_DIR` | Данные приложения; по умолчанию `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX-индекс и архивы одной библиотеки. |
| `INPX_LIBRARY_SOURCES` | Несколько источников; в RC также папки FB2/EPUB. |
| `INPX_ADMIN_PASSWORD` | Пароль администратора при создании профиля. |
| `INPX_COVER_CACHE_SIZE_MB` | Лимит кэша обложек; по умолчанию `512` МБ. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Включение Silero и адрес сервиса в RC. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Включение и токен провайдера Audiobookshelf в RC. |
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

**In the 1.7.9 prerelease branch:** compact mobile search, index folders of FB2/EPUB files without INPX, filter-based smart shelves, ZIP downloads of book selections, protection against stale progress updates, manual replacement of unavailable books while keeping reading positions, and an Audiobookshelf metadata provider. Optional server-side Russian FB2 speech using Silero includes chapter playback, voice previews, pause/pitch/pronunciation settings, saved audio positions and playback speed control in the player.

### Images and versions

| Tag | Purpose |
| --- | --- |
| `1.7.8` | Stable release with book conversion. |
| `latest` | Stable main image; currently points to `1.7.8`. |
| `1.7.9-rc.16` | Current prerelease for testing new features. |
| `1.7.9-rc.16-silero` | Separate speech service for the prerelease. |
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
  aceasket/inpx-web-7z:1.7.8
```

Open `http://SERVER_IP:12380`. `INPX` and `LIBDIR` must refer to paths **inside the container**. Wait for initial indexing; the time required depends on the library size. Set `INPX_ADMIN_PASSWORD` to supply your own initial admin password. Without this setting, stable `1.7.8` uses `admin/admin`, while a new RC16 installation generates a password and prints it in the startup log.

Keep `/usr/local/bin/.inpx-web` in a persistent volume: it stores settings, profiles, reading positions, bookmarks, lists, the index and caches. Mount your books separately, normally read-only. To update, recreate the container with the new image tag while preserving your volumes, ports, network and environment variables.

### Folders and multiple libraries

RC16 can index a folder of FB2/EPUB files without INPX. Add this option when running `1.7.9-rc.16`:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"My books","type":"folder","libDir":"/library"}]'
```

For multiple INPX libraries, specify an array of sources:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"First library","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Second library","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

These are `docker run` options; insert them before the image name. Reindex after changing sources. [Library configuration and Docker Compose](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

### Silero speech in RC16

Speech is **disabled by default**. Enable it through the main container's startup environment:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Run Silero as a separate CPU service using `aceasket/inpx-web-7z:1.7.9-rc.16-silero`. Place both containers on the same user-defined Docker network. Mount a persistent volume at `/models`; models are downloaded on the first synthesis request. Stress placement with silero-stress is enabled by default. Book text is sent to your own Silero service.

[Silero commands and Compose instructions](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md).

### Useful settings

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | App data; defaults to `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX index and archives for a single library. |
| `INPX_LIBRARY_SOURCES` | Multiple sources; RC also supports FB2/EPUB folders. |
| `INPX_ADMIN_PASSWORD` | Initial admin profile password. |
| `INPX_COVER_CACHE_SIZE_MB` | Cover cache limit; defaults to `512` MB. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Enable Silero and set its service URL in RC. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Enable the Audiobookshelf provider and set its token in RC. |
| `INPX_METRICS_ENABLED` | Enable Prometheus metrics with `true`. |

OPDS: `http://SERVER_IP:12380/opds`. Health endpoints: `/health`, `/ready`, `/api/index-status`; metrics: `/metrics` when enabled. Authentication behind a trusted reverse proxy is supported for external access — see the [documentation](https://github.com/AceAsket/inpx-web/blob/develop/README.md).

Book collections are not included in the image. Full application backups exclude book files, the search index and temporary caches; back up your library separately.

## Links

- [Source code and documentation](https://github.com/AceAsket/inpx-web)
- [Release downloads](https://github.com/AceAsket/inpx-web/releases)
- [Report an issue](https://github.com/AceAsket/inpx-web/issues)
- [Silero setup](https://github.com/AceAsket/inpx-web/blob/develop/docs/silero-tts.md)
