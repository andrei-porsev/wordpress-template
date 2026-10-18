# Компиляция SCSS

Источник правды — SCSS. Собранный CSS руками не править и не читать.

Человек в редакторе: расширение Live Sass Compile (watch). Агент — скрипт; те же entry и `savePath`, что в `.vscode/settings.json`.

## Скрипт

Из корня репозитория:

```bash
node .claude/skills/project-ops/scripts/compile-scss.mjs
```

Берёт `liveSassCompile.settings.includeItems`, `formats`, `generateMap`. Типичный вывод: `assets/scss/index.scss` → `assets/css/index.css` (+ `.map`, если map включён).

`*` в имени файла — несколько entry (как в Live Sass): FSE — `"/wp-content/themes/<slug>/assets/scss/*.scss"` собирает `index.scss` и каждый `block-<namespace>--<имя>.scss`
в свой CSS; партиалы `_*.scss` пропускаются. Entry лежат плоско в `assets/scss/` — из подпапки `savePath: "~/../css"` увёл бы CSS не туда.

Пустой `includeItems` или нет файла entry — остановиться, не угадывать другой путь. Entry — `project.json` → `scss`, затем `gen-whitelist.mjs` (решение 036).

## Проверка без сборки

```bash
node .claude/skills/project-ops/scripts/compile-scss.mjs --check
```

Собирает во временную папку и сверяет с CSS на диске, ничего не пишет: source map и переводы строк не в счёт, разница только в пробелах — «OK (форматирование)».
«CSS УСТАРЕЛ» (код 1) — CSS не собран из текущего SCSS. Когда: SCSS пришёл с сервера (`sync-down` / `compare` подсказывают) — дальше `WORKFLOW.md` → 2.1, решение 038.

## После компиляции

Локально CSS готов. Компилятор — процесс Bash, хук заливки его не видит. При `guarded-auto` / `stage-auto` залей CSS сам (`upload`, при `stage-auto` с `--stage`), при `manual` — по команде или «да» (`ssh.md`). Пути — из вывода компилятора, команда в [sftp.md](sftp.md).

## Когда

- После любой правки `.scss` агентом.
- Пользователь просит «скомпилируй стили», «пересобери css».
- Не вызывать, если в `INDEX.md` → Сборка указано, что SCSS нет.
