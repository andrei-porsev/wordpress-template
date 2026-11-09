# C — Pixel perfect

Главное — **числа**: стили элемента на сайте против значений эталона, с допусками из `QA.md` → «Допуски» (по умолчанию: размеры и отступы 2 px, кегль и интерлиньяж 1 px, цвет ΔE 3).
Наложение картинкой — вспомогательно: шрифтовое сглаживание и другой контент дают ложную разницу.

## Эталон

Какие есть — `ACCESS.md` → «Дизайн» и `project-base/design/system.md`; порядок старшинства при расхождении — `QA.md` → «Настройки» → «Эталон» (по умолчанию — как в таблице).

| # | Эталон | Что даёт | Пометка в баге |
|---|--------|----------|----------------|
| 1 | Figma | числа по кадрам и переменным, наложение | — |
| 2 | Паспорт дизайна (`design/system.md`) | токены: палитра, шкала кеглей, отступы, компоненты — без привязки к странице | «по паспорту» |
| 3 | PDF-брендбук, значения от клиента | цвета, шрифты, кегли — что указано | «по брендбуку» |
| 4 | Сайт-образец (прод для stage после переноса или редизайна, старый сайт) | вычисленные стили тех же элементов | «против <адрес>» |
| 5 | Картинки, скриншоты макета | глазами, ±4 px | «по картинке, ±4 px» |

Нет ни одного — C пропускается; единство компонентов между страницами — правило `layout-check` → «Единство компонентов».
Эталоны расходятся между собой (Figma и паспорт) — не баг сайта: строкой в отчёт «расхождение эталонов» и вопрос пользователю, ответ — в `QA.md`.

## Порядок

1. **Подготовка страницы:** баннер cookies закрыть (`SKILL.md` → п. 2), раскрыть ленивую подгрузку прокруткой до низа и обратно; меню, выпадающие списки, модалки, вкладки, аккордеоны — открывать по очереди и мерить в открытом виде.
2. **Сводка по высоте** — на каждой странице и ширине кадра: высота кадра (Figma `get_metadata` / размер картинки) против `document.documentElement.scrollHeight`.
   Δh и % — первой строкой раздела C в отчёте; большая разница — смотреть п. 4 до мелких замеров.
3. **Токены до замеров:** таблица значений эталона — цвета (не меньше 5), шрифты, шкала кеглей, отступы, радиусы. Figma — `get_variable_defs` и стили кадра; паспорт — его таблицы.
   Неполная таблица токенов — главная причина ложных багов: значение «не из макета» сначала ищется среди всех токенов.
4. **Где поехало — смещение секций.** Верх и высота секций страницы против `y` и `height` дочерних кадров верхнего уровня (`get_metadata`); сопоставление — по порядку и первому заголовку:

```js
() => {
	const secs = [ ...document.querySelectorAll( 'header, main > *, footer' ) ].filter( ( e ) => e.getBoundingClientRect().height > 0 );
	return secs.map( ( e, i ) => {
		const r = e.getBoundingClientRect();
		return {
			i,
			el: `${ e.tagName.toLowerCase() }${ typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split( /\s+/ )[ 0 ] : '' }`,
			top: Math.round( r.top + scrollY ),
			height: Math.round( r.height ),
			title: e.querySelector( 'h1, h2, h3' )?.textContent.trim().slice( 0, 40 ) || '',
		};
	} );
}
```

   Δy каждой секции = `top` сайта − `y` кадра. **Первая секция, где Δy меняется** больше допуска относительно предыдущей, — причина: баг на неё (Δ высоты этой секции), смещения ниже — её следствие, отдельными багами не писать.
   Обёртка `main > div` одна на всю страницу — взять её детей. Картинки и сайт-образец — то же глазами по снимкам.
5. **Замеры элементов** — для ключевых текстовых стилей и блоков каждой секции, ширина окна = ширине кадра:

```js
() => {
	const sel = '.acme-hero__title'; // элемент из кадра
	const props = [ 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color', 'background-image',
		'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'gap', 'width', 'max-width', 'height',
		'border-radius', 'border-top-width', 'border-top-color', 'box-shadow', 'opacity', 'outline-color', 'outline-width', 'outline-offset' ];
	const vis = [ ...document.querySelectorAll( sel ) ].find( ( e ) => e.getBoundingClientRect().height > 0 && getComputedStyle( e ).visibility !== 'hidden' );
	if ( ! vis ) {
		return null;
	}
	const pick = ( s ) => {
		const o = Object.fromEntries( props.map( ( p ) => [ p, s.getPropertyValue( p ) ] ).filter( ( [ , v ] ) => v && v !== 'none' && v !== 'normal' && v !== '0px' ) );
		if ( ! parseFloat( s.borderTopWidth ) || s.borderTopStyle === 'none' ) {
			delete o[ 'border-top-color' ];
			delete o[ 'border-top-width' ];
		}
		if ( s.outlineStyle === 'none' ) {
			delete o[ 'outline-color' ];
			delete o[ 'outline-width' ];
			delete o[ 'outline-offset' ];
		}
		return o;
	};
	return {
		el: pick( getComputedStyle( vis ) ),
		before: getComputedStyle( vis, '::before' ).content !== 'none' ? pick( getComputedStyle( vis, '::before' ) ) : null,
		after: getComputedStyle( vis, '::after' ).content !== 'none' ? pick( getComputedStyle( vis, '::after' ) ) : null,
		box: ( ( r ) => ( { x: Math.round( r.left ), y: Math.round( r.top + scrollY ), w: Math.round( r.width ), h: Math.round( r.height ) } ) )( vis.getBoundingClientRect() ),
	};
}
```

   Элемент не находится по классу — по тексту (`[ ...document.querySelectorAll( 'h1,h2,h3,p,a,button' ) ].find( ( e ) => e.textContent.trim().startsWith( '…' ) )`), учитывая `text-transform`.
   Фокус (`outline-*`) — после Tab до элемента; градиенты — `background-image`; иконки и декор — `::before` / `::after`.
6. **Сравнение:** разница больше допуска — кандидат в баг. Цвет — ΔE (CIE76) между hex эталона и `rgb()` сайта. Подозрительное значение из `get_design_context` — перепроверить по `get_variable_defs` / свойствам слоя: сводка кода бывает неточной.
7. **Наложение** (вспомогательно) — снимок секции эталона и снимок той же секции на сайте при той же ширине (`browser_take_screenshot` с `ref`),
   `node .claude/skills/project-ops/scripts/shot-diff.mjs diff <эталон> <сайт>`. «Несопоставимы» по высоте — глазами, без числа.
   Большие области разницы при совпавших числах — порядок блоков, пропущенный элемент, другая картинка: смотреть и описывать.

## Перечень цветов и кеглей — и без Figma

Все цвета и кегли, реально использованные на странице, против палитры и шкалы эталона (Figma-переменные или паспорт). Цвет или кегль не из палитры — «#333 вместо токена», «15px вне шкалы»:

```js
() => {
	const palette = [ '#1A1A1A', '#FFFFFF' ]; // hex из эталона
	const scale = [ 14, 16, 18, 24, 32, 48 ]; // кегли эталона на этой ширине, px
	const tolE = 3; // ΔE из QA.md
	const lab = ( [ r, g, b ] ) => {
		const f = ( c ) => ( ( c /= 255 ) > 0.04045 ? ( ( c + 0.055 ) / 1.055 ) ** 2.4 : c / 12.92 );
		const [ R, G, B ] = [ f( r ), f( g ), f( b ) ];
		const xyz = [ ( R * 0.4124 + G * 0.3576 + B * 0.1805 ) / 0.95047, R * 0.2126 + G * 0.7152 + B * 0.0722, ( R * 0.0193 + G * 0.1192 + B * 0.9505 ) / 1.08883 ];
		const [ x, y, z ] = xyz.map( ( v ) => ( v > 0.008856 ? Math.cbrt( v ) : 7.787 * v + 16 / 116 ) );
		return [ 116 * y - 16, 500 * ( x - y ), 200 * ( y - z ) ];
	};
	const hex = ( h ) => h.replace( '#', '' ).match( /../g ).map( ( v ) => parseInt( v, 16 ) );
	const pal = palette.map( ( h ) => [ h, lab( hex( h ) ) ] );
	const dE = ( a, b ) => Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] );
	const colors = new Map();
	const sizes = new Map();
	for ( const e of document.querySelectorAll( 'body *' ) ) {
		const r = e.getBoundingClientRect();
		const s = getComputedStyle( e );
		if ( ! r.width || ! r.height || s.visibility === 'hidden' || e.closest( 'svg, iframe, [aria-hidden="true"]' ) ) {
			continue;
		}
		const hasText = [ ...e.childNodes ].some( ( n ) => n.nodeType === 3 && n.textContent.trim() );
		for ( const [ prop, on ] of [ [ 'color', hasText ], [ 'background-color', true ], [ 'border-top-color', parseFloat( s.borderTopWidth ) > 0 ] ] ) {
			const m = on && s.getPropertyValue( prop ).match( /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/ );
			if ( m && ( m[ 4 ] === undefined || +m[ 4 ] > 0.1 ) ) {
				const key = `${ prop } rgb(${ m[ 1 ] },${ m[ 2 ] },${ m[ 3 ] })`;
				colors.set( key, { n: ( colors.get( key )?.n || 0 ) + 1, rgb: [ +m[ 1 ], +m[ 2 ], +m[ 3 ] ], el: colors.get( key )?.el || e } );
			}
		}
		if ( hasText ) {
			const fs = Math.round( parseFloat( s.fontSize ) * 10 ) / 10;
			sizes.set( fs, { n: ( sizes.get( fs )?.n || 0 ) + 1, el: sizes.get( fs )?.el || e } );
		}
	}
	const name = ( e ) => `${ e.tagName.toLowerCase() }${ typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split( /\s+/ )[ 0 ] : '' }`;
	const offColors = [ ...colors ].map( ( [ k, v ] ) => {
		const best = pal.map( ( [ h, l ] ) => [ h, dE( lab( v.rgb ), l ) ] ).sort( ( a, b ) => a[ 1 ] - b[ 1 ] )[ 0 ];
		return { k, n: v.n, nearest: best?.[ 0 ], dE: Math.round( ( best?.[ 1 ] ?? 999 ) * 10 ) / 10, el: name( v.el ) };
	} ).filter( ( c ) => c.dE > tolE );
	const offSizes = [ ...sizes ].filter( ( [ fs ] ) => ! scale.some( ( v ) => Math.abs( v - fs ) <= 0.5 ) ).map( ( [ fs, v ] ) => ( { fs, n: v.n, el: name( v.el ) } ) );
	return { offColors, offSizes };
}
```

Кегли — на каждой ширине своя шкала (fluid: промежуточные ширины не сверять, только ширины эталона). Белый, чёрный, прозрачные — в палитру, если они есть в эталоне.

## Кадры Figma без MCP

У MCP Figma есть лимиты вызовов: больше ~20 кадров или ответ про лимит — человек выгружает кадры из приложения Figma: кадр → Export → PNG, 1x,
в `.claude/.state/qa/design/<страница>/<ширина>.png` (не в git). Агент берёт снимки для наложения и высоту оттуда; числа (п. 3, 5) — по-прежнему MCP, но только переменные и ключевые стили.

## Не баг — отсев перед отчётом

Каждого кандидата проверить до записи:

- значение есть в таблице токенов под другим именем или в соседней роли (цвет текста-подписи = цвет иконки);
- состояние (`hover`, `active`, текущий пункт, ошибка) по праву выглядит иначе;
- разница из-за контента: длиннее текст, другая картинка — это D, не C;
- адаптив между ширинами эталона: макета 768 нет — промежуточные ширины не сверяются (только A);
- сглаживание шрифтов, субпиксели ≤ 1 px; разрыв строк Figma ≠ браузера при том же кегле и ширине блока;
- отступления и исключения из `QA.md`.

## Серьёзность

Другой шрифт, цвет бренда, пропущенный элемент, другой порядок блоков, секция-причина смещения больше 40 px — **major**. Отклонение больше допуска, цвет или кегль вне палитры — **minor**.
На грани допуска (≤ допуск + 1 px) — **cosmetic**.
