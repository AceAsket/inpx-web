# INPX Server 0.8.0 для Android — Rust

Ветка `android-rust` собирает автономный сервер Rust 2.0.2, панель управления для сенсорного экрана и пульта, INPX Reader 0.17.9 и конвертеры в одном APK. Требуется Android 9 или новее. Есть отдельные сборки ARM64 (`arm64-v8a`) и ARM32 (`armeabi-v7a`). Node.js в APK отсутствует.

## Возможности

- SD, USB и встроенная память: выбор папки через системный Android DocumentsProvider и сохранение разрешения на чтение.
- SMB2/SMB3: подключение к общей папке с логином, паролем и доменом либо гостевой доступ, если сервер его разрешает. Пароли защищены Android Keystore.
- Внутри приложения хранится копия INPX. ZIP/7z с книгами остаются в выбранной папке или на NAS и читаются с произвольной позиции.
- Встроенная нативная читалка: подключение к локальному серверу, каталог, скачивание и чтение без работающего сервера. Защищённый профиль требует входа; пароли в Intent не передаются.
- Конвертация FB2: EPUB, EPUB3, KEPUB, KFX, AZW8, MOBI и PDF. Используются fb2cng, kindling и MuPDF. Одновременно выполняется одна конвертация, очередь ограничена четырьмя запросами, время — тремя минутами.
- Foreground service, управление фоном и автозапуском, остановка во время подготовки, этап запуска, время последнего прогресса и фактическая ОЗУ процесса Rust.

Старый лимит V8, например 512 МиБ, не ограничивает Rust. Приложение включает экономный профиль, кэш базы 32 МиБ и ограничение параллельных операций. Система Android может завершить процесс при общей нехватке ОЗУ. На панели показывается RSS всего процесса; это измерение, а не установленный предел памяти.

## Обновление старого приложения

Основная сборка сохраняет `applicationId=ru.inpx.server`, каталог данных, Vault, идентификаторы источников и разрешения SAF. `versionCode=100` выше прежних 0.7.x. Для установки поверх старой версии APK должен быть подписан прежним ключом; ожидаемый отпечаток находится в `signing-certificate.sha256`. Удалять старое приложение перед обновлением не требуется.

Перед переходом сохраните резервную копию пользовательских данных через старый сервер и остановите его. При первом запуске Rust переносит поддерживаемые пользовательские данные прежней базы и строит свой индекс. Общий порядок миграции и отката описан в [upgrade-rollback.md](../docs/upgrade-rollback.md). Для отката APK Android может потребовать удаления новой версии: сначала сохраните данные. Самостоятельная INPX Reader остаётся отдельным приложением; загрузки автоматически не переносятся между разными Android UID.

## Слои интеграции

`ServerService` управляет процессом, питанием и жизненным циклом. `IndexCache` обновляет приватные копии INPX атомарно и сохраняет старую копию при обрыве источника. `StorageBridge` отвечает за Android-папки, SMB и восстановление соединения. `RustStorageBroker` предоставляет только `stat/list/open` через случайный abstract Unix socket, проверяет UID клиента и передаёт дескрипторы через SCM_RIGHTS. Копирование целого архива не требуется.

Rust-модуль `library_fs` используется для виртуальных путей `/__android_library__/<source-id>/…`. Остальные пути сохраняют обычные проверки файловой системы и безопасное открытие внутри корня. При отключении источника каталог продолжает работать, чтение недоступной книги возвращает ошибку. После возврата источника дескриптор открывается заново; изменившийся SMB-файл не подменяется посреди чтения.

Исходники читалки извлекаются из закреплённой ревизии `reader.lock.json`, затем применяется `reader/embedded.patch`. Основной репозиторий читалки не изменяется. Модель MVVM + Repository сохраняется; подключением управляет `ConnectionViewModel`. Инициализация читалки отложена до её первого открытия, в процессе сервера она не запускается. Обновление отдельного APK читалки внутри сервера отключено.

## Сборка

Нужны Node.js 24+, Ubuntu/WSL, Gradle 8.13, SDK 36, NDK 28.2.13676358 и CMake 3.22.1. Скрипты используют `~/.cache/inpx-android`; Rust 1.100.0 устанавливается `scripts/android/setup-rust.sh`. ARM32 AWS-LC и QuickJS генерируют биндинги с заголовками Android NDK.

Подготовьте конвертеры скриптами `prepare-converter-tools.sh`, `build-fb2cng.sh`, `build-kindling.sh`, `build-mupdf.sh` для обеих ABI через `INPX_ANDROID_ABI`. Версии и контрольные суммы исходников закреплены в скриптах и lock-файлах Android. Нужны все четыре ELF: сервер и три конвертера. Отдельный `lib7zz.so` Rust-сборке не нужен.

```powershell
node node_modules/webpack/bin/webpack.js --config build/webpack.prod.config.js
node scripts/android/prepare-reader.js D:/unraid/inpx-reader-android
# Сохраните выведенный путь и переведите его в Linux-вид /mnt/d/…
wsl -d Ubuntu -- env INPX_ANDROID_ABI=arm64-v8a bash scripts/android/build-rust.sh
wsl -d Ubuntu -- env INPX_ANDROID_ABI=armeabi-v7a bash scripts/android/build-rust.sh
node scripts/android/prepare-rust-assets.js
wsl -d Ubuntu -- env INPX_ANDROID_ABI=arm64-v8a INPX_ANDROID_KEYSTORE_FILE=/path/to/server.keystore bash scripts/android/build-rust-apk.sh '-PinpxReaderSource=/mnt/d/…/prepared-reader'
wsl -d Ubuntu -- env INPX_ANDROID_ABI=armeabi-v7a INPX_ANDROID_KEYSTORE_FILE=/path/to/server.keystore bash scripts/android/build-rust-apk.sh '-PinpxReaderSource=/mnt/d/…/prepared-reader'
```

Результат: `dist/android/inpx-server-0.8.0-arm64-rust.apk` и `inpx-server-0.8.0-arm32-rust.apk`, рядом SHA256. `verify-rust-apk.py` проверяет подпись, имя пакета, версию, ABI и выравнивание всех ELF на 16 КиБ, присутствие читалки и лицензий, SHA256 runtime и нативных файлов, ревизию исходников. Запускайте из корня checkout в WSL с `--abi` и `--source=<git rev-parse HEAD>`.

## Проверки

Для тестирования используется отдельное приложение `ru.inpx.server.rust`: добавьте к Gradle `'-PinpxApplicationId=ru.inpx.server.rust'`. `RustSmokeInstrumentation` отказывается менять источники настоящего приложения. Тестовый APK устанавливается отдельно, вместе с `:app:assembleDebugAndroidTest`.

Базовый запуск: `adb shell am instrument -w ru.inpx.server.rust.test/ru.inpx.server.RustSmokeInstrumentation`.

Полный запуск с `-e full true` дополнительно проверяет семь форматов, скачивание нативной читалкой и открытие офлайн, DocumentsProvider с отключением, сменой document ID и запуском по сохранённому INPX, SMB, отмену обновления 200 тысяч записей, показ RSS, принудительное завершение процесса сервиса и повторный запуск. Для него заранее запустите `scripts/android/smb-test-server.py <generated-demo-directory>` с Impacket 0.13.0 и выполните `adb reverse tcp:1445 tcp:1445`. Стенд слушает только localhost и предоставляет созданные тестовые книги; после теста остановите его и удалите reverse.

ARM64 проверяется на Lenovo TB321FU с Android 16. Для проверки исполнения ARM32 требуется отдельное 32-битное устройство; успешная сборка её не заменяет. Настоящий USB-накопитель и конкретный NAS также следует проверить с их провайдером и правами доступа.
