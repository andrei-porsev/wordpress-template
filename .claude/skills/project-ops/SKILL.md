---
name: project-ops
description: "Canonical project operations: SFTP/FTP download/upload/sync, SSH and remote WP-CLI, compile SCSS, Gutenberg npm run build, agent skills (stacks, upstream updates via skills-sync). Remembers credentials in ACCESS.md. Use when connecting to the server, SSH, WP-CLI on host, syncing, uploading, compiling styles, building blocks, or updating/activating skills. Triggers: SSH, WP-CLI, синхронизация, залить, скачать, доступы, подключение к серверу, SFTP, компилировать стили, обновить скиллы, подключить стек."
compatibility: "Этот шаблон. Разработка на сервере по SFTP/FTP. Язык — русский."
---

# Операции проекта

Один способ на задачу. Не изобретать клиенты и флаги «на глаз».

Запускать скрипты **из корня репозитория**. Пароль, ключ, `sftp-ftp.json` в чат не писать и файлы секретов не открывать.

Первый раз в проекте: `node .claude/skills/project-ops/scripts/install-deps.mjs`.

Доступы: сначала [`ACCESS.md`](../../../ACCESS.md) (SSH, WP-CLI, URL, админка, браузер, Figma). Новое от пользователя — сразу туда и в `ssh.json`/`sftp.json`, не переспрашивать. Сбор при старте — `project-init` → `access.md`.

## Когда какой раздел

| Задача | Читать и делать |
|--------|-----------------|
| Stage: создать, «безопасный stage», пароль для скриптов и браузера | [stage.md](stage.md) |
| Свой VPS (Plesk): план «Stage», подписка на проект, удаление stage | [plesk.md](plesk.md) |
| Без WP-CLI: что делает человек вместо команды | [no-wpcli.md](no-wpcli.md) |
| Пакеты: сопровождение, перенос контента, интеграции, обучение клиента | `packages/*.md` (поле `procedure` в `.claude/packages.json`) |
| Локальная копия (LocalWP, OSPanel): перенос, WP-CLI, junction | [local.md](local.md), `local-exec.mjs` |
| Проверить машину (один раз): Node, PHP, phpcs, git, SSH-ключ | `machine-check.mjs` → `project-init` → этап 10 |
| Stage по профилю своего сервера; пароль stage для браузера; после переезда stage → прод | `stage-config.mjs build <project>` / `auth <project>` / `promote` → `project-init` → `access.md`, `types.md` |
| Проверить подключение: SSH / SFTP / FTP, ключ, путь к сайту, диагностика | `connect-check.mjs` → `project-init` → `access.md` |
| Запуск сессии: локально, сверка, версии, безопасность, обновления | `session-check.mjs` → [sftp.md](sftp.md), `WORKFLOW.md` → 2.1 |
| Разведка, полная проверка безопасности, окружение | `recon.mjs` → `project-init` → `recon.md` |
| Скачать, сверить, sync | [sftp.md](sftp.md) |
| Выкатить на прод | `deploy` → [sftp.md](sftp.md) |
| Залить файлы / SSH / WP-CLI | [ssh.md](ssh.md), заливка — скрипт в [sftp.md](sftp.md) |
| Компиляция SCSS → CSS | [compile-scss.md](compile-scss.md) |
| Сборка Gutenberg-блоков (`src/` → `build/`) | [build-blocks.md](build-blocks.md) |
| Скиллы: подключить стек, проверить и обновить из апстрима | [skills.md](skills.md) |
| Обновить проект до версии шаблона, миграции, «Шаблон: доступна X» | [template.md](template.md), `template-update.mjs` |
| Кеш сайта после заливки: команда сброса, кто сбрасывает, проверка отдаваемого CSS | [cache.md](cache.md) |

Сначала нужный файл, потом команды из него.

## Кто обновляет сервер

```
Человек сохранил файл в Cursor
  → uploadOnSave (расширение SFTP). Агент не дублирует.

Агент правит через Write / Edit (режим — ACCESS.md → «Заливка», решение 012)
  guarded-auto → хук post-edit: php -l → бэкап серверной версии → upload
                 → проверка (HTTP главной, debug.log) → откат при ошибке
  stage-auto   → то же, на stage (sftp-stage.json, Stage URL)
  manual (задача …) → временно на одну задачу: deploy разом, затем прежний режим (WORKFLOW.md → 2.4)
  manual       → агент заливает сам только по команде («залей», «выложи», «задеплой»)
                 или после «да»: скрипт из sftp.md, список путей коротко
  host пустой  → заливки нет; режим фактически manual
```

При `guarded-auto` / `stage-auto` файлы, правленые через Write / Edit, заливает хук — `upload` для них вручную не нужен.
Собранный CSS и `build/` создаёт Bash, хук их не видит: после compile / build агент заливает результат сам (`upload <пути>`, при `stage-auto` с `--stage`).
После заливки CSS / JS / шаблона — сброс кеша сайта по [cache.md](cache.md), затем проверка в браузере (Playwright).

WP-CLI, меняющий сайт, — только по команде или после «да», см. [ssh.md](ssh.md); сброс кеша — без вопроса ([cache.md](cache.md)).

## Цикл с сервером

1. Перед задачей: `session-check.mjs` (`WORKFLOW.md` → 2.1); чужие правки — `sync-down` (только их), отдельный коммит; конфликты — с пользователем.
2. Правка кода. SCSS — [compile-scss.md](compile-scss.md). `src/` блока — [build-blocks.md](build-blocks.md).
3. На сервер — по режиму выше; со stage или локальной копии на прод — `deploy`. Коммит — после проверки в браузере.

## Не делать

- WinSCP, FileZilla, lftp, scp/rsync, интерактивный `ssh user@host` (пароль зависнет)
- Править собранный CSS руками
- Открывать `.vscode/sftp-ftp.json`, цитировать пароль из json
- `SFTP: Sync Local → Remote` на весь проект без явной просьбы
- В режиме `manual` заливать на сервер без команды и без «да»
- Вызывать `upload` для файлов, правленых через Write / Edit, при `guarded-auto` / `stage-auto` — их заливает хук
- Спрашивать хост/логин/SSH, если это уже есть в `ACCESS.md`
