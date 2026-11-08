# D — Контент против макета

## Тексты

1. **Из макета:** Figma — тексты кадра (`get_metadata` / `get_design_context`: текстовые слои по порядку); картинка / PDF — прочитать текст с изображения (в отчёте пометка «прочитано с картинки»).
2. **Со страницы** — видимые тексты основной области по порядку:

```js
() => {
	const root = document.querySelector( 'main' ) || document.body;
	const out = [];
	const walk = document.createTreeWalker( root, NodeFilter.SHOW_TEXT );
	while ( walk.nextNode() ) {
		const t = walk.currentNode.textContent.replace( /\s+/g, ' ' ).trim();
		const el = walk.currentNode.parentElement;
		const r = el.getBoundingClientRect();
		if ( t && r.width > 0 && getComputedStyle( el ).visibility !== 'hidden' ) {
			out.push( t );
		}
	}
	return out;
}
```

3. Сравнить построчно (нормализовать пробелы, кавычки «» / "", тире — / -, неразрывные пробелы): нет на сайте, лишнее на сайте, отличается. Шапка и подвал — один раз на прогон, не на каждой странице.
4. Регистр и `text-transform`: в макете заглавными, на сайте строчными с `uppercase` — не баг.

Контент на сайте новее макета (клиент уже вписал свои тексты) — не баг, если пользователь так сказал: записать в `QA.md` → «Принятые отступления» («тексты — с сайта, макет — только вид»).

## Заглушки и мусор — всегда, даже без макета

```js
() => {
	const html = document.body.innerText;
	const marks = [ /lorem ipsum/i, /dolor sit amet/i, /placeholder/i, /\bTODO\b/, /\bTBD\b/, /\[(?:text|текст|title|заголовок)\]/i, /xxx/i, /example\.com/i, /\+?1?\s*\(?555\)?/, /test@/i ];
	const found = marks.filter( ( m ) => m.test( html ) ).map( String );
	const imgs = [ ...document.images ].filter( ( i ) => /placeholder|dummy|via\.placeholder|picsum|unsplash\.it|default/i.test( i.currentSrc ) || ( i.complete && i.naturalWidth === 0 ) ).map( ( i ) => i.currentSrc || i.src );
	const links = [ ...document.querySelectorAll( 'a' ) ].filter( ( a ) => [ '#', '', 'javascript:void(0)' ].includes( a.getAttribute( 'href' ) ?? '' ) && ! a.getAttribute( 'role' ) ).length;
	return { found, imgs: imgs.slice( 0, 10 ), emptyLinks: links };
}
```

## Опечатки и язык

Прочитать тексты страницы (п. 2) глазами агента: опечатки, двойные пробелы, «висящие» предлоги не критичны (если в `QA.md` нет решения), смешение раскладок (латинская «с» / «о» в русском слове),
разные написания одного (телефон, название компании, «e-mail» / «email»). Тон и стиль — не QA (это `copy-editing`), только явные ошибки.
Решения по типу записи (длина анонса, формат дат, обязательные поля) — `content-types/<тип>.md`: страница типа сверяется с ним.

## Серьёзность

Lorem ipsum, заглушка-картинка, чужой телефон, неверная цена / контакты — **blocker** на `launch`, **major** на `handover`. Пропущенный или неверный блок текста — **major**. Опечатка — **minor**. Кавычки, тире, пробелы — **cosmetic**.
