---
paths:
  - "**/woocommerce/**"
  - "**/themes/**/woocommerce/**"
---

# WooCommerce

- **Никогда** не править файлы в `plugins/woocommerce/`.
- Overrides только в теме: `your-theme/woocommerce/...` (копия нужного шаблона).
- Логику — хуки в `functions.php` / `inc/`; сначала ищи hook, потом копируй шаблон.
- Цены, корзина, заказ: Woo API (`wc_get_product`, `WC()->cart`, `wc_get_order`), не сырой SQL по `wp_posts`.
- Учитывай **HPOS**: заказы через CRUD / `wc_get_order`, не мета-запросы к постам `shop_order` как к единственному источнику.
- Режим темы: FSE → blocks checkout/cart по возможности; classic → template overrides + hooks; билдер → виджеты/шаблоны билдера + точечный CSS.
- В override сохраняй/обновляй комментарий `@version`; не забывай при апдейте Woo.
- Skill: `woocommerce`.
