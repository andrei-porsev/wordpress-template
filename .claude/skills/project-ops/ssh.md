# SSH

Агент не открывает интерактивную сессию `ssh user@host` — на пароле терминал зависнет.
Только скрипт ниже. Человек может зайти как угодно.

Конфиг: `.vscode/ssh.json`. Пустые `host` / `username` / `password` / ключ — берутся из `.vscode/sftp.json` (часто это один и тот же аккаунт). `cwd` пустой → `remotePath` из SFTP.

Память «что уже есть» — `ACCESS.md`. Скрипт пароль в stdout не пишет.

## Скрипт

Из корня. Зависимости те же, что у SFTP (`node .claude/skills/project-ops/scripts/install-deps.mjs`).

```bash
node .claude/skills/project-ops/scripts/ssh-exec.mjs test
node .claude/skills/project-ops/scripts/ssh-exec.mjs -- wp cache flush
node .claude/skills/project-ops/scripts/ssh-exec.mjs -- wp plugin list
```

Всё после `--` — команда **на сервере**, в `cwd`. Локальный `wp` так не вызывать.

| Команда | Когда |
|---------|--------|
| `test` | После записи доступов: проверка входа, `pwd`, есть ли WP-CLI. |
| `-- <cmd>` | WP-CLI и разовые шелл-команды с INDEX → «Команды». |

В `ACCESS.md` SSH = `нет` — скрипт не запускать и не просить логин повторно.

## Файлы на сервере

Режим — `ACCESS.md` → «Заливка». `guarded-auto` / `stage-auto`: правки заливает хук `post-edit`, агент `upload` не вызывает.
`manual`: SSH/SFTP есть — `upload` (см. [sftp.md](sftp.md)) только когда пользователь сказал залить / выложить / обновить
или ответил «да» на один вопрос со списком путей. Пока нет «да» — скрипт не вызывать.

Нет SSH/SFTP (host пустой) — не заливать. Хук в этом случае молчит, режим фактически `manual`.

При **«старт проекта»** поля SSH/WP-CLI собирает `project-init` → `access.md` (помощник SSH, диагностика — там же). Ниже — если доступ дали позже в чате.

## Что записать, когда дали доступ

В том же ходе, не спрашивая ещё раз:

1. `ACCESS.md` → раздел SSH / WP-CLI (есть/host/user/порт/auth/cwd/WP-CLI). Пароль: «в ssh.json», не дублировать текст пароля.
2. `.vscode/ssh.json` — `host`, `port`, `username`, `password` или `privateKeyPath`, `cwd`, `wpCli`.
3. Если сказали «те же, что SFTP» — в ACCESS.md так и написать; ssh.json можно оставить с пустым host (наследование).
4. `test`. Успех — дописать в ACCESS.md WP-CLI да/нет по выводу. В чат: «SSH ок», без пароля.

## Инварианты

- Не цитировать пароль и ключ.
- Не выдумывать `wp` на сервере, пока `test` не показал бинарь (или ACCESS.md уже «WP-CLI: да»).
- Охранник `.claude/hooks/guard-wpcli.mjs` проверяет каждую команду после `--`: `db drop|reset|clean`, `site empty|delete`, DROP/TRUNCATE, `sudo`, `rm -r` — блок; `search-replace` без `--dry-run`, `db import`, update/delete/activate, `eval`, составные команды — подтверждение пользователя; чтение и `--dry-run` — без запроса. Реагирует только на вызов `node …ssh-exec.mjs -- …` в начале команды или после `&&` / `;`.
- Перед первым подтверждением изменяющей команды WP-CLI за сессию охранник сам делает дамп: `wp db export ../claude-backup-<время>.sql` (на уровень выше каталога сайта; при `--stage` — на stage). Старые дампы на сервере чистит человек. Не удался — охранник пишет об этом в запросе на подтверждение.
- **Файлы на сервере не пишем.** Охранник запрещает `>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `wget`, `curl -o`, редакторы, `git`, `npm`, `tar`, `unzip` и чтение секретов (`wp-config`, `.env`, ключи). Код правится локально и заливается хуком. Прямой `ssh` / `scp` / `sftp` / `rsync` закрыт в `permissions.deny`.
- Без запроса разрешено чтение оболочкой (`tail`, `head`, `cat`, `ls`, `wc`, `grep`, `stat`, `du`, `df`, конвейер `|` из них, `php -v` / `-l` / `-m`) и WP-CLI на чтение: `plugin list`, `theme list`, `option get`, `core version`, `user list`, `post list`, `cache flush`, `rewrite flush`, `db export`, `db check`.
- sudo по SSH не использовать.
