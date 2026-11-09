# A — Адаптив

Ширины, проверка переполнения, большие экраны, видимый элемент для замера — правило `layout-check` («Брейкпоинты», «Проверка по ширинам», «Замеры»). Здесь — что сверх этого ищет QA.

## Ширины

Полный набор `layout-check` (нижние границы диапазонов, границы переключения −1 px, 1920 / 2560 / 3840) — на каждой странице матрицы, только в Chromium.
Пресет `update` — 375, 768, 1440.

## На каждой ширине — `browser_evaluate`

1. Переполнение страницы — скрипт из `layout-check`.
2. **Текст вне своего блока.** Блок — ближайший предок с фоном, рамкой или тенью (карточка, кнопка, плашка). Замер — по глифам (`Range`), а не по размеру элемента;
   пропускаются прокручиваемые контейнеры, `line-clamp`, `text-overflow: ellipsis`, `sr-only` и `aria-hidden`. Обрезанный `overflow: hidden` текст тоже попадает сюда.

```js
() => {
	const label = ( e ) => `${ e.tagName.toLowerCase() }${ e.className && typeof e.className === 'string' ? '.' + e.className.trim().split( /\s+/ )[ 0 ] : '' }`;
	const shown = ( e ) => {
		const s = getComputedStyle( e );
		const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0;
	};
	const boxed = ( s ) =>
		( s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent' ) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' ||
		[ 'Top', 'Right', 'Bottom', 'Left' ].some( ( p ) => parseFloat( s[ `border${ p }Width` ] ) > 0 && s[ `border${ p }Style` ] !== 'none' );
	const out = [];
	const walk = document.createTreeWalker( document.body, NodeFilter.SHOW_TEXT );
	const seen = new Set();
	while ( walk.nextNode() && out.length < 15 ) {
		const node = walk.currentNode;
		const el = node.parentElement;
		if ( ! node.textContent.trim() || seen.has( el ) || ! shown( el ) || el.closest( 'script, style, noscript, .sr-only, .screen-reader-text, [aria-hidden="true"]' ) ) {
			continue;
		}
		seen.add( el );
		let box = null;
		for ( let p = el; p && p !== document.body; p = p.parentElement ) {
			const s = getComputedStyle( p );
			if ( s.webkitLineClamp !== 'none' && s.webkitLineClamp || s.textOverflow === 'ellipsis' || ( p !== el && /auto|scroll/.test( s.overflowX + s.overflowY ) ) ) {
				box = null;
				break;
			}
			if ( boxed( s ) ) {
				box = p;
				break;
			}
		}
		if ( ! box ) {
			continue;
		}
		const range = document.createRange();
		range.selectNodeContents( node );
		const t = range.getBoundingClientRect();
		const b = box.getBoundingClientRect();
		const over = {
			right: Math.round( t.right - b.right ),
			left: Math.round( b.left - t.left ),
			bottom: Math.round( t.bottom - b.bottom ),
			top: Math.round( b.top - t.top ),
		};
		const bad = Object.entries( over ).filter( ( [ , v ] ) => v > 1 );
		if ( t.width && bad.length ) {
			out.push( `${ label( el ) } в ${ label( box ) }: ${ bad.map( ( [ k, v ] ) => `${ k } +${ v }px` ).join( ', ' ) } «${ node.textContent.trim().slice( 0, 30 ) }»` );
		}
	}
	// Кнопки и ссылки меньше 44 × 44 (кроме ссылок внутри текста).
	const small = [ ...document.querySelectorAll( 'a, button, [role="button"], input, select' ) ]
		.filter( ( e ) => shown( e ) && ! e.closest( 'p' ) )
		.filter( ( e ) => {
			const r = e.getBoundingClientRect();
			return r.width < 44 || r.height < 44;
		} )
		.slice( 0, 10 )
		.map( ( e ) => `${ label( e ) } ${ Math.round( e.getBoundingClientRect().width ) }×${ Math.round( e.getBoundingClientRect().height ) }` );
	// Мелкий текст на мобильном.
	const tiny = innerWidth < 768
		? [ ...seen ].filter( ( e ) => parseFloat( getComputedStyle( e ).fontSize ) < 14 ).slice( 0, 10 ).map( label )
		: [];
	return { width: innerWidth, outOfBox: out, small, tiny };
}
```

3. Налезание соседних блоков — глазами по скриншоту на нижней границе каждого диапазона (375, 768, 1024, 1440) и на 2560; подозрение — замер `getBoundingClientRect` пары элементов.

## Прокрутка

Ловит: страница «застревает», подвал недостижим, внутренний контейнер обрезан, прокрутка заблокирована после меню или модалки, липкий слой закрывает экран.

1. **Состояние прокрутки** — `browser_evaluate` на открытой странице, затем после открытия и закрытия мобильного меню (375) и каждой модалки / поиска / корзины-шторки:

```js
() => {
	const label = ( e ) => `${ e.tagName.toLowerCase() }${ typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split( /\s+/ )[ 0 ] : '' }`;
	const de = document.documentElement;
	const locked = [ de, document.body ].filter( ( e ) => /hidden|clip/.test( getComputedStyle( e ).overflowY ) || getComputedStyle( e ).position === 'fixed' ).map( label );
	// Внутренние контейнеры с прокруткой: доходит ли прокрутка до последнего ребёнка.
	const inner = [ ...document.querySelectorAll( 'body *' ) ]
		.filter( ( e ) => /auto|scroll/.test( getComputedStyle( e ).overflowY ) && e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 )
		.slice( 0, 10 )
		.map( ( e ) => {
			const keep = e.scrollTop;
			e.scrollTop = e.scrollHeight;
			const last = e.lastElementChild?.getBoundingClientRect();
			const cut = last ? Math.round( last.bottom - e.getBoundingClientRect().bottom - parseFloat( getComputedStyle( e ).paddingBottom ) ) : 0;
			e.scrollTop = keep;
			return `${ label( e ) } ${ e.clientHeight }/${ e.scrollHeight }${ cut > 1 ? ` — обрезан на ${ cut }px` : '' }`;
		} );
	// Липкие и фиксированные слои выше 40 % экрана.
	const covers = [ ...document.querySelectorAll( 'body *' ) ]
		.filter( ( e ) => /fixed|sticky/.test( getComputedStyle( e ).position ) && getComputedStyle( e ).visibility !== 'hidden' )
		.filter( ( e ) => e.getBoundingClientRect().height > innerHeight * 0.4 && e.getBoundingClientRect().width > innerWidth * 0.5 )
		.map( label );
	return { locked, max: de.scrollHeight - innerHeight, inner, covers };
}
```

   `locked` не пуст при закрытых меню и модалках — **major** (страница не прокручивается). `covers` при закрытых слоях — **major**.

2. **Колесо мыши** — только десктоп (1440 × 900 и 1440 × 700), ключевые страницы матрицы; Playwright MCP колеса не имеет — `browser.mjs` (`b-browsers.md`, Chromium по умолчанию).
   Для каждой точки по ширине — 25 %, 50 %, 75 % (360, 720, 1080 px), по высоте — середина окна:

```
node .claude/skills/project-ops/scripts/browser.mjs mousemove 360 450
node .claude/skills/project-ops/scripts/browser.mjs mousewheel 0 2000
node .claude/skills/project-ops/scripts/browser.mjs eval "() => ({ y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight, footer: (() => { const f = document.querySelector('footer'); return f ? f.getBoundingClientRect().top < innerHeight : null; })() })"
```

   Повторять `mousewheel` + `eval`, пока `y` растёт: дошло до `max` и `footer: true` — точка в порядке; `y` не растёт раньше `max` — «застревает» (что под курсором: карта, `iframe`, слайдер, библиотека плавной прокрутки).
   Затем `mousewheel 0 -2000` до `y: 0` — прокрутка вверх. Перед следующей точкой — `goto` той же страницы.
   Высота 700 — то же, только середина (`mousemove 720 350`). Липкая шапка закрывает заголовки секций при прокрутке — скриншот на середине страницы.

## Ещё

- **Зум 200%** — на 1440: `document.documentElement.style.zoom = 2` (Chromium) — контент читается, нет горизонтальной прокрутки у текста, меню доступно.
- **Ориентация** — 812 × 375 (телефон лёжа): шапка и первый экран не съедают весь экран, модалки и меню закрываются.
- **Меню и модалки** на мобильном: открываются, прокручиваются, закрываются, фон не прокручивается под открытыми и прокручивается после закрытия (п. «Прокрутка», 1).
- **Картинки**: не растянуты (`object-fit` / пропорции), не мылятся (`layout-check` → большие экраны), арт-дирекция (`<picture>`) отдаёт свой кадр.

## Серьёзность

Переполнение и горизонтальная прокрутка, налезание, текст вне блока, недоступное меню, блокировка или «застревание» прокрутки, недостижимый подвал — **major**.
Кнопка меньше 44 px, текст меньше 14 px на мобильном — **minor**.
