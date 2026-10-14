---
paths:
  - "**/theme.json"
  - "**/templates/**/*.html"
  - "**/parts/**/*.html"
  - "**/patterns/**/*.php"
  - "**/patterns/**/*.html"
---

# FSE / block theme

- Источник правды: `theme.json` (settings/styles), `templates/`, `parts/`, `patterns/`.
- Не предлагай classic `header.php` / `sidebar.php` как основную модель, если тема уже block theme.
- Контентные секции — patterns; повторяемая логика UI — блоки (native или ACF), не раздувать `functions.php`.
- Типографика в `theme.json`: если пресет меняется от моб к десктопу — `fluid: { min, max }`; одно значение на всех ширинах — фиксированный `size`. `settings.layout.contentSize` держать равным `$cltm-container-max-width` (1200px). Каркас секций — rule `markup-layout`.
- Кастомную PHP-логику темы держи в `functions.php` / `inc/` на хуках; тяжёлое — в плагине.
- Woo в FSE: предпочитай Cart/Checkout **Blocks** и хуки/CRUD; classic `woocommerce/*.php` overrides — только если blocks недостают или пользователь просит.
- Подключай skills: `wp-block-themes`, `wp-patterns`, при блоках — `wp-block-development`.
