# Скиллы: стеки и обновления

Манифест — `.claude/skills.json` (решение 016): откуда каждый скилл, на каком коммите апстрима, хеш содержимого, стеки.
Руками в манифесте правят только `sources`, `stacks`, `core`; остальное пишет скрипт.

```bash
node .claude/skills/project-ops/scripts/skills-sync.mjs <команда>
```

| Задача | Команда |
|--------|---------|
| Что есть и что подключено | `list` |
| Проверить апстрим | `check` |
| Посмотреть, что изменится | `update <имена>` или `update --all` (план: файлы и дифф `SKILL.md`) |
| Обновить | `update <имена> --apply` — **только после «да» пользователя** |
| Не напоминать про эту версию | `ignore <имена>` |
| Подключить стек | `activate <стек…>` |
| Отключить стек | `deactivate <стек…>` |
| Новый скилл из известного источника | `add <имя> --source <id> --path <путь> [--stack <стек>] [--exclude <путь,…>]` — `exclude` (например `scripts`, если скилл качает и запускает бинарники) хранится в манифесте и действует при `update`; скилл в корне репозитория — `--path .` и `exclude` для служебного (`README.md`, `.github`, манифесты плагинов) |

## Проверка при старте сессии

Хук `SessionStart` вызывает `check --hook`: сеть не чаще раза в сутки, иначе кэш `.claude/.state/skills-sync.json`.
Сообщает только об обновлениях подключённых скиллов (в самом шаблоне, где стеков нет, — обо всех). Есть сообщение — одной строкой
предложить пользователю обновление и показать план; применять после «да». Отказ — `ignore`.
Тот же вызов сообщает о начатом и не доведённом обновлении шаблона (миграция, конфликты, невлитая ветка); о новых версиях шаблона — нет (решение 059, [template.md](template.md)).

## Правила

- Локальные правки в копии скилла скрипт не перезаписывает. Свою доработку держи отдельным правилом или скиллом, а не правкой чужого:
  иначе каждое обновление — ручной перенос. Если правка нужна насовсем — `source: "local"` в манифесте (скилл становится своим).
- После `update --apply` — `git diff`, затем отдельный коммит «Скиллы: обновление <имена>».
- Источник без открытой лицензии — `sources` → `vendored: false` (сейчас `figma`): копий в шаблоне нет, `activate` сам скачивает недостающие скиллы стека из апстрима (решение 065).
  Лицензии остальных — `THIRD-PARTY-NOTICES.md` шаблона; новый источник — с лицензией в `sources` и строкой там же.
- Плагины (стек `seo`) обновляет Claude Code, не этот скрипт; `activate` только печатает фрагмент для `.claude/settings.json` —
  его вносит человек (хуки и настройки агенту закрыты).
- Новый скилл, которого нет ни в одном источнике манифеста, — сначала источник в `sources` (человек), потом `add`.
- Сеть — только `git ls-remote` и `git clone` во временную папку системы; `curl`/`wget` не нужны.

## Подключение в `.claude/settings.json` (делает человек)

Агент этот файл не правит (решение 019). Слить с существующими ключами, ничего не удаляя:

```json
{
	"permissions": {
		"allow": [
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs check*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs list*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs update*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs ignore*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs activate*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs deactivate*)"
		],
		"ask": [
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs *--apply*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs *--force*)",
			"Bash(node .claude/skills/project-ops/scripts/skills-sync.mjs add*)"
		]
	},
	"hooks": {
		"SessionStart": [
			{
				"matcher": "startup|resume",
				"hooks": [
					{
						"type": "command",
						"command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/project-ops/scripts/skills-sync.mjs\" check --hook",
						"timeout": 60
					}
				]
			}
		]
	}
}
```

`ask` сильнее `allow`: `update … --apply` и `--force` всегда спросят, даже при разрешённом `update`.
Хук задерживает первый ответ агента только раз в сутки, когда ходит в сеть (обычно 3–6 с, не больше ~40 с); в остальные старты читает кэш.
