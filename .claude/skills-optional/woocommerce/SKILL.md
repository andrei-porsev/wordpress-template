---
name: woocommerce
description: "Use when customizing WooCommerce stores: theme template overrides, hooks/filters, cart/checkout (classic vs blocks), HPOS-safe order code, emails, product loops — never edit plugins/woocommerce core files."
compatibility: "WooCommerce with classic or block themes. Assumes HPOS may be enabled. Pairs with project rule woocommerce."
---

# WooCommerce

## When to use

- Product archive/single, cart, checkout, account, emails
- Custom fields on checkout, price display, badges, related products
- Compatibility with FSE, classic theme, or page builders

## Procedure

### 1) Detect storefront mode

| Signal | Approach |
|--------|----------|
| Block theme / Cart & Checkout blocks in use | Extend via block hooks, plugin, or Woo CRUD; avoid classic PHP overrides unless necessary |
| Classic theme + shortcodes / legacy checkout | Theme `woocommerce/` overrides + hooks |
| Elementor/Bricks/etc. Woo widgets | Builder templates first; PHP override last |

Do not switch cart/checkout model without an explicit user request.

### 2) Prefer hooks over template copies

1. Search for a Woo action/filter that achieves the change.
2. If markup must change, copy **only** the needed template from `plugins/woocommerce/templates/` into `theme/woocommerce/` (same relative path).
3. Never edit `plugins/woocommerce/**`.

### 3) Safe data access

- Products: `wc_get_product( $id )`, product methods — not raw post meta guesses.
- Cart: `WC()->cart` and documented cart APIs.
- Orders: `wc_get_order( $id )` and CRUD — **HPOS-safe**; do not assume `shop_order` lives in `wp_posts`.
- No ad-hoc SQL on Woo tables unless justified and prepared.

### 4) Checkout / cart fields

- Classic: `woocommerce_checkout_fields` and related validation/save hooks; nonce/capability where custom forms apply.
- Blocks checkout: use Woo Blocks extension points / documented APIs — do not expect classic field filters to fully apply.

### 5) Emails

- Overrides: `theme/woocommerce/emails/`
- Or hooks that inject content; escape and i18n.

### 6) Verify

- [ ] No core Woo plugin file changes
- [ ] Override `@version` noted if template copied
- [ ] HPOS-safe order access
- [ ] Escaping + text domain on output
- [ ] Mode (blocks vs classic vs builder) unchanged unless requested
