---
paths:
  - "**/block.json"
  - "**/render.php"
  - "**/src/**/*.js"
  - "**/src/**/*.jsx"
  - "**/src/**/*.ts"
  - "**/src/**/*.tsx"
  - "**/src/**/*.scss"
---

# Gutenberg blocks (native)

- Источник правды — `block.json`; регистрация через `register_block_type( __DIR__ . '/build/<block>' )`, не ручной список аргументов.
- `name` — `{stem}/<slug>` (префикс из `CLAUDE.md` → Префикс проекта). Один блок — одна папка в `src/`.
- Динамический вывод — `render.php` (`"render": "file:./render.php"`), не `save()` с разметкой. В `render.php` доступны `$attributes`, `$content`, `$block`.
- Статический `save()` — только если разметка реально не зависит от данных сайта. Меняешь разметку у статического блока → обязателен `deprecated`, иначе «block validation failed» у клиента.
- Оформление — через `supports` (`color`, `typography`, `align`), а не свои атрибуты-дубли. `alignfull` и `__inner` не подменять своими `--full` / `{stem}-container` — стили колонки вешать на них (rule `markup-layout`). Fluid `padding-block` и ширина контейнера — свои атрибуты (не `supports.spacing`). На обёртке в `render.php` — `get_block_wrapper_attributes()`.
- Атрибуты: явный `type` и `default`; `source` только для статических блоков. Не хранить в атрибутах то, что берётся из БД при рендере.
- Интерактивность фронта — Interactivity API через `viewScriptModule`, не свой jQuery-обвес. Skill: `wp-interactivity-api`.
- Стили: `editorStyle` / `style` в `block.json`; SCSS — партиалы блока в его папке, правила BEM из `scss-bem`. Каркас секции — rule `markup-layout`.

## Размеры и отступы в блоках и настройках

- Кегль и `padding-block` из редактора — **пара** мин/макс, только если в макете два разных значения. Иначе одно поле или дефолт темы, без `fluid-*`.
- Атрибуты пары: `fontSizeMin` / `fontSizeMax`, `padMin` / `padMax`, `type: "number"`, с `default`. В инспекторе — два `NumberControl` в одной `PanelBody`.
- Ширина колонки — два отдельных свойства, не fluid: `%` (`containerWidth`) и `max-width` px (`containerMaxWidth`). Дефолты — `$cltm-container-width` / `$cltm-container-max-width`.
- В `render.php` значения печатаются CSS-переменными на обёртке секции; интерполяцию пары делает `fluid-var` / `fluid-fs-var`:

```php
$style = sprintf(
	'--%1$s-fs-min:%2$dpx;--%1$s-fs-max:%3$dpx;--%1$s-pad-min:%4$dpx;--%1$s-pad-max:%5$dpx;--%1$s-container-width:%6$s;--%1$s-container-max-width:%7$dpx;',
	'cltm',
	absint( $attributes['fontSizeMin'] ),
	absint( $attributes['fontSizeMax'] ),
	absint( $attributes['padMin'] ),
	absint( $attributes['padMax'] ),
	sanitize_text_field( $attributes['containerWidth'] ),
	absint( $attributes['containerMaxWidth'] )
);
$wrapper = get_block_wrapper_attributes( array( 'style' => $style ) );
```

```scss
.cltm-hero {
	@include fluid-var('padding-block', '--cltm-pad-min', '--cltm-pad-max', 40, 80);

	&__title {
		@include fluid-fs-var('--cltm-fs-min', '--cltm-fs-max', 28, 64);
	}
}
```

- Настройки темы/плагина в админке: пару мин/макс — только если в макете два значения.
- Значения из редактора всегда через `absint()` / `floatval()` перед выводом в `style`.
- Сборка `@wordpress/scripts`: правится **только** `src/`, `build/` — артефакт. Не редактировать файлы в `build/` руками.
- На сервер (SFTP) уезжает `build/`, `block.json`-артефакты и PHP; `src/`, `node_modules/`, конфиги сборки — нет.
- Escape и i18n в `render.php` — как в `CLAUDE.md`; для JS — `@wordpress/i18n` с text-domain проекта.
- Skills: `wp-block-development`, при теме — `wp-block-themes` / `wp-patterns`.
