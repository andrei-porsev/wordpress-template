---
paths:
  - "**/theme.json"
  - "**/styles/**/*.json"
  - "**/patterns/**"
  - "**/templates/**/*.html"
  - "**/parts/**/*.html"
  - "**/template-parts/**/*.php"
  - "**/*.scss"
  - "markup/**/*.html"
---

# Дизайн: направление и источник макета

Скилл `frontend-design` — как придумать узнаваемый дизайн; `wp-patterns` и правило `figma-design` — как перенести его в тему.

## Откуда берётся дизайн

Порядок проверки — `ACCESS.md` → «Figma» и «Дизайн (Claude Design)»:

1. **Figma** — правило `figma-design`, скилл `figma-design-to-code`.
2. **Claude Design** (решение 023) — три пути, результат один:
   - `/design` прямо в этой сессии Claude Code: макет создаётся и правится здесь, потом верстается;
   - handoff из Claude Design (claude.ai) в Claude Code;
   - экспорт HTML/ZIP в `project-base/design/`.
   Ссылку на дизайн после создания — в `ACCESS.md` → «Дизайн (Claude Design)» сразу. Дальше для любого пути:
   - Макет — прототип, а не код темы. Из него берём значения: палитру, шрифты, шкалу кеглей, отступы, радиусы, тени.
   - Значения → пресеты `theme.json` (`color.palette`, `typography.fontSizes`, `spacing.spacingSizes`) или переменные `_variables.scss` одной правкой; в разметке и SCSS — только пресеты.
   - Разметку переписываем по правилам `markup-layout` и `scss-bem` с префиксом `{stem}`; классы и инлайн-стили экспорта не переносим.
   - Секция макета → pattern или template-part; повторяемый элемент с логикой → блок.
   - Расхождение значения макета со шкалой — сначала токен, потом использование (как в `figma-design`).
3. **Макета нет** — скилл `frontend-design`: сначала план (4–6 цветов с hex, шрифты и роли, схема раскладки, принципы страницы), сверка плана с брифом, «да» пользователя — потом код. Без утверждённого плана не верстать.
   Утверждённый план — в паспорт `project-base/design/system.md` (правило `site-design`), не только в чат.

После утверждения любого макета — паспорт дизайна по нему (`project-init` → `design-system.md`): дальше агент верстает по паспорту.

## Скиллы дизайна: UI/UX Pro Max и Impeccable

Оба — в стеке `design` рядом с `frontend-design`; при конфликте с этим правилом, `site-design`, `markup-layout`, `scss-bem`, `motion` действуют правила шаблона.

- **`ui-ux-pro-max`** — направления до макета: `py -3 .claude/skills/ui-ux-pro-max/scripts/search.py "<продукт> <ключевые слова>" --design-system` (путь из SKILL.md с `CLAUDE_PLUGIN_ROOT` — этот),
  2–3 запуска с разными ключевыми словами и `--variance` → 2–3 разных варианта первого экрана; точечно — `--domain ux|typography|color|landing|gsap`.
  `--stack` не использовать (стека WordPress нет, `html-tailwind` уводит в Tailwind); `--persist` не использовать — итог в паспорт `system.md` и `theme.json`.
  Шрифты из выдачи — только локально (раздел «Шрифты» ниже), не `@import` Google Fonts.
- **`impeccable`** — справочники без движка: папки `scripts/` нет (exclude: лаунчер скачивает и запускает бинарник), лаунчер не искать и не скачивать, `npx impeccable …` не запускать (обновление — только `skills-sync`) — сразу режим «Launcher unavailable».
  Его `PRODUCT.md` — это `.claude/product-marketing.md`, `DESIGN.md` — `project-base/design/system.md`; своих файлов в корне и `.impeccable/` не заводить, `hooks`, `live`, `generate`, `pin` не использовать.
  - Создание макета: `reference/craft-floor.md` (планка и запреты «AI-вида»), `new-work.md` (визуальный мир, режим страницы: портфолио — Experience, лендинг — Persuade),
    `typeset`, `colorize`, `layout`, `animate`, `delight`, `bolder`. Шаги с командами движка (`comp-spec`, `font-match`, `comp-diff`, `build-phase`) — глазами по снимкам `layout-check`.
  - Доводка: `critique`, `audit` (без движка), `quieter`, `distill`, `polish`, `harden`.
- Направления, палитры и шрифты показывать плашками и образцами — `site-design` → «Показ цветов и шрифтов пользователю».
- Порядок: бриф → `ui-ux-pro-max` даёт разные направления → выбор пользователя → `impeccable` (+ `frontend-design`) держит планку и доводит → утверждение → вёрстка.

## Дизайн-система клиента

- Одна дизайн-система на клиента в Claude Design (Settings → Design systems); имя — как слаг темы.
- Тема уже есть (редизайн, следующий проект клиента) — `/design-sync` из темы: `theme.json`, `_variables.scss`, шрифты. Новые макеты сразу в цветах и шрифтах клиента.
- Темы ещё нет — сначала утверждённый макет, потом `theme.json`, потом `/design-sync`.
- Источник правды по токенам — `theme.json`. Поменялись пресеты темы — повторить `/design-sync`, а не править дизайн-систему руками.
- Имя дизайн-системы — в `ACCESS.md` → «Дизайн (Claude Design)».

## Приоритеты

- Слова брифа и утверждённый макет важнее любых скиллов.
- Эстетика: `frontend-design` важнее типографических приёмов из `wp-patterns` → `design-with-tokens.md`. Капс-лейблы над заголовками, выделение одного слова в заголовке, нумерация 01/02/03 без реальной последовательности — не по умолчанию.
- Смелость — в одном элементе страницы; остальное спокойное. Анимации — правило `motion`, один срежиссированный момент на страницу.

## Шрифты и картинки

- Шрифты — локально в теме: `theme.json` → `fontFace` (FSE) или `@font-face` в SCSS (classic), WOFF2, `font-display: swap`. Google Fonts по CDN не подключать (GDPR, лишний запрос).
- Не больше двух семейств; начертания — только используемые.
- Картинки из макета — экспорт WebP/AVIF/SVG в тему, не ссылки на claude.ai или figma.com.

## Проверка

Правило `layout-check` плюс самокритика по скриншотам 375 и 1440: что выглядит как шаблон по умолчанию — переделать до «готово».
