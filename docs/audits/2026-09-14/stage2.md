# Этап 2: зависимости, Node и проверка сборок

Ветка `develop`, версия приложения остаётся 1.7.7 до отдельной подготовки релиза.

## Изменения

- Сборка и запуск исходников требуют Node 24+. Standalone-цели Windows x64, Linux x64/arm64 и macOS x64 переведены на Node 24. Упаковщик заменён с архивного `pkg` на фиксированный `@yao-pkg/pkg@6.22.0`; lockfile выбирает встроенный Node **24.18.1** через `@yao-pkg/pkg-fetch@3.6.5`.
- Docker собирается на `node:24-bookworm-slim`. Удалён ручной загрузчик старого бинарника из vercel/pkg-fetch; базовый бинарник выбирает и проверяет установленный pkg-fetch. Runtime остаётся Debian с упакованным приложением.
- Обновлены Axios 1.20.0, Express 4.22.3, form-data 4.0.6, lodash 4.18.1, Nodemailer 10.0.10, Quasar 2.32.3, ws 8.21.3 и совместимые транзитивные зависимости. Express остаётся в 4.x.
- Старые импорты внутренних каталогов Quasar заменены публичными экспортами. Обновлены copy-webpack-plugin и css-minimizer-webpack-plugin; Showdown заменён на markdown-it для генерации readme.html.
- Добавлен CI на push в develop/master/main и pull request: аудит production-зависимостей, тесты, клиентская сборка, упаковка и запуск приложения на Windows/Linux; на Linux также сборка и запуск Docker Lite.
- Релизный workflow использует Node 24 и проверяет каждый собранный бинарник перед публикацией. Для Linux arm64 используется ARM runner, для macOS x64 — Intel runner.

Основания для миграции: [документация упаковщика](https://yao-pkg.github.io/pkg/guide/migration), [поддерживаемые цели](https://yao-pkg.github.io/pkg/guide/targets), [архитектуры GitHub runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Версии пакетов дополнительно сверены с registry.npmjs.org.

## Проверки 2026-09-14

- `node scripts/release-smoke-tests.js`: **38/38**, Node 24.19.0, Windows. Добавлены локальные проверки multipart-загрузки Axios/form-data и генерации MIME-вложения Nodemailer без отправки писем.
- `npm audit --omit=dev`: **17 → 0** замечаний. Полный `npm audit`, включая инструменты сборки: **0**. Финальные JSON-отчёты: `npm-audit-after-stage2.json` и `npm-audit-all-stage2.json`.
- Production-сборка Webpack 5.111.0 успешна. Остаются предупреждения о размере бандлов и выделении runtime в отдельный chunk.
- Windows x64: собран бинарник с Node 24.18.1, пройден `scripts/binary-smoke-test.js` — индексация одной книги, `/ready`, `/health`, HTML, OPDS и обмен сообщениями WebSocket.
- Docker target `runtime-lite`: собран локальный `inpx-web:audit-node24`, пройдены те же проверки с библиотекой, смонтированной только для чтения, и временным каталогом данных. Проверка удаляет только свой контейнер и временные данные.
- Chromium: каталог, открытие/закрытие окна информации о книге и мобильная ширина 390 px; ошибок JavaScript не обнаружено. Это локальная выборочная проверка, отдельный браузерный CI пока не добавлен.
- ESLint изменённых JS-модулей и новых тестовых скриптов, разбор YAML, соответствие package.json/lockfile и `git diff --check` прошли.

## Границы этапа

GitHub Actions ещё не запускался: коммит локальный. macOS и Linux arm64 предстоит проверить на соответствующих runners. Для нового Linux arm64 используется glibc вместо прежнего linuxstatic; это отражено в README. В этом этапе проверен Docker Lite, конвертеры полного образа отдельно не проверялись.

Публикация релиза/образа и обновление стенда не выполнялись. Старые Node 16/18/20 больше не являются поддерживаемыми средами текущей ветки.

Следующие пункты аудита: адаптивное хеширование паролей, лимиты конвертаций и WS/OPDS, транзакционное восстановление полного бэкапа и расширение браузерных сценариев.
