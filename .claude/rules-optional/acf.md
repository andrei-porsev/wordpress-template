---
paths:
  - "**/acf-json/**"
  - "**/acf-blocks/**"
  - "**/*acf*"
---

# ACF

- Контент редактируемый через поля/блоки ACF; не хардкодь тексты и картинки в шаблоны без причины.
- ACF Blocks (ступень 3 лестницы): регистрация блока + template + SCSS; escape всех выводов. Каркас — rule `markup-layout`.
- Classic ACF в PHP (ступень 4): `get_field` / `the_field` в template-parts; проверяй пустые значения.
- `acf-json` синхронизируй с репо, если проект уже на local JSON.
- Предпочитай ACF Blocks нативным React-блокам для клиентских сайтов; native (`block.json` + scripts) — для переиспользуемого плагина / без ACF PRO, если так задано.
- Skill: `acf-blocks`.
