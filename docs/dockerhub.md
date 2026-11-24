# INPX Web

[Русский](#русский) · [English](#english) · [GitHub](https://github.com/AceAsket/inpx-web) · [Releases](https://github.com/AceAsket/inpx-web/releases)

## Русский

Веб-каталог домашней электронной библиотеки со встроенной FB2-читалкой. Работает с INPX-индексами и книгами в ZIP/7z, включая коллекции fLibrary. Подходит для Docker, Unraid, Proxmox LXC и домашних серверов.

### Возможности

**Rust 2.0.3** добавляет настройки сервера без перезапуска, технический журнал с ротацией и отправку крупных вложений через локальный Telegram Bot API. Сервер поддерживает списки доверенных IPv4/IPv6-прокси в строке и в массиве. [История выпуска](https://github.com/AceAsket/inpx-web/releases/tag/v2.0.3)

- Превью книг и вкладки загружаются по запросу. Кэши ограничены, проверка производительности показывает CPU, память и время отклика. [Профили ресурсов](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/resource-profiles.md)
- Подсказки от трёх символов работают без подготовки и опроса; обычный поиск доступен сразу. Галерея: до 18 иллюстраций, 2 МиБ на изображение, 8 МиБ суммарно, 32 МиБ FB2 XML. Диагностика: `failedByCode`, `failedByKind`. Telegram: напрямую, через окружение сервера или свой HTTP(S)/SOCKS5; пароль хранится отдельно.
- Поиск по автору, названию, серии, жанру, языку и источнику; несколько библиотек в одном каталоге.
- Обложки и их кэширование, поддержка WebP и JXL.
- Чтение FB2 в браузере: темы, шрифты, закладки, заметки, сохранение позиции и отдельный PWA-ярлык читалки.
- Профили читателей, личные списки, отметки «прочитано», OPDS и персональные OPDS-ссылки.
- Конвертация в EPUB, EPUB3, KEPUB, KFX, AZW3, AZW8 и PDF в основном образе через fb2cng и MuPDF.
- Отправка книг в Telegram и по электронной почте при настройке доставки.
- Панель администратора, журнал событий, резервное копирование и восстановление, управление источниками, health checks и метрики Prometheus.

Совместный поиск поддерживает название, автора, ключевые слова, форматы и ISBN. Форматы скачивания, Email, Telegram и OPDS настраиваются отдельно. Интерактивный Telegram-бот выдаёт книги по личному Chat ID.

Профиль `unlimited` используется по умолчанию. В администрировании можно выбрать `auto`, `economy`, `balanced` или `performance`. [Профили ресурсов](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/resource-profiles.md)

Android-клиент подключается по QR с адресом без паролей. API поддерживает восстановление сессий, события чтения, быстрый снимок главной и отмену озвучки. Для остановки синтеза обновите основной контейнер и Silero. HTTP разрешён с предупреждением; HTTPS поддерживается через reverse proxy. [Контракт клиента](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/native-client-protocol.md).

Встроенный Kindling конвертирует FB2/EPUB в MOBI7/KF8. В полном образе MOBI включён по умолчанию. Отключение — `INPX_MOBI_ENABLED=false`. Совместимость зависит от модели Kindle. [Настройка MOBI](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md#лёгкая-конвертация-mobi-181-rc2)

### Образы и версии

Мы перенесли сервер с Node.js на Rust, чтобы он быстрее работал с большими библиотеками. **Node.js 1.8.3** — последняя ветка классического сервера. Она будет получать только исправления ошибок. Все новые функции будут выходить только в **Rust 2.x**.

Обновление с `latest` переводит существующую установку на Rust. Перед обновлением остановите сервер и скопируйте каталог данных. Для сохранения стабильного Node.js закрепите тег `1.8.3`. [Переход и откат](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/upgrade-rollback.md)

| Тег | Назначение |
| --- | --- |
| `2.0.3`, `latest` | Стабильный сервер Rust. |
| `1.8.3` | Стабильный классический сервер Node.js с JembaDB. |
| `1.8.3-silero` | Сервис озвучки для Node.js 1.8.3. |
| `2.0.3-silero` | Сервис озвучки для Rust 2.0.3. |

Опубликованные образы предназначены для Linux x64 (`linux/amd64`). Для воспроизводимой установки используйте конкретный тег версии. RC — предварительные сборки; история изменений доступна в [CHANGELOG](https://github.com/AceAsket/inpx-web/blob/v2.0.3/CHANGELOG.md).

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
  aceasket/inpx-web-7z:2.0.3
```

Откройте `http://SERVER_IP:12380`. Пути `INPX` и `LIBDIR` указываются **внутри контейнера**. При первом запуске дождитесь индексации; её продолжительность зависит от размера библиотеки. Свой начальный пароль администратора задаётся через `INPX_ADMIN_PASSWORD`. На новой установке без этой настройки пароль генерируется и выводится в журнал запуска. При обновлении пароль существующего профиля сохраняется.

Каталог `/usr/local/bin/.inpx-web` должен быть постоянным: в нём хранятся настройки, профили, позиции чтения, закладки, списки, индекс и кэш. Книги монтируются отдельно, обычно только для чтения. При обновлении пересоздайте контейнер с новым тегом, сохранив свои тома, порты, сеть и переменные окружения.

### Caddy на Synology

В Caddyfile укажите `reverse_proxy 192.168.31.97:12380` с адресом NAS. На NAS подставьте IP контейнера и откройте сайт через HTTPS.

```sh
sudo tcpdump -nni any -c 1 'dst host 172.18.0.2 and tcp dst port 12380 and tcp[tcpflags] & tcp-syn != 0'
```

Берите IP слева от `>` без порта. Для `172.18.0.1.54000` задайте `INPX_TRUST_PROXY: "true"` и `INPX_TRUSTED_PROXY_CIDRS: "172.18.0.1/32"`. Если это шлюз, доверием охвачены все соединения с его адреса. Сначала разрешите порт NAS только для Caddy. Пересоздайте сервис и проверьте статус `101` у `/ws`. [Пример Compose и проверка IP](https://github.com/AceAsket/inpx-web#caddy-и-docker-на-synology)

### Папки и несколько библиотек

Для индексации папки FB2/EPUB без INPX добавьте переменную окружения:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"Мои книги","type":"folder","libDir":"/library"}]'
```

Для нескольких INPX-библиотек используйте массив источников:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"Первая библиотека","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Вторая библиотека","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

Это параметры `docker run`, их нужно вставить перед именем образа. После изменения источников выполните переиндексацию. [Настройка библиотек и Docker Compose](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md).

### Имена файлов и заголовки

Основной образ включает fbc **2.1.1**. Добавьте параметры запуска, чтобы получить имя файла и заголовок книги для Kindle вида `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

Номер берётся из каталога. Для книги без номера блок с дефисом исчезнет. Для одного названия используйте `'${TITLE}'`. Первая настройка меняет имя файла, вторая — заголовок внутри EPUB/EPUB3/KEPUB/KFX/AZW3/AZW8 при конвертации FB2. Без настроек сохраняется прежнее поведение. [Все поля шаблонов и настройки fbc](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md#имя-файла-и-заголовок-книги).

### Озвучка Silero

Озвучка **выключена по умолчанию** и включается переменными запуска основного контейнера:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Silero запускается отдельным CPU-контейнером `aceasket/inpx-web-7z:2.0.3-silero`. Оба контейнера должны находиться в одной пользовательской Docker-сети. Смонтируйте постоянный том в `/models`; модели загружаются при первом синтезе. Расстановка ударений через silero-stress включена по умолчанию. Текст передаётся вашему сервису Silero.

[Готовые команды и Compose для Silero](https://github.com/AceAsket/inpx-web/blob/main/docs/silero-tts.md).

### Полезные настройки

| Переменная | Назначение |
| --- | --- |
| `DATA_DIR` | Данные приложения; по умолчанию `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX-индекс и архивы одной библиотеки. |
| `INPX_LIBRARY_SOURCES` | Несколько источников INPX и папки FB2/EPUB. |
| `INPX_ADMIN_PASSWORD` | Пароль администратора при создании профиля. |
| `INPX_RESET_ADMIN_PASSWORD` | Для восстановления доступа задайте `true` и новый `INPX_ADMIN_PASSWORD`. Пересоздайте контейнер с прежним томом данных. После сброса уберите флаг и снова пересоздайте контейнер. |
| `INPX_ALLOW_ANONYMOUS_ACCESS` | Задайте `false`, чтобы требовать вход в профиль для поиска, книг и обложек. В Node.js 1.8.2 и RC21 до входа видны меню и форма входа. |
| `INPX_REQUIRE_AUTH` | Значение `true` включает проверку пользователя доверенного reverse proxy в режиме `INPX_AUTH_MODE=proxy`. Для локального входа в Node.js 1.8.2 и RC21 задайте `INPX_ALLOW_ANONYMOUS_ACCESS=false`. Начиная с 1.8.3-rc.22 достаточно `INPX_REQUIRE_AUTH=true`: до входа в библиотеку видна только форма входа. |
| `INPX_COVER_CACHE_SIZE_MB` | Лимит дискового кэша обложек. По умолчанию `512` МиБ. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Включение Silero и адрес сервиса. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Включение и токен провайдера Audiobookshelf. |
| `INPX_METRICS_ENABLED` | Метрики Prometheus при значении `true`. |

OPDS: `http://SERVER_IP:12380/opds`. Проверка состояния: `/health`, `/ready`, `/api/index-status`; метрики: `/metrics`, если включены. Для внешнего доступа поддерживается авторизация за доверенным reverse proxy — [документация](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md).

Книги и архивы библиотек в образ не входят. Полный резервный архив приложения не содержит библиотеку, поисковый индекс и временные кэши: сами книги сохраняйте отдельно.

---

## English

A self-hosted web catalog for your ebook library with a built-in FB2 reader. Supports INPX indexes and ZIP/7z book archives, including fLibrary collections. Suitable for Docker, Unraid, Proxmox LXC and home servers.

### Features

**Rust 2.0.3** adds live server settings, rotating logs and large attachment uploads through a local Telegram Bot API. Trusted IPv4/IPv6 proxies can be configured as a comma-separated string or an array. [Release notes](https://github.com/AceAsket/inpx-web/releases/tag/v2.0.3)

- Book previews and detail tabs load on demand. Cache budgets limit memory use, and the performance check reports CPU, memory and response time. [Resource profiles](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/resource-profiles.md)
- Suggestions from three characters need no preparation or polling; search is available immediately. Gallery: up to 18 illustrations, 2 MiB/image, 8 MiB total, 32 MiB FB2 XML. Diagnostics: `failedByCode`, `failedByKind`. Telegram: direct, server-environment or custom HTTP(S)/SOCKS5 proxy; passwords stored separately.
- Search by author, title, series, genre, language and source; multiple libraries in one catalog.
- Cover extraction and caching, including WebP and JXL support.
- Browser-based FB2 reading with themes, fonts, bookmarks, notes, saved positions and a dedicated reader PWA shortcut.
- Reader profiles, personal lists, read/unread marks, OPDS and profile-specific OPDS links.
- Conversion to EPUB, EPUB3, KEPUB, KFX, AZW3, AZW8 and PDF in the main image using fb2cng and MuPDF.
- Send books through Telegram or email when delivery is configured.
- Admin dashboard, event log, backup/restore, source management, health checks and Prometheus metrics.

Combine title, author, keywords, formats and ISBN in search. Set separate formats for downloads, email, Telegram and OPDS. The interactive Telegram bot delivers books to the profile's personal chat.

The default resource profile is `unlimited`. Administrators can select `auto`, `economy`, `balanced` or `performance`. [Resource profiles](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/resource-profiles.md)

Connect Android through a QR containing the server address without credentials. The compatible API adds session resume, reading events, fast home snapshots and speech cancellation. Update both the web and Silero containers to stop synthesis. HTTP remains allowed with a warning; HTTPS works through a reverse proxy. [Client contract](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/native-client-protocol.md).

Bundled Kindling converts FB2/EPUB to MOBI7/KF8. The full image enables MOBI by default. Set `INPX_MOBI_ENABLED=false` to disable it. Compatibility depends on the Kindle model. [MOBI configuration](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md#лёгкая-конвертация-mobi-181-rc2)

### Images and versions

We moved the server from Node.js to Rust to improve performance with large libraries. **Node.js 1.8.3** is the final release line for the classic server and will receive bug fixes only. All new features will ship exclusively in **Rust 2.x**.

Updating a container pinned to `latest` switches it to Rust. Stop the server and back up its data directory before upgrading. Pin `1.8.3` to stay on stable Node.js. [Migration and rollback](https://github.com/AceAsket/inpx-web/blob/v2.0.3/docs/upgrade-rollback.md)

| Tag | Purpose |
| --- | --- |
| `2.0.3`, `latest` | Stable Rust server. |
| `1.8.3` | Stable classic Node.js server with JembaDB. |
| `1.8.3-silero` | Speech service for Node.js 1.8.3. |
| `2.0.3-silero` | Speech service for Rust 2.0.3. |

Published images target Linux x64 (`linux/amd64`). Pin a version tag for reproducible deployments. RC tags are prereleases; see the [CHANGELOG](https://github.com/AceAsket/inpx-web/blob/v2.0.3/CHANGELOG.md) for changes.

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
  aceasket/inpx-web-7z:2.0.3
```

Open `http://SERVER_IP:12380`. `INPX` and `LIBDIR` must refer to paths **inside the container**. Wait for initial indexing; the time required depends on the library size. Set `INPX_ADMIN_PASSWORD` to supply your own initial admin password. On a new installation without this setting, a password is generated and printed in the startup log. Existing profile passwords are preserved on upgrade.

Keep `/usr/local/bin/.inpx-web` in a persistent volume: it stores settings, profiles, reading positions, bookmarks, lists, the index and caches. Mount your books separately, normally read-only. To update, recreate the container with the new image tag while preserving your volumes, ports, network and environment variables.

### Caddy on Synology

Use `reverse_proxy 192.168.31.97:12380` with your NAS IP in Caddyfile. On the NAS, substitute the container IP below and open the HTTPS site.

```sh
sudo tcpdump -nni any -c 1 'dst host 172.18.0.2 and tcp dst port 12380 and tcp[tcpflags] & tcp-syn != 0'
```

Use the IP left of `>`, omitting the port. For `172.18.0.1.54000`, set `INPX_TRUST_PROXY: "true"` and `INPX_TRUSTED_PROXY_CIDRS: "172.18.0.1/32"`. Trust extends to all connections from that IP. If it is the gateway, restrict the NAS port to Caddy first. Recreate the service and check for `101` on `/ws`. [Compose example](https://github.com/AceAsket/inpx-web#caddy-и-docker-на-synology)

### Folders and multiple libraries

Set this environment variable to index a folder of FB2/EPUB files without INPX:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"own","name":"My books","type":"folder","libDir":"/library"}]'
```

For multiple INPX libraries, specify an array of sources:

```sh
-e INPX_LIBRARY_SOURCES='[{"id":"first","name":"First library","inpx":"/library/first/books.inpx","libDir":"/library/first"},{"id":"second","name":"Second library","inpx":"/library/second/books.inpx","libDir":"/library/second"}]'
```

These are `docker run` options; insert them before the image name. Reindex after changing sources. [Library configuration and Docker Compose](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md).

### Filenames and book titles

The main image includes fbc **2.1.1**. Add these launch options to get a filename and Kindle book title such as `02 - Доктор Гарин`:

```sh
-e INPX_BOOK_FILENAME_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}' \
-e INPX_BOOK_TITLE_TEMPLATE='[${NUMBER_PADDED} - ]${TITLE}'
```

The series number comes from the catalogue. The number and separator disappear for unnumbered books. Use `'${TITLE}'` for the title alone. The first option changes download filenames; the second changes internal EPUB/EPUB3/KEPUB/KFX/AZW3/AZW8 titles when converting FB2. Existing behavior is preserved when these options are unset. [Template fields and fbc settings](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md#имя-файла-и-заголовок-книги).

### Silero speech

Speech is **disabled by default**. Enable it through the main container's startup environment:

```sh
-e INPX_TTS_ENABLED=true \
-e INPX_TTS_URL=http://silero:8000
```

Run Silero as a separate CPU service using `aceasket/inpx-web-7z:2.0.3-silero`. Place both containers on the same user-defined Docker network. Mount a persistent volume at `/models`; models are downloaded on the first synthesis request. Stress placement with silero-stress is enabled by default. Book text is sent to your own Silero service.

[Silero commands and Compose instructions](https://github.com/AceAsket/inpx-web/blob/main/docs/silero-tts.md).

### Useful settings

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | App data; defaults to `/usr/local/bin/.inpx-web`. |
| `INPX`, `LIBDIR` | INPX index and archives for a single library. |
| `INPX_LIBRARY_SOURCES` | Multiple INPX sources and FB2/EPUB folders. |
| `INPX_ADMIN_PASSWORD` | Initial admin profile password. |
| `INPX_RESET_ADMIN_PASSWORD` | To recover access, set this to `true` and supply a new `INPX_ADMIN_PASSWORD`. Recreate the container with the existing data volume. After the reset, remove the flag and recreate the container again. |
| `INPX_ALLOW_ANONYMOUS_ACCESS` | Set to `false` to require profile login for search, books and covers. On Node.js 1.8.2 and RC21, guests can see the navigation and sign-in form. |
| `INPX_REQUIRE_AUTH` | Set to `true` with `INPX_AUTH_MODE=proxy` to require an identity from a trusted reverse proxy. For local login on Node.js 1.8.2 and RC21, set `INPX_ALLOW_ANONYMOUS_ACCESS=false`. Starting with 1.8.3-rc.22, `INPX_REQUIRE_AUTH=true` alone opens the library at the sign-in form. |
| `INPX_COVER_CACHE_SIZE_MB` | Disk space for cached covers. Defaults to `512` MiB. |
| `INPX_TTS_ENABLED`, `INPX_TTS_URL` | Enable Silero and set its service URL. |
| `INPX_ABS_ENABLED`, `INPX_ABS_TOKEN` | Enable the Audiobookshelf provider and set its token. |
| `INPX_METRICS_ENABLED` | Enable Prometheus metrics with `true`. |

OPDS: `http://SERVER_IP:12380/opds`. Health endpoints: `/health`, `/ready`, `/api/index-status`; metrics: `/metrics` when enabled. Authentication behind a trusted reverse proxy is supported for external access — see the [documentation](https://github.com/AceAsket/inpx-web/blob/v2.0.3/REFERENCE.md).

Book collections are not included in the image. Full application backups exclude book files, the search index and temporary caches; back up your library separately.

## Links

- [Source code and documentation](https://github.com/AceAsket/inpx-web)
- [Release downloads](https://github.com/AceAsket/inpx-web/releases)
- [Report an issue](https://github.com/AceAsket/inpx-web/issues)
- [Silero setup](https://github.com/AceAsket/inpx-web/blob/main/docs/silero-tts.md)
