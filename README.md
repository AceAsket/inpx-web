# inpx-web-7z

> [!IMPORTANT]
> **Развитие проекта с версии 1.8.3**
>
> - **Сервер на Rust и новый веб-интерфейс** — все новые возможности.
> - **Версия с сервером на Node.js** — только исправления ошибок.
>
> [Ветка `rust`](https://github.com/AceAsket/inpx-web/tree/rust) · [Сборка Rust-версии](https://github.com/AceAsket/inpx-web/blob/rust/README.md#сборка-с-автономным-rust-сервером)

Веб-каталог и читалка для домашней библиотеки в формате INPX с архивами ZIP и 7z. Есть поиск по каталогу, личные полки, закладки, OPDS, синхронизация с KOReader и отправка книг через Telegram или почту.

[![INPX Reader — скачать читалку для Android](https://img.shields.io/badge/INPX_Reader-%D1%81%D0%BA%D0%B0%D1%87%D0%B0%D1%82%D1%8C%20APK-0F766E?style=for-the-badge&logo=android&logoColor=white)](https://github.com/AceAsket/inpx-reader-releases/releases/latest)
[![INPX Server — сервер для Android](https://img.shields.io/badge/INPX_Server-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%20%D0%B4%D0%BB%D1%8F%20Android-455A64?style=for-the-badge&logo=android&logoColor=white)](#сервер-на-android)

## Быстрый запуск

- **Стабильная версия 1.8.2** доступна в Docker и готовых сборках для Windows, Linux x64/ARM64 и macOS. [Скачать выпуск](https://github.com/AceAsket/inpx-web/releases/tag/v1.8.2)
- **Версию на Rust** можно попробовать в Docker или standalone. Выбирайте образ или файл с пометкой `rust`. [Предрелиз 1.8.3-rc.21](https://github.com/AceAsket/inpx-web/releases/tag/v1.8.3-rc.21)

### Быстрый старт через docker run

Замените путь к папке библиотеки и имя файла `.inpx` на свои.

```sh
docker run -d --name inpx-web --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -v inpx-web-data:/usr/local/bin/.inpx-web \
  -v /path/to/library:/library:ro \
  aceasket/inpx-web-7z:1.8.2
```

Откройте `http://localhost:12380` на сервере или укажите его адрес вместо `localhost`. Профили и настройки сохраняются в томе `inpx-web-data`. [Пример Docker Compose](https://github.com/AceAsket/inpx-web/blob/v1.8.2/docker-compose.full.yml) · [Docker Hub](https://hub.docker.com/r/aceasket/inpx-web-7z)

## Android

### Читалка INPX Reader для Android

Подключается к библиотеке по адресу сервера или QR-коду. Книги и готовую озвучку можно скачать для чтения и прослушивания без сети. [Скачать INPX Reader](https://github.com/AceAsket/inpx-reader-releases/releases/latest)

### Сервер на Android

INPX Server запускает библиотеку с локальной папки или по SMB на телефоне, планшете или ТВ-приставке с Android 9+. Выбирайте APK по разрядности Android. [Предрелиз и контрольные суммы](https://github.com/AceAsket/inpx-web/releases/tag/android-v0.7.3) · [Инструкция](https://github.com/AceAsket/inpx-web/blob/android/android/README.md)

## Документация

- [Полный справочник версии 1.8.2](https://github.com/AceAsket/inpx-web/blob/v1.8.2/README.md) — Docker, standalone, ручная сборка и конфигурация.
- [Авторизация и мониторинг](https://github.com/AceAsket/inpx-web/blob/v1.8.2/README.md#авторизация-и-мониторинг) · [Несколько источников и форматы архивов](https://github.com/AceAsket/inpx-web/blob/v1.8.2/README.md#несколько-inpx-источников)
- [Обновление и откат](https://github.com/AceAsket/inpx-web/blob/v1.8.2/docs/upgrade-rollback.md) · [Переход на Rust](https://github.com/AceAsket/inpx-web/blob/rust/docs/upgrade-rollback.md)
- [OPDS 2.0](https://github.com/AceAsket/inpx-web/blob/v1.8.2/docs/opds-v2.md) · [Синхронизация с KOReader](https://github.com/AceAsket/inpx-web/blob/v1.8.2/docs/koreader-sync.md) · [Озвучка Silero](https://github.com/AceAsket/inpx-web/blob/v1.8.2/docs/silero-tts.md)
- [Справочник версии 1.8.1](./docs/reference-1.8.1.md)

## Обратная связь

[Telegram-сообщество @inpxweb](https://t.me/inpxweb) · [Сообщить об ошибке или предложить улучшение](https://github.com/AceAsket/inpx-web/issues) · [История выпусков](https://github.com/AceAsket/inpx-web/releases)
