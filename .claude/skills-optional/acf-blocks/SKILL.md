---
name: acf-blocks
description: "Use when building ACF field groups, ACF Blocks, or classic ACF-driven PHP templates: registration, block templates, escaping, acf-json sync — prefer editable fields over hardcoded content; use native block.json blocks when ACF PRO is not desired."
compatibility: "ACF and ACF PRO. Pairs with project rule acf. For native Gutenberg blocks without ACF use wp-block-development."
---

# ACF Fields & Blocks

## When to use

- ACF Blocks (priority ladder step 3)
- Classic `get_field` in PHP templates (step 4)
- Local JSON (`acf-json`) sync for version control
- Not for full FSE theme scaffolding — use `wp-block-themes` / patterns for that

## Procedure

### 1) Choose shape

| Goal | Approach |
|------|----------|
| Reusable section in editor, client edits fields | **ACF Block** |
| Fields on page/CPT, classic/PHP render | **Field group + template-part** |
| Distributable block without ACF dependency | **Native block** → `wp-block-development` |

### 2) ACF Block checklist

1. Register block (PHP `acf_register_block_type` or block.json + ACF, per project convention).
2. Field group assigned to that block.
3. Render template: escape every field (`esc_html`, `esc_url`, `wp_kses_post`, `wp_get_attachment_image`). Markup: section → `{stem}-container` → fields (rule `markup-layout`).
4. Styles: SCSS partial scoped to block BEM class; enqueue or `@import` via theme/plugin entry.
5. Preview mode in editor should not fatally error on empty fields — guard with checks.

### 3) Classic ACF in PHP

- `get_field( 'x' )` with empty checks before markup.
- Repeaters/flexible: loop safely; no assumptions on count.
- Options pages: know context (`'option'`).

### 4) acf-json

- If `acf-json/` exists, keep JSON in sync; do not duplicate field definitions only in DB.
- Commit JSON with the project when the team uses local JSON.

### 5) Security & i18n

- Treat all field values as untrusted output — escape by context.
- Label strings and block titles: translation functions + text domain.

### 6) Verify

- [ ] No content hardcoded that belongs in fields
- [ ] Empty states handled
- [ ] Escaping + i18n done
- [ ] Styles in partial/entry, not orphan file
- [ ] Native block path chosen only when ACF is out of scope
