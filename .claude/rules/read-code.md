# Чтение кода

Исходники — встроенными инструментами. Парсер, обходчик и разовый скрипт «чтобы прочитать проект» не писать.

## Маршрут

1. `project-base/INDEX.md` — какой пакет и слой (фронт / бэк).
2. INDEX пакета (`themes/<slug>/`, `plugins/<slug>/`) — какой файл; инструкции слоя.
3. Детальный md (`themes/<slug>/front|back/`, `plugins/<slug>/front|back/`) — какая функция / хук.
4. Исходник — **Read** (большой файл: `offset` / `limit`).

Карты нет или шапка корневого INDEX из прочерков — `project-init` / `project-structure`, не сканер.

## Инструменты

| Задача | Чем |
|--------|-----|
| Открыть известный файл | Read |
| Найти символ, хук, строку | Grep |
| Найти файл по имени | Glob |
| Построить / обновить карту | skill `project-structure` (тот же Grep) |

## Не делать

- PHP / Node / Python-парсер, AST, `token_get_all`, php-parser
- Разовый скрипт «выгрузить функции» или обойти дерево файлов
- `detect_wp_project.mjs`, `list_blocks.mjs`, `detect_plugins.mjs`, `wordpress-router` — чтобы «понять проект» (стек уже в INDEX)
- Обзор через Shell: `cat`, `type`, `Get-Content`, `Get-ChildItem` / `find` по теме
- Task / explore «обойти репо», если INDEX заполнен
- Временные JSON / txt-индексы исходников

Скрипты `project-ops` (SFTP, SSH, SCSS, build) — не чтение кода, это правило их не касается.
