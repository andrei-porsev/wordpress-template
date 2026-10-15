# Часть D — правки хуков и `settings.json`

Агент хуки и настройки не правит (защита шаблона). Правки подготовлены на копии шаблона, проверены и собраны в патч
[`part-d.patch`](part-d.patch) — применяет человек. 6 файлов: `guard-wpcli.mjs`, `lib.mjs`, `post-edit.mjs`, `selftest.mjs`, новый `session-start.mjs`, `settings.json`.

## Что меняется

| # | Файл | Правка | Зачем |
|---|------|--------|-------|
| 1 | `post-edit.mjs` | перед заливкой — сверка серверной версии файла со снимком синхронизации; изменён или удалён после сверки — **стоп**, на сервер не заливается | раньше хук бэкапил и заливал поверх — правка клиента терялась |
| 2 | `post-edit.mjs` | `debug.log` без SSH — копия по SFTP до и после заливки, новые Fatal → откат | раньше без SSH проверка молча пропускалась |
| 3 | `post-edit.mjs` | PHP-файл, нет локального PHP и SSH не ответил — **стоп** «проверить нечем» | раньше синтаксис не проверялся вообще |
| 4 | `post-edit.mjs` | проверка сайта шлёт `httpAuth` из `sftp.json` / `sftp-stage.json` | stage за паролем — хук видел только 401 |
| 5 | `post-edit.mjs`, `lib.mjs` | режим `local`: не заливает, проверяет `php -l` и что локальный сайт (`.vscode/local.json` → `url`) отвечает без 5xx | раньше незнакомый режим = `guarded-auto` (заливка на прод) |
| 6 | `lib.mjs` | `protocol: "local"` в конфиге считается настроенной заливкой | тесты хука без сервера |
| 7 | `guard-wpcli.mjs` | `local-exec.mjs -- wp …` разбирается так же, как `ssh-exec` (запреты, подтверждение) | защита локального WP-CLI была только внутри скрипта |
| 8 | `guard-wpcli.mjs` | `--stage`: меняющее WP-CLI — без подтверждения **после автодампа**; `db import`, `eval`, `shell`, `config`, составные команды — как на проде; дамп stage и прода — раздельно | доработка 9: на stage не спрашивать каждую команду |
| 9 | `session-start.mjs` + `settings.json` → `SessionStart` | напоминание агенту: «сначала `session-check`» (проект не настроен — `project-init`) | порядок «сверка → обновления → работа» не держится на памяти агента |
| 10 | `settings.json` → `allow` | читающие команды скриптов части C (`compare`, `list`, `deploy` план, `session-check`, `recon`, `connect-check`, `machine-check`, `stage-config` план, `local-exec`, тесты) | без запроса на каждую |
| 11 | `settings.json` → `ask` | всё с `--yes` / `--force` (`deploy`, `stage-config`, `local-exec`, `sync-down --force`), `connect-check --reset-auth / --forget-host`, правка `playwright-mcp.json`, `local.json` | меняющее — по-прежнему с подтверждением |
| 12 | `selftest.mjs` | +11 случаев: stage, `local-exec`, `session-start` | 62 проверки вместо 51 |

## Проверено

- `selftest.mjs` на подготовленных хуках — **62 из 62**.
- `project-ops/tests/test-post-edit.mjs` (заливка, чужая правка, `php -l`, Fatal в `debug.log` по SFTP с откатом, следующая правка после отката, `httpAuth`, «нет PHP и SSH», режимы `local` и `manual (local)`) — **11 из 11**;
  на текущих хуках тот же тест — 8 провалов (это и есть закрываемые дыры).
- `git apply --check` — патч применяется к шаблону без конфликтов.

## Как применить (человек, в своём терминале, в папке шаблона)

```bash
git apply --check project-base/plans/part-d.patch
git apply project-base/plans/part-d.patch
```

Перезапустить Claude Code (хуки и `settings.json` читаются при старте) — при первом запуске он может попросить одобрить новый хук `session-start.mjs`.
Затем агенту: «проверь часть D» — он прогонит `selftest.mjs`, `test-post-edit.mjs` и остальные тесты и закоммитит.

Откат, если что-то не так: `git checkout -- .claude/hooks .claude/settings.json` и удалить `.claude/hooks/session-start.mjs`.
