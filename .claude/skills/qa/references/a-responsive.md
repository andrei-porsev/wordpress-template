# A — Адаптив

Ширины, проверка переполнения, большие экраны, видимый элемент для замера — правило `layout-check` («Брейкпоинты», «Проверка по ширинам», «Замеры»). Здесь — что сверх этого ищет QA.

## Ширины

Полный набор `layout-check` (нижние границы диапазонов, границы переключения −1 px, 1920 / 2560 / 3840) — на каждой странице матрицы, только в Chromium.
Пресет `update` — 375, 768, 1440.

## На каждой ширине — `browser_evaluate`

1. Переполнение — скрипт из `layout-check`.
2. Обрезка и налезание:

```js
() => {
	const vis = ( e ) => {
		const s = getComputedStyle( e );
		const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0;
	};
	const label = ( e ) => `${ e.tagName.toLowerCase() }.${ String( e.className ).trim().split( /\s+/ )[ 0 ] }`;
	const text = [ ...document.querySelectorAll( 'h1,h2,h3,h4,p,li,a,button,label,span' ) ].filter( vis );
	// Текст обрезан: содержимое шире или выше блока при overflow hidden / clip.
	const clipped = text
		.filter( ( e ) => {
			const s = getComputedStyle( e );
			return /hidden|clip/.test( s.overflow + s.overflowX + s.overflowY ) && ( e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 ) && s.textOverflow !== 'ellipsis';
		} )
		.slice( 0, 10 )
		.map( label );
	// Кнопки и ссылки меньше 44 × 44 (кроме ссылок внутри текста).
	const small = [ ...document.querySelectorAll( 'a, button, [role="button"], input, select' ) ]
		.filter( ( e ) => vis( e ) && ! e.closest( 'p, li > p' ) )
		.filter( ( e ) => {
			const r = e.getBoundingClientRect();
			return r.width < 44 || r.height < 44;
		} )
		.slice( 0, 10 )
		.map( ( e ) => `${ label( e ) } ${ Math.round( e.getBoundingClientRect().width ) }×${ Math.round( e.getBoundingClientRect().height ) }` );
	// Мелкий текст на мобильном.
	const tiny = innerWidth < 768 ? text.filter( ( e ) => parseFloat( getComputedStyle( e ).fontSize ) < 14 ).slice( 0, 10 ).map( label ) : [];
	return { width: innerWidth, clipped, small, tiny };
}
```

3. Налезание соседних блоков — глазами по скриншоту на нижней границе каждого диапазона (375, 768, 1024, 1440) и на 2560; подозрение — замер `getBoundingClientRect` пары элементов.

## Ещё

- **Зум 200%** — на 1440: `document.documentElement.style.zoom = 2` (Chromium) — контент читается, нет горизонтальной прокрутки у текста, меню доступно.
- **Ориентация** — 812 × 375 (телефон лёжа): шапка и первый экран не съедают весь экран, модалки и меню закрываются.
- **Меню и модалки** на мобильном: открываются, прокручиваются, закрываются, фон не прокручивается под ними.
- **Картинки**: не растянуты (`object-fit` / пропорции), не мылятся (`layout-check` → большие экраны), арт-дирекция (`<picture>`) отдаёт свой кадр.

## Серьёзность

Переполнение и горизонтальная прокрутка, налезание, обрезанный текст, недоступное меню — **major**. Кнопка меньше 44 px, текст меньше 14 px на мобильном — **minor**.
