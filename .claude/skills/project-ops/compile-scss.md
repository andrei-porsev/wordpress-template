# Компиляция SCSS

Источник правды — SCSS. Собранный CSS руками не править и не читать.

Человек в редакторе: расширение Live Sass Compile (watch). Агент — скрипт; те же entry и `savePath`, что в `.vscode/settings.json`.

## Скрипт

Из корня репозитория:

```bash
node .claude/skills/project-ops/scripts/compile-scss.mjs
```

Берёт `liveSassCompile.settings.includeItems`, `formats`, `generateMap`. Типичный вывод: `assets/scss/index.scss` → `assets/css/index.css` (+ `.map`, если map включён).

Пустой `includeItems` или нет файла entry — остановиться, не угадывать другой путь. Entry правит `project-init` / человек.

## После компиляции

Локально CSS готов. Компилятор — процесс Bash, хук заливки его не видит. При `guarded-auto` / `stage-auto` залей CSS сам (`upload`, при `stage-auto` с `--stage`), при `manual` — по команде или «да» (`ssh.md`). Пути — из вывода компилятора, команда в [sftp.md](sftp.md).

## Когда

- После любой правки `.scss` агентом.
- Пользователь просит «скомпилируй стили», «пересобери css».
- Не вызывать, если в `INDEX.md` → Сборка указано, что SCSS нет.
