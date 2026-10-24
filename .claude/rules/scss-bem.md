---
paths:
  - "**/*.scss"
  - "**/*.sass"
---

# SCSS / BEM

Разметка секций — rule `markup-layout`. Префикс — `CLAUDE.md` (`{stem}-`; в заготовке SCSS `.cltm-…`, заменить на свой).

## Структура

- BEM; `&` для элементов и модификаторов. Один компонент / Gutenberg-блок — один файл.
- Classic, билдер: новые стили — partials → общий entry `index.scss`. `@use '../abstracts' as *;` в каждом партиале.
- FSE: стили core-блока — свой entry `block-<namespace>--<имя>.scss` рядом с `index.scss` (свой CSS, грузится только с блоком); в `index.scss` — только общее.
  Сначала `theme.json` и вариации — правило `fse-theme`, «CSS — четыре уровня». В каждом entry — `@use 'abstracts' as *;`.
- У темы и у каждого своего плагина — своя копия `abstracts/`. Чужие плагины не стилизовать изнутри.
- Сторонние селекторы: `.{stem}-block .woocommerce-…`. Отступы — табы, ширина 4.

## Секция и контейнер

Секция — на всю ширину, сброс margin/padding. Вертикальные поля — `padding-block` (fluid — по разнице мобильного и десктопа, ниже). Колонка — `__inner` (или `{stem}-container`, если inner нет).
Значения сайта (поля секций, шкала `gap`, кегли ролей) — `project-base/design/system.md` (правило `site-design`).

```scss
.cltm-hero {
	@include section-shell;
	@include fluid('padding-block', 40, 80);

	&__inner {
		gap: to-rem(24);

		@include tabletUp {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}
	}
}
```

- Оболочка — `section-shell` (внутри уже `&__inner` / `&__inner-container` + сброс `.alignfull` ядра).
- Свои 90% / 1200px — на обязательный inner; `alignfull` — `full-parent`. Не дублировать `{stem}-container` и `--full`, если эти классы уже есть.
- Переопределение из админки — CSS-переменные на секции + `fluid-var` / `var(--cltm-container-width, …)`.
- Layout-обёртки — только `flex` или `grid`. Между сиблингами — `gap`, не `margin` на детях.
- **Исключение — контент записи** (поток из редактора внутри обёртки контента, например `.entry-content`): ритм — `margin-block` элементов внутри обёртки
  (FSE — `styles.spacing.blockGap` и стили `core/post-content`). Обёртку контента в `flex` / `grid` не превращать.
- Только нужные свойства. Не дублировать то, что уже даёт миксин или нормализация.

## Специфичность

`!important` не писать. Переопределять более длинным селектором (`.cltm-hero .cltm-hero__inner`, `.cltm-hero.alignfull`). Исключение — чужие инлайны, которые иначе не сбить (как `img` у `full-block-image`).

## Брейкпоинты

Сначала именованный миксин, ближайший к значению из макета (`tabletUp`, `laptopDown`, `tablet`…). Сырые `up($w)` / `down($w)` / `between($min,$max)` — только если ни один диапазон не подходит.

## Fluid — по разнице мобильного и десктопа (решение 040)

- **Заголовки** (интерфейс и контент) — всегда `fluid-fs($моб, $деск)`.
- **Текст, подписи, кнопки, отступы** (`padding-block`, `gap`, поля компонентов) — `fluid-fs` / `fluid('property', $моб, $деск)`, если значения различаются **больше чем на 3 px**;
  3 px и меньше — одно значение по дизайну, обычное свойство без миксина.
- Диапазон по умолчанию — 320 → 1600 px, как у fluid-типографики WordPress (`$cltm-fluid-min-vw` / `$cltm-fluid-max-vw`, решение 049; за краями — крайние значения).
  Свой — аргументами `fluid-fs(26, 44, $bp-min: 768px, $bp-max: 1440px)` и строкой в `system.md`. FSE — тот же диапазон в `theme.json` (правило `fse-theme`).
- Роль, у которой есть пресет `theme.json`, — `var(--wp--preset--font-size--<слаг>)`, а не своя пара.
- Пары берутся из `project-base/design/system.md`; новой пары там нет — правило `site-design` (новые значения — с согласия).

```scss
.cltm-hero {
	&__title {
		@include fluid-fs(28, 64);
	}

	&__lead {
		font-size: to-rem(16);
		line-height: 1.5;
	}
}
```

Пара мин/макс в `theme.json` и в полях блока — по тому же правилу (rule `blocks`).

## Единицы (решение 043)

Числа в коде — px из макета; в rem переводят `to-rem()` и `fluid` / `fluid-fs` (база `$cltm-rem-base`: 16).

| Единица | Где |
|---------|-----|
| `rem` — `to-rem(24)`, `fluid*` | кегли, `padding-block` секций, `gap`, поля компонентов |
| `em` | привязанное к своему тексту: поля и иконка в кнопке, `letter-spacing`, отступы элементов контента (`h2 { margin-top: 1.5em; }`) |
| без единиц | `line-height` |
| `px` | рамки, `outline`, тени, радиусы, мелкие фиксированные детали, `max-width` контейнера, брейкпоинты |

- Значения в `px` из полей редактора (`fluid-var`, `render.php`) — как есть, px.
- Тема на px (старый сайт) — не переводить без просьбы: новое в той же системе, что сайт, в паспорте — «отклонение» (`fluid(…, $unit: px)`).

## Медиазапросы — внутри своего селектора

Миксин брейкпоинта — в том же блоке объявлений. Не в конце файла и не «хвостом» родителя с вложенным `&__el`.

```scss
.cltm-card {
	display: grid;
	gap: to-rem(16);

	@include tabletUp {
		grid-template-columns: 1fr 1fr;
	}

	&__title {
		@include fluid-fs(20, 32);

		@include mobileDown {
			text-align: center;
		}
	}
}
```

Неправильно:

```scss
.cltm-card {
	display: grid;

	@include mobileDown {
		&__title { text-align: center; }
	}
}

@include tabletUp {
	.cltm-card { grid-template-columns: 1fr 1fr; }
}
```

Заготовка — `project-base/_starter/README.md`. Неймспейс `@use … as a` — если так записано в INDEX → «Правила проекта».

## Скиллы вёрстки: `semantic-html` и `good-css`

В стеках `fse` и `classic`. `semantic-html` — выбор элемента, родной HTML вместо ARIA, заголовки, формы, реальный контент; дополняет `markup-layout`.
`good-css` — CSS-приёмы вместо обёрток, лесенок брейкпоинтов и скриптов (subgrid, container queries, `gap` у родителя, `:focus-visible`, `hover` под `(hover: hover)`, диалоги и аккордеоны на CSS); справочник — по строке его таблицы.
При конфликте действуют правила шаблона:

- Цвета — пресеты и палитра (решение 047), не `oklch()` литералами; оттенок — `color-mix()` от пресета.
- Размеры, растущие с экраном, — миксины `fluid*` (решения 040, 049), не свой `clamp()`.
- Каркас секции — `alignfull` + `__inner` / контейнер (`markup-layout`), не его «сетка контента с выходами»; брейкпоинты — миксины `_breakpoints.scss`, mobile-first.
- Его приёмы, которые заменяют медиазапрос или обёртку (intrinsic grid, sidebar, container queries, `gap` у родителя, `auto margin`), — предпочтительнее нового брейкпоинта и новой обёртки.
