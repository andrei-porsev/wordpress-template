---
name: page-builders
description: "Use when customizing WordPress sites built with Elementor, Bricks, Divi, WPBakery, Oxygen or similar: child-theme CSS/SCSS, builder hooks/APIs, Woo widgets — do not migrate to FSE or rewrite builder templates unless the user asks."
compatibility: "Incoming/client projects with an active page builder. Pairs with project rule page-builders and scss-bem."
---

# Page Builders

## When to use

- Site already runs Elementor, Bricks, Divi, WPBakery, Oxygen, Flatsome UXBuilder, etc.
- Need visual tweaks, custom CSS, small PHP hooks, Woo widget styling
- User did **not** ask to rebuild on FSE or classic PHP layouts

## Procedure

### 1) Identify builder

Check active plugins / theme integrations. Work **with** that stack.

### 2) Where to change what

| Need | Place |
|------|--------|
| Global look (colors, spacing, typography) | Builder site settings if present; else child SCSS |
| One-section tweaks | Builder UI first; SCSS only if builder cannot |
| Dynamic PHP / Woo logic | Child `functions.php` / `inc/` hooks |
| New landing structure | Builder templates/sections — not new FSE templates |

Never edit the builder plugin’s core files.

### 3) Child theme CSS/SCSS

- Enqueue child stylesheet after parent/builder CSS when order matters.
- Scope selectors under a page/body class when possible.
- Prefer specificity over `!important`.
- Partials → single entry (`index.scss`); BEM for your own wrappers.

### 4) WooCommerce + builder

- Prefer the builder’s Woo widgets / product templates.
- Fall back to theme `woocommerce/` overrides or hooks only if widgets cannot deliver the requirement.

### 5) Guardrails

- Do not propose Elementor→FSE (or reverse) migration unless requested.
- Do not replace builder pages with hardcoded PHP templates “for cleanliness”.
- Keep changes reversible (child theme / custom CSS plugin), client-editable where they expect the builder UI.

### 6) Verify

- [ ] Builder plugin files untouched
- [ ] Changes live in child theme or allowed custom code location
- [ ] Architecture mode unchanged
- [ ] SCSS imported into entry; tabs indent
