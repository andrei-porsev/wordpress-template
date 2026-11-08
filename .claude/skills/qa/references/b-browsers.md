# B — Браузеры

Основной прогон (A, C–H) — Chromium. B — те же страницы в WebKit (≈ Safari) и Firefox, через `playwright-cli`:

```
node .claude/skills/project-ops/scripts/browser.mjs open <url> --browser=webkit
node .claude/skills/project-ops/scripts/browser.mjs resize 375 812 --browser=webkit
node .claude/skills/project-ops/scripts/browser.mjs eval "() => …" --browser=webkit
node .claude/skills/project-ops/scripts/browser.mjs close --browser=webkit
```

`--browser` — у каждой команды: у каждого движка своя сессия. Каждая команда — отдельным вызовом Bash.
«Браузер … не установлен» — один раз на машину `node .claude/skills/project-ops/scripts/install-deps.mjs --browsers` (скачивает WebKit и Firefox, ~300 МБ) — спросить «да» до запуска.

## Объём

Страницы матрицы × 375, 768, 1440 (решение 062), только светлая тема. Мобильный WebKit — ещё `open … --browser=webkit --device="iPhone 15"` на главной и одной типовой.

## Что сравнивать с Chromium

- Переполнение и обрезка — скрипты из `a-responsive.md`.
- Скриншот той же ширины рядом с Chromium-снимком — глазами: шрифты (подгрузились ли, fallback), отступы `gap` / `aspect-ratio` / `:has()`, sticky-шапка, формы (`select`, `date`, чекбоксы — нативный вид), `backdrop-filter`, анимации.
- Консоль — `browser.mjs console warning --browser=…`: ошибки, которых нет в Chromium.
- Высота первого экрана — `100vh` / `100svh`: в WebKit-мобильном панель адреса.

## Ограничения

WebKit Playwright — не настоящий Safari на iPhone: не ловит часть особенностей iOS (панель адреса при прокрутке, `position: fixed` при клавиатуре, `-webkit-` у шрифтов).
В отчёте — «B: WebKit Playwright, не устройство». Настоящие устройства — человек или BrowserStack (по решению в `QA.md`).

## Серьёзность

Поломка вёрстки или функции только в одном браузере — как в A / F (**major** / **blocker**). Иной нативный вид контролов, сглаживание — не баг, если не мешает.
