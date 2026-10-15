# SFTP / FTP

Конфиг: `.vscode/sftp.json` (SFTP). Если в `.vscode/settings.json` стоит `"sftp.config": "sftp-ftp.json"` — скрипт сам читает FTP-файл, **агент его не открывает**.

Человек в Command Palette: `SFTP: Download Project`, `SFTP: Upload File`, `SFTP: Sync Remote → Local`. Агент — только скрипт ниже.

## Скрипт

Из корня репозитория. Если скрипт пишет «Нет зависимостей» — один раз:

```bash
node .claude/skills/project-ops/scripts/install-deps.mjs
```

Дальше:

```bash
node .claude/skills/project-ops/scripts/sftp-sync.mjs test
node .claude/skills/project-ops/scripts/sftp-sync.mjs list [<rel>]
node .claude/skills/project-ops/scripts/sftp-sync.mjs compare [--json]
node .claude/skills/project-ops/scripts/sftp-sync.mjs deploy [--yes]
node .claude/skills/project-ops/scripts/sftp-sync.mjs download <rel> [<rel>...]
node .claude/skills/project-ops/scripts/sftp-sync.mjs upload <rel> [<rel>...]
node .claude/skills/project-ops/scripts/sftp-sync.mjs sync-down [--force]
node .claude/skills/project-ops/scripts/sftp-sync.mjs sync-up
node .claude/skills/project-ops/scripts/sftp-sync.mjs fetch <rel> <файл>
node .claude/skills/project-ops/scripts/sftp-sync.mjs put <файл> <rel>
node .claude/skills/project-ops/scripts/sftp-sync.mjs remove <rel>
```

Stage: флаг `--stage` (любая команда `sftp-sync.mjs` / `ssh-exec.mjs`) берёт `.vscode/sftp-stage.json` и `ssh-stage.json` вместо боевых. Хук `post-edit` в режиме `stage-auto` делает то же через переменные `SFTP_CONFIG` / `SSH_CONFIG`.

`rel` — путь от корня репо, как в git (`wp-content/themes/…/functions.php`). Каталог — рекурсивно, `node_modules`/`vendor` пропускаются.

| Команда | Когда |
|---------|--------|
| `test` | Проверить, что host/логин живые. После заполнения конфига — первым делом. |
| `list [<rel>]` | Листинг папки на сервере (тип, размер, время) — без SSH. |
| `compare [--json]` | Сверка своего кода (whitelist) без перезаписи: совпадают / изменены на сервере (чужие) / изменены локально (не залиты) / конфликт / отличаются без снимка. Перед задачей и перед выкаткой. |
| `deploy [--yes]` | «Выкати на прод»: изменения в git от последнего тега `deploy-*` (первый раз — от `baseline`) по своему коду. Стоп: незакоммиченное, чужие правки или конфликт на сервере, ошибка `php -l`. Без `--yes` — план (показать пользователю), с `--yes` — бэкап, заливка и удаление пачкой, проверка сайта (HTTP < 500); ошибка — откат всей пачки; успех — тег `deploy-<время>` (на stage тег не ставится). После — проверка в браузере и `git push --tags`. |
| `download` | Забрать конкретные файлы с сервера (папка — рекурсивно). Родительская тема и сторонние плагины для чтения — ложатся вне git, править не даст `guard-paths`. |
| `upload` | Залить указанные пути; обновляет снимок. В `guarded-auto` / `stage-auto` заливает хук; вручную — режим `manual` по команде или «да» (см. `ssh.md`). |
| `fetch <rel> <файл>` | Забрать серверную версию в произвольный локальный файл (бэкап хука). Нет на сервере — вывод `MISSING`, код 3. |
| `put <файл> <rel>` | Залить произвольный локальный файл на путь `rel` (откат из бэкапа). |
| `remove <rel>` | Удалить файл на сервере (откат новой заливки). |
| `sync-down [--force]` | Перед задачей: скачать **только изменённое на сервере** (whitelist из `ignore`), удалённое там — удалить локально. Незалитые локальные правки и конфликты не трогает — перечисляет. `--force` — перезаписать всё серверной версией (только после решения пользователя по конфликтам). |
| `sync-up` | Весь whitelist на сервер. Только явная просьба «залей всё» и SSH = да. |

## Подключение (человек один раз)

1. SFTP: заполнить `host`, `username`, `password` или `privateKeyPath`, `remotePath` в `.vscode/sftp.json`. Пароль в git не коммитить, если проект публичный; в этом шаблоне файл в git — не светить его в чат.
2. FTP: скопировать `sftp-ftp.json.example` → `sftp-ftp.json`, заполнить, в settings `"sftp.config": "sftp-ftp.json"`.
3. Слаги в `ignore`/`watcher` — `project-base/project.json` + `gen-whitelist.mjs`, не руками.
4. Агент: `test`. Успех — `OK host remotePath`. Хост пустой — остановиться; если нет в `ACCESS.md` — попросить заполнить конфиг и сразу записать ответ туда.

## Инварианты

- Не читать и не цитировать `password` / `passphrase`.
- `sync-down` ≠ «скачать весь сайт»: ядро WP и чужие плагины не трогаем (это уже в `ignore`).
- После `sync-down` — `git status`; чужие изменения не смешивать со своей задачей.
- **Снимок** последней синхронизации — `.claude/.state/sync-<конфиг>.json` (свой у `sftp.json` и `sftp-stage.json`, не в git). Пишут `sync-down`, `upload`, `compare` (для совпадающих).
  Нет снимка (первая сверка) — направление отличий неизвестно: группа «отличаются без снимка», решает пользователь. `put` и `remove` снимок не меняют (это откат).
- Сравнение — по содержимому, CRLF и LF в тексте не различаются. Неизменённое на сервере (размер и время как в снимке) не скачивается.
- `protocol: "local"` в конфиге — «сервер» в папке `remotePath` на этой машине: только для проверки логики скриптов.
- Откат git правит только диск. Заливка — по режиму из `ACCESS.md` (хук или команда/«да» при `manual`).
