---
name: classic-theme
description: "Use when building or customizing classic or child PHP WordPress themes: template hierarchy, template-parts, enqueue, functions.php structure, Woo template overrides path, SCSS entry — not FSE/theme.json unless migrating."
compatibility: "Classic PHP themes and child themes. Tabs for indent (size 4). Pairs with project rules classic-theme and scss-bem."
---

# Classic Theme

## When to use

- Child / classic theme PHP templates, `functions.php`, `template-parts/`
- Enqueue CSS/JS for a non-block theme
- Adding page templates or Woo overrides under `theme/woocommerce/`
- Explicitly NOT the primary skill for block themes (`theme.json` + `templates/*.html`) — use `wp-block-themes` instead

## Procedure

### 1) Confirm mode

- If `theme.json` + `templates/` exist and drive the site → stop and use `wp-block-themes`.
- If parent/child: edit **child** only.

### 2) Structure

Prefer:

```
theme-child/
  style.css          # header only if needed
  functions.php
  inc/               # split by concern (setup, assets, woo)
  template-parts/
  woocommerce/       # overrides only when hooks are not enough
  assets/
    scss/index.scss
    css/             # compiled
    js/
```

### 3) Assets

- Register/enqueue on `wp_enqueue_scripts`.
- Version: `filemtime( $path )` or theme version constant.
- Scripts: load in footer; use `defer` via strategy or `wp_script_add_data( $handle, 'strategy', 'defer' )` when appropriate.
- Do not hardcode `<script>` / `<link>` in templates.

### 4) Templates

- Follow template hierarchy; extract repeated markup to `get_template_part()`.
- Section → `{stem}-container` → content; semantics/SEO — project rule `markup-layout`.
- Escape all output; i18n all user-facing strings.
- Images: `wp_get_attachment_image()`.

### 5) WooCommerce (classic)

- `add_theme_support( 'woocommerce' )` and gallery supports as needed.
- Prefer hooks; copy template to `theme/woocommerce/...` only when markup must change.
- Keep `@version` comment in sync with plugin template.

### 6) Verify

- [ ] No edits in parent theme or `plugins/woocommerce/`
- [ ] Assets enqueued, not hardcoded
- [ ] Tabs for indentation; WPCS spacing inside `()`
- [ ] SCSS partial imported into entry file
