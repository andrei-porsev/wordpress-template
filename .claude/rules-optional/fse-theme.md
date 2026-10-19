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
- Типографика и отступы в `theme.json` — по `scss-bem` → «Fluid»: заголовки — `fluid: { min, max }` всегда; текст и отступы — при разнице больше 3 px, иначе фиксированный `size`.
  Ссылки на пресеты внутри `theme.json` — `var:preset|color|<слаг>` (не `var(--wp--preset--…)`: редактор не свяжет с палитрой); слаги — с дефисом перед цифрой (правило `site-design`).
  Стили контента — в `styles.blocks["core/post-content"]`, не в глобальных `styles.elements` (те же теги в интерфейсе — правило `site-design`). `settings.layout.contentSize` держать равным `$cltm-container-max-width` (1200px). Каркас секций — rule `markup-layout`.
- Кастомную PHP-логику темы держи в `functions.php` / `inc/` на хуках; тяжёлое — в плагине.

## CSS — четыре уровня, по порядку (решение 029)

1. **`theme.json`** — цвета, шрифты, размеры, отступы, ширины и стили core-блоков (`styles.blocks.core/button`…). CSS не писать; WordPress выводит стили только для блоков на странице, редактор совпадает с сайтом.
2. **Вариации стилей блока** — несколько видов одного блока (кнопка «контурная», группа «тёмная секция»): JSON в `styles/blocks/` (WP 6.6+) или `register_block_style()`.
3. **CSS на блок** — только когда настроек не хватает. Свой блок — `style` / `editorStyle` / `viewStyle` в `block.json` (правило `blocks`).
   Core-блок — отдельный файл на блок: `assets/scss/block-<namespace>--<имя>.scss` → `assets/css/block-<namespace>--<имя>.css`, подключение `wp_enqueue_block_style()` с `path`
   (грузится только на страницах с блоком, маленькие — инлайн). Пример — `project-base/_starter/README.md`.
4. **Небольшой общий файл** `index.scss` — только не привязанное к блоку: сбросы, каркас секции, утилиты; на сайт и в редактор (`add_editor_style`).

Паттернам свой CSS не нужен: уникальный CSS у паттерна — сигнал сделать вариацию стиля или свой блок. Глобальные стили — в `theme.json`, не в редакторе сайта (там они уходят в БД, не в git).
- Woo в FSE: предпочитай Cart/Checkout **Blocks** и хуки/CRUD; classic `woocommerce/*.php` overrides — только если blocks недостают или пользователь просит.
- Подключай skills: `wp-block-themes`, `wp-patterns`, при блоках — `wp-block-development`.
