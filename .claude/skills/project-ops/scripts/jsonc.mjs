/** JSONC: вырезать комментарии, не трогая содержимое строк. */
export function parseJsonc( text ) {
	let out = '';
	let i = 0;
	let inStr = false;
	while ( i < text.length ) {
		const c = text[ i ];
		const n = text[ i + 1 ];
		if ( inStr ) {
			out += c;
			if ( c === '\\' ) {
				out += n ?? '';
				i += 2;
				continue;
			}
			if ( c === '"' ) {
				inStr = false;
			}
			i++;
			continue;
		}
		if ( c === '"' ) {
			inStr = true;
			out += c;
			i++;
			continue;
		}
		if ( c === '/' && n === '/' ) {
			while ( i < text.length && text[ i ] !== '\n' ) {
				i++;
			}
			continue;
		}
		if ( c === '/' && n === '*' ) {
			i += 2;
			while ( i < text.length && ! ( text[ i ] === '*' && text[ i + 1 ] === '/' ) ) {
				i++;
			}
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return JSON.parse( out );
}
