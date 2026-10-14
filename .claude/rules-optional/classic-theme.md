---
paths:
  - "**/themes/**/functions.php"
  - "**/themes/**/header.php"
  - "**/themes/**/footer.php"
  - "**/themes/**/index.php"
  - "**/themes/**/single.php"
  - "**/themes/**/page.php"
  - "**/themes/**/front-page.php"
  - "**/themes/**/*.php"
---

# Classic / child theme

- Правки только в child (или своей теме), не в parent и не в ядре. Для кастомизации чужого сайта плагин не создавай по умолчанию — см. `CLAUDE.md` → Тема или плагин.
- Шаблоны по hierarchy; разметка — `template-parts/`; page templates при необходимости. Каркас секции → контейнер — rule `markup-layout`.
- Ассеты: `wp_enqueue_style` / `wp_enqueue_script`; версия — `filemtime` или константа темы; скрипты с `defer`.
- Не вводи `theme.json` / FSE-templates как «улучшение», пока пользователь не попросил миграцию.
- Если в теме есть `theme.json` + `templates/` — это FSE, следуй rule `fse-theme`, не этому.
- SCSS: partials → один entry; см. rule `scss-bem`.
- При задачах classic theme читай skill `classic-theme`.
