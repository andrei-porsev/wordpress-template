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

Секция — на всю ширину, сброс margin/padding. Вертикальные поля — `padding-block` (fluid, если в макете два значения). Колонка — `__inner` (или `{stem}-container`, если inner нет).

```scss
.cltm-hero {
	@include section-shell;
	@include fluid('padding-block', 40, 80);

	&__inner {
		gap: 24px;

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
- Только нужные свойства. Не дублировать то, что уже даёт миксин или нормализация.

## Специфичность

`!important` не писать. Переопределять более длинным селектором (`.cltm-hero .cltm-hero__inner`, `.cltm-hero.alignfull`). Исключение — чужие инлайны, которые иначе не сбить (как `img` у `full-block-image`).

## Брейкпоинты

Сначала именованный миксин, ближайший к значению из макета (`tabletUp`, `laptopDown`, `tablet`…). Сырые `up($w)` / `down($w)` / `between($min,$max)` — только если ни один диапазон не подходит.

## Fluid — только если значение меняется

Два разных значения на краях диапазона → `fluid-fs($min, $max)` или `fluid('property', $min, $max)`. Одно значение на всех ширинах → обычное свойство, без миксина.

```scss
.cltm-hero {
	&__title {
		@include fluid-fs(28, 64);
	}

	&__lead {
		font-size: 16px;
		line-height: 1.5;
	}
}
```

Пара мин/макс в `theme.json` и в полях блока — тоже только когда в макете два значения (rule `blocks`).

## Медиазапросы — внутри своего селектора

Миксин брейкпоинта — в том же блоке объявлений. Не в конце файла и не «хвостом» родителя с вложенным `&__el`.

```scss
.cltm-card {
	display: grid;
	gap: 16px;

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
