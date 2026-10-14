---
paths:
  - "**/plugins/**"
  - "**/mu-plugins/**"
---

# Plugins

## Default (входящий / чужой сайт)

- Кастомизация → **child theme**, не новый плагин.
- Не предлагай «вынести в плагин», если хватает `functions.php` / `inc/` / SCSS в child.

## Когда создавать свой плагин

Только если верно одно из:

- отдельный переносимый функционал (между сайтами / продуктом);
- пользователь явно просит плагин;
- логика не про презентацию темы (интеграции, CRUD, cron, свой REST), и её нельзя адекватно держать в child.

Иначе — child theme.

## Guardrails

- **Не править** чужие плагины в `wp-content/plugins/{vendor}/`.
- Свой код: префикс = slug плагина (см. `CLAUDE.md` → Префикс проекта).
- Архитектура, security, Settings API → skill `wp-plugin-development`.
- Блоки в плагине → `wp-block-development` или `acf-blocks` по лестнице.
- Woo-логика в своём плагине/child — skill `woocommerce`; файлы Woo не трогать.

## mu-plugins

- Только must-load / мелкий bootstrap; не свалка фич сайта.
