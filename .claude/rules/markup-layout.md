---
paths:
  - "**/*.php"
  - "**/templates/**/*.html"
  - "**/parts/**/*.html"
  - "**/patterns/**/*.html"
  - "**/patterns/**/*.php"
  - "**/render.php"
---

# Разметка секций

Стили — rule `scss-bem`. Префикс `{stem}` — из `CLAUDE.md` и `project-base/project.json` (в заготовке SCSS — `cltm`, заменить).

## Семантика и SEO

- Семантический тег по роли: сайт — один `<header>` и один `<footer>`; контентные блоки — `<section>` / `<article>` / `<nav>`.
- Gutenberg / FSE / `template-part` уже дал `<header>` или `<footer>` — свою секцию этим тегом **не** оборачивать.
- Один `<h1>` на страницу. Заголовок секции — следующий уровень (`h2`…), не пропускать уровни.
- Лишних обёрток нет: нет «своего header вокруг header ядра».

## Каркас

Секция всегда на всю ширину. Узкая колонка — внутренний контейнер. Остальной контент — **внутри** него.

```html
<section class="cltm-hero alignfull">
	<div class="cltm-hero__inner">
		<h2 class="cltm-hero__title">…</h2>
		<div class="cltm-hero__grid">…</div>
	</div>
</section>
```

- Секция: `{stem}-header`, `{stem}-hero`, `{stem}-cta`… Тег — по семантике, не по привычке.
- Контейнер: если у блока обязателен `__inner` / `__inner-container` (InnerBlocks, Cover, Group) — колонка вешается **на этот класс**, вторую обёртку `{stem}-container` не добавлять. Нет обязательного inner — `{stem}-container`.
- На всю ширину родителя: если у блока обязателен `alignfull` — привязка к `.alignfull`, стили ядра (`100vw`, отрицательные margin) **переопределяем** своими (`width: 100%`, `max-width: none`, `margin-inline: 0`). Свой `--full` рядом не плодить.
- InnerBlocks / ACF / `template-parts` рендерятся внутрь контейнера.

## Админка

Дефолты контейнера — переменные темы (`$cltm-container-width` 90%, `$cltm-container-max-width` 1200px). Инспектор блока может переопределить CSS-переменными на обёртке секции (`--cltm-container-width`, `--cltm-container-max-width`, пара `--cltm-pad-min` / `--cltm-pad-max` для `padding-block`). Поля заводим, только если редактору это нужно; иначе — дефолт темы.
