<p align="center">
  <a href="https://t.me/inpxweb">
    <img src="./docs/images/telegram-community.svg" width="420" alt="Наше сообщество в Telegram — @inpxweb">
  </a>
</p>

# inpx-web-7z

Веб-каталог и читалка для домашней библиотеки в формате INPX с архивами ZIP и 7z. Есть поиск по каталогу, личные полки, закладки, OPDS, синхронизация с KOReader и отправка книг через Telegram или почту.

[![INPX Reader — скачать читалку для Android](https://img.shields.io/badge/INPX_Reader-%D1%81%D0%BA%D0%B0%D1%87%D0%B0%D1%82%D1%8C%20APK-0F766E?style=for-the-badge&logo=android&logoColor=white)](https://github.com/AceAsket/inpx-reader-releases/releases/latest)
[![INPX Server — сервер для Android](https://img.shields.io/badge/INPX_Server-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%20%D0%B4%D0%BB%D1%8F%20Android-455A64?style=for-the-badge&logo=android&logoColor=white)](#сервер-на-android)

## Выпуски

Чтобы ускорить работу с большими библиотеками, мы перенесли разработку сервера с Node.js на Rust. **Node.js 1.8.3** — последняя ветка классического сервера. Она будет получать только исправления ошибок. Все новые функции будут выходить только в **Rust 2.x**.

| Редакция | Docker-образ | ZIP и установщик Windows |
| --- | --- | --- |
| Rust 2.0.2 · стабильная | `aceasket/inpx-web-7z:2.0.2` или `:latest` | [Скачать Rust 2.0.2](https://github.com/AceAsket/inpx-web/releases/tag/v2.0.2) |
| Классический Node.js 1.8.3 · стабильная | `aceasket/inpx-web-7z:1.8.3` | [Скачать Node.js 1.8.3](https://github.com/AceAsket/inpx-web/releases/tag/v1.8.3) |

Разработка Rust 2.x ведётся в ветке `develop`. Ветка `main` также содержит сервер Rust. При обновлении контейнера с тегом `latest` он перейдёт на Rust. Чтобы продолжить использовать стабильный Node.js, закрепите тег `1.8.3`. Классический сервер с JembaDB поддерживается в ветке [nodejs_depr](https://github.com/AceAsket/inpx-web/tree/nodejs_depr).

Перед переходом с Node.js остановите прежний сервер и сохраните копию каталога данных, включая `db` и внешний файл фильтра, если он используется. При первом запуске Rust сохраняет снимок пользовательских данных и строит новый индекс с сохранением идентификаторов книг, полок, закладок и прогресса. [Переход и откат](./docs/upgrade-rollback.md)

## Запуск Rust в Docker

Замените путь к папке библиотеки и имя файла `.inpx` на свои.

```sh
docker run -d --name inpx-web --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -v inpx-web-data:/usr/local/bin/.inpx-web \
  -v /path/to/library:/library:ro \
  aceasket/inpx-web-7z:2.0.2
```

Откройте `http://localhost:12380` на сервере или укажите его адрес вместо `localhost`. Профили и настройки сохраняются в томе `inpx-web-data`. [Пример Docker Compose](./docker-compose.full.yml) · [Docker Hub](https://hub.docker.com/r/aceasket/inpx-web-7z)

### Caddy и Docker на Synology

Если Caddy работает на отдельной машине, укажите в Caddyfile адрес NAS и опубликованный порт библиотеки. В примере Caddy имеет адрес `192.168.31.49`, а Synology — `192.168.31.97`. Замените домен и адреса своими. Caddy передаёт WebSocket и заголовки внешнего адреса по умолчанию. [Документация Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)

```caddyfile
books.example.org {
	reverse_proxy 192.168.31.97:12380
}
```

Для `INPX_TRUSTED_PROXY_CIDRS` нужен **адрес источника TCP-соединения, который видит контейнер**. Чтобы его узнать, подключитесь к NAS по SSH и посмотрите IP контейнера в сети библиотеки.

```sh
sudo docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{println $name $net.IPAddress}}{{end}}' inpx-web
```

Подставьте этот IP вместо `172.18.0.2` в команду ниже. Пока она ждёт, откройте библиотеку через HTTPS-домен Caddy в новом окне браузера. Команда показывает первый пакет открытия TCP-соединения к библиотеке.

```sh
sudo tcpdump -nni any -c 1 'dst host 172.18.0.2 and tcp dst port 12380 and tcp[tcpflags] & tcp-syn != 0'
```

Например, строка `172.18.0.1.54000 > 172.18.0.2.12380` означает, что библиотека видит источником шлюз Docker `172.18.0.1`. Число `54000` — временный порт. Если слева виден адрес самого Caddy, используйте его. Суффикс `/32` обозначает один IPv4-адрес.

**Если источником оказался шлюз**, такой настройке будут доверены все подключения, которые Docker передаёт с адреса шлюза. Сначала разрешите доступ к опубликованному TCP-порту `12380` только с адреса Caddy (`192.168.31.49` в примере). Правило должно фильтровать входящие подключения к порту Docker до подмены адреса. Проверьте с другого устройства в LAN, что прямое подключение к `192.168.31.97:12380` закрыто, а через Caddy библиотека открывается. [Фильтрация опубликованных портов Docker](https://docs.docker.com/engine/network/firewall-iptables/#restrict-external-connections-to-containers)

Добавьте значения в `environment` сервиса `inpx-web` в Compose. Для приведённого вывода подойдут такие значения.

```yaml
environment:
  INPX_TRUST_PROXY: "true"
  INPX_TRUSTED_PROXY_CIDRS: "172.18.0.1/32"
```

Выполните `docker compose up -d --force-recreate inpx-web` из каталога проекта. Откройте библиотеку через HTTPS и проверьте запрос `/ws` в инструментах разработчика браузера (**Сеть → WS**). Статус `101 Switching Protocols` подтверждает, что WebSocket открылся.

**Если Caddy тоже в Docker на том же NAS**, подключите оба контейнера к общей пользовательской сети, уберите `ports` у `inpx-web` и укажите в Caddyfile `reverse_proxy inpx-web:12380`. Закрепите за Caddy IPv4-адрес в этой сети и укажите его с `/32`. Клиенты в LAN обращаются к библиотеке через Caddy. [Сети Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/)

## IPv6 в Rust standalone

По умолчанию сервер слушает `0.0.0.0` (IPv4). Чтобы включить все IPv6-интерфейсы в Linux standalone, добавьте `--host=::` к обычной команде запуска. Для постоянной настройки задайте `"host": "::"` в секции `server` файла `config.json`. В примере сервер слушает порт `12382`, а команда `curl` проверяет доступ с этой же машины.

```sh
./inpx-web --host=:: --port=12382
# В другом терминале
curl --noproxy '*' -g -6 'http://[::1]:12382/ready'
```

Для доступа только с этой машины укажите `--host=::1`. Если в Linux `net.ipv6.bindv6only=0`, слушатель на `::` принимает также IPv4.

### Caddy по IPv6

Прямой доступ по IPv6 работает в 2.0.2. Поддержка IPv6 в `INPX_TRUSTED_PROXY_CIDRS` доступна в `develop` после 2.0.2. В примере адрес Caddy — `2001:db8:31::49`, адрес библиотеки — `2001:db8:31::97`. Подставьте свои адреса. На машине библиотеки задайте переменные перед запуском сервера.

```sh
export INPX_TRUST_PROXY=true
export INPX_TRUSTED_PROXY_CIDRS='2001:db8:31::49/128'
./inpx-web --host=:: --port=12382
```

В Caddyfile укажите адрес библиотеки в квадратных скобках.

```caddyfile
books.example.org {
	reverse_proxy [2001:db8:31::97]:12382
}
```

Чтобы проверить адрес Caddy, откройте библиотеку через прокси и выполните на машине библиотеки `ss -6nt 'sport = :12382'`. Возьмите адрес из столбца **Peer Address:Port**, уберите скобки и порт, добавьте `/128`. Если доверенных прокси несколько, перечислите их через запятую, например `2001:db8:31::49/128,192.168.31.49/32`. После перезапуска проверьте в браузере **Сеть → WS → /ws**. При успешном подключении статус — `101`.

## Интерфейс

На обзоре видны текущая книга, прогресс чтения и полки с новинками.

[![Обзор библиотеки с полкой новинок и кнопкой продолжения чтения](./docs/images/rust-2-overview.png)](./docs/images/rust-2-overview.png)

| Каталог с фильтрами и карточками книг | Читалка в режиме разворота, тема «Сепия» |
| --- | --- |
| [![Поиск и карточки книг в каталоге](./docs/images/rust-2-catalog.png)](./docs/images/rust-2-catalog.png) | [![Две страницы открытой книги в читалке](./docs/images/rust-2-reader.png)](./docs/images/rust-2-reader.png) |

Скриншоты сделаны в Rust 2.0.0 на демонстрационной библиотеке. Тексты и иллюстрации взяты из [Standard Ebooks](https://standardebooks.org/ebooks).

## Android

### Читалка INPX Reader для Android

Подключается к библиотеке по адресу сервера или QR-коду. Книги и готовую озвучку можно скачать для чтения и прослушивания без сети. [Скачать INPX Reader](https://github.com/AceAsket/inpx-reader-releases/releases/latest)

### Сервер на Android

INPX Server 0.8.0 на Rust запускает библиотеку с SD/USB или по SMB на телефоне, планшете и ТВ-приставке с Android 9+. В одном APK доступны встроенная INPX Reader 0.17.9, семь форматов конвертации и панель для сенсорного экрана и пульта. Есть сборки ARM64 и ARM32; пакет и подпись сохранены для обновления старого приложения. [Возможности, сборка и переход с Node.js](./android/RUST.md)

## Документация

- [Справочник по установке и настройке](./REFERENCE.md) · [Сборка Rust из исходников](./REFERENCE.md#сборка-с-автономным-rust-сервером)
- [Обновление и откат](./docs/upgrade-rollback.md) · [Профили ресурсов](./docs/resource-profiles.md)
- [OPDS 2.0](./docs/opds-v2.md) · [Синхронизация с KOReader](./docs/koreader-sync.md) · [Озвучка Silero](./docs/silero-tts.md)
- [Справочник классического Node.js 1.8.3](https://github.com/AceAsket/inpx-web/blob/v1.8.3/README.md) · [Справочник 1.8.1](./docs/reference-1.8.1.md)

## Обратная связь

[Telegram-сообщество @inpxweb](https://t.me/inpxweb) · [Сообщить об ошибке или предложить улучшение](https://github.com/AceAsket/inpx-web/issues) · [История выпусков](https://github.com/AceAsket/inpx-web/releases)
