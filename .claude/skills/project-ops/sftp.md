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
node .claude/skills/project-ops/scripts/sftp-sync.mjs download <rel> [<rel>...]
node .claude/skills/project-ops/scripts/sftp-sync.mjs upload <rel> [<rel>...]
node .claude/skills/project-ops/scripts/sftp-sync.mjs sync-down
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
| `download` | Забрать конкретные файлы с сервера. |
| `upload` | Залить указанные пути. В `guarded-auto` / `stage-auto` заливает хук; вручную — режим `manual` по команде или «да» (см. `ssh.md`). |
| `fetch <rel> <файл>` | Забрать серверную версию в произвольный локальный файл (бэкап хука). Нет на сервере — вывод `MISSING`, код 3. |
| `put <файл> <rel>` | Залить произвольный локальный файл на путь `rel` (откат из бэкапа). |
| `remove <rel>` | Удалить файл на сервере (откат новой заливки). |
| `sync-down` | Перед задачей: сервер → локально, только whitelist из `ignore`. |
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
- Откат git правит только диск. Заливка — по режиму из `ACCESS.md` (хук или команда/«да» при `manual`).
