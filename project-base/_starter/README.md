# Стартовые заготовки

Не часть какой-либо темы или плагина. Копируется в проект при старте,
на сервер не заливается.

```
project-base/_starter/scss/
  abstracts/          переменные и миксины — переносится всегда
    _variables.scss   ширина контейнера (90% / 1200px)
    _breakpoints.scss брейкпоинты, up/down/between, именованные диапазоны
    _mixin.scss       fluid, fluid-fs, fluid-var, line-clamp, анимации (keyframes на корне)
    _layout.scss      section-shell, content-container, full-parent (без CSS на выходе)
    _index.scss       @forward всех; резолвится как '../abstracts'
  global/
    _layout.scss      класс .{stem}-container — fallback без __inner
  index.scss          entry — только для проекта с нуля
```

Ключевое разделение: `abstracts/` не даёт CSS на выходе, поэтому добавляется
в любой проект без побочных эффектов. `index.scss` — общая точка входа.
Classic и билдер — второй точки входа не нужно; FSE — плюс entry на каждый доработанный core-блок (сценарий 1, «FSE»).

---

## Куда копировать

- Тема: `wp-content/themes/{тема}/assets/scss/`
- Плагин: `wp-content/plugins/{плагин}/assets/scss/`

У темы и у **каждого** своего плагина — собственная независимая копия `abstracts/`.
Общей папки на весь сайт быть не должно.

Причина: плагин обязан оставаться переносимым. Если его SCSS тянет миксины из темы,
он перестаёт собираться при установке на другой сайт, а смена темы ломает сборку.
Плюс жизненные циклы разные: плагин может быть закончен и заморожен, пока тема
продолжает развиваться.

Расхождение копий здесь — не проблема, а ожидаемое поведение: у завершённого плагина
набор миксинов остаётся тем, на котором его собирали. Источник правды для новых
копий — `project-base/_starter/`; подтягивать в старый плагин свежую версию только при реальной
необходимости и с пересборкой CSS.

---

## Сценарий 1. Проект с нуля, SCSS ещё нет

Копировать папку `scss/` целиком. Каркас секций — rule `markup-layout`. В партиалах:

```scss
@use '../abstracts' as *;

.cltm-hero {
	@include section-shell;
	@include fluid('padding-block', 40, 80);

	&__title {
		@include fluid-fs(28, 64);
	}

	&__lead {
		font-size: 16px;
	}
}
```

### FSE: CSS на блок

Сначала `theme.json` и вариации стилей (правило `fse-theme`, решение 029). Не хватило — файл на блок, плоско рядом с `index.scss`:

```
assets/scss/
  abstracts/                     из заготовки
  global/                        партиалы общего файла
  index.scss                     общее: сбросы, каркас секции, утилиты
  block-core--navigation.scss    доработка core/navigation
  block-core--button.scss        доработка core/button
```

Имя: `block-<namespace>--<имя блока>` — двойной дефис отделяет пространство имён (`woocommerce--product-price` → `woocommerce/product-price`).
В каждом entry блока — `@use 'abstracts' as *;`. Live Sass и `compile-scss.mjs` собирают всё по шаблону:
`.vscode/settings.json` → `liveSassCompile.settings.includeItems`: `"/wp-content/themes/{тема}/assets/scss/*.scss"`.

Подключение в теме (`inc/block-styles.php`, `cltm` → `{stem}`):

```php
/**
 * CSS доработанных core-блоков: assets/css/block-<namespace>--<имя>.css грузится только на страницах с блоком.
 */
function cltm_enqueue_block_styles() {
	foreach ( glob( get_theme_file_path( 'assets/css/block-*--*.css' ) ) as $path ) {
		$file  = basename( $path, '.css' );
		$block = str_replace( '--', '/', substr( $file, strlen( 'block-' ) ) );

		wp_enqueue_block_style(
			$block,
			array(
				'handle' => 'cltm-' . $file,
				'src'    => get_theme_file_uri( 'assets/css/' . $file . '.css' ),
				'path'   => $path,
				'ver'    => (string) filemtime( $path ),
			)
		);
	}
}
add_action( 'init', 'cltm_enqueue_block_styles' );
```

`path` нужен, чтобы маленькие стили WordPress встроил прямо в страницу. Общий `index.css` — на `wp_enqueue_scripts` и в редактор через `add_editor_style( 'assets/css/index.css' )`.

## Сценарий 2. В проекте уже есть SCSS

Копировать **только `abstracts/`**. Свой `index.scss` не трогать, entry остаётся
проектный. `{stem}-container` — только если у блока нет `__inner`:

```scss
.cltm-container {
	@include content-container;
}
```

Плагин, который сам рендерит секции, подключает тот же миксин у себя — не тянуть класс из темы.

Перед копированием проверить три вещи.

### Конфликт имён

Имена вроде `up`, `down`, `mobile`, `tablet` часто уже заняты — своими миксинами
или наследием Bootstrap. Проверить:

```bash
grep -rn "@mixin \(up\|down\|between\|mobile\|tablet\|laptop\|desktop\|fluid\)" .
grep -rn "\$bp-" .
```

Пусто — подключать как `as *`. Есть совпадения — подключать с неймспейсом,
переименовывать чужие миксины не нужно:

```scss
@use '../abstracts' as a;

.cltm-card {
	@include a.fluid-fs(16, 20);

	@include a.tabletUp {
		display: grid;
	}
}
```

Неймспейс выбирается один на проект и фиксируется в `project-base/INDEX.md`
→ «Правила проекта».

### Конфликт @use и @import

`abstracts/` написан на `@use`. Если проектный entry собран на `@import`,
смешивать нельзя — Sass загрузит файл дважды и переменные разъедутся.

Варианты: перевести entry на `@use` (правильно, но затрагивает все партиалы)
либо подключать абстракции только в новых партиалах на `@use`, не трогая старые.
Второй вариант рабочий, если старые партиалы миксины не используют.

### Дубли брейкпоинтов

Если в проекте уже есть своя сетка брейкпоинтов, две системы значений — источник
плавающих багов. Либо привести `_breakpoints.scss` к проектным значениям
(и записать это в «Правила проекта»), либо не копировать его вовсе и оставить
только `_mixin.scss`, заменив в нём `$bp-*` на проектные переменные.

Значения с `!default` можно переопределить при подключении, не правя файл:

```scss
@use '../abstracts' as * with (
	$bp-tablet-min: 800px
);
```


---

## Компиляция

Человек в редакторе — Live Sass Compile (watch). Агент — skill `project-ops`
→ `compile-scss.md` (тот же entry из `settings.json`).

Live Sass: entry указывается в `.vscode/settings.json` →
`liveSassCompile.settings.includeItems` (FSE — шаблон `assets/scss/*.scss`). При смене слага темы поправить путь.

На сервер уезжает скомпилированный CSS. Исходный SCSS хранится в git —
он и есть источник правды, править собранный CSS нельзя.
