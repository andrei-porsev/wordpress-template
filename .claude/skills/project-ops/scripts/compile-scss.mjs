/**
 * Компиляция entry из Live Sass settings — тот же путь, что у человека в редакторе.
 * --check: собрать во временную папку и сверить с CSS на диске, ничего не записывая (SCSS пришёл с сервера — собран ли CSS из него).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

const check = process.argv.includes( '--check' );

// CSS без строки source map и CRLF; flat — ещё и без пробелов (разница только в форматировании).
const clean = ( css ) => css.replace( /\r\n/g, '\n' ).replace( /\/\*# sourceMappingURL=.*?\*\/\s*$/s, '' ).trimEnd();
const flat = ( css ) => clean( css ).replace( /\s+/g, '' );

// Строк, которых нет в другом CSS (с повторами).
function lineDistance( a, b ) {
	const count = new Map();
	for ( const l of a.split( '\n' ) ) {
		count.set( l, ( count.get( l ) || 0 ) + 1 );
	}
	let d = 0;
	for ( const l of b.split( '\n' ) ) {
		const c = count.get( l ) || 0;
		if ( c ) {
			count.set( l, c - 1 );
		} else {
			d++;
		}
	}
	for ( const c of count.values() ) {
		d += c;
	}
	return d;
}

function repoRoot() {
	const cwd = process.cwd();
	if ( existsSync( join( cwd, '.vscode', 'settings.json' ) ) ) {
		return cwd;
	}
	throw new Error( 'Запускай из корня репозитория (нет .vscode/settings.json).' );
}

function outPath( scssFile, savePath, ext ) {
	const dir = dirname( scssFile );
	const name = basename( scssFile, extname( scssFile ) ) + ext;
	if ( ! savePath || savePath === '/' ) {
		return join( dir, name );
	}
	const rel = savePath.startsWith( '~/' ) ? savePath.slice( 2 ) : savePath;
	return resolve( dir, rel, name );
}

// Entry по пути из includeItems; `*` — только в имени файла, партиалы (`_*.scss`) пропускаются, как в Live Sass.
function expandItem( root, item ) {
	const input = resolve( root, String( item ).replace( /^\//, '' ) );
	const name = basename( input );
	if ( ! name.includes( '*' ) ) {
		if ( ! existsSync( input ) ) {
			throw new Error( `Нет entry: ${ item }` );
		}
		return [ input ];
	}
	const dir = dirname( input );
	if ( ! existsSync( dir ) ) {
		throw new Error( `Нет папки entry: ${ item }` );
	}
	const pattern = new RegExp( '^' + name.replace( /[.+?^${}()|[\]\\]/g, '\\$&' ).replace( /\*/g, '.*' ) + '$' );
	return readdirSync( dir )
		.filter( ( f ) => pattern.test( f ) && ! f.startsWith( '_' ) )
		.map( ( f ) => join( dir, f ) );
}

try {
	const root = repoRoot();
	const settings = parseJsonc(
		readFileSync( join( root, '.vscode', 'settings.json' ), 'utf8' )
	);
	const items = settings[ 'liveSassCompile.settings.includeItems' ] || [];
	const formats = settings[ 'liveSassCompile.settings.formats' ] || [
		{ format: 'expanded', extensionName: '.css', savePath: '~/../css' },
	];
	const generateMap = settings[ 'liveSassCompile.settings.generateMap' ] !== false;

	if ( ! items.length ) {
		throw new Error( 'includeItems пуст — entry SCSS в project-base/project.json → scss, затем gen-whitelist.mjs.' );
	}

	const inputs = items.flatMap( ( item ) => expandItem( root, item ) );
	if ( ! inputs.length ) {
		throw new Error( 'По includeItems не найдено ни одного entry.' );
	}

	if ( check ) {
		const tmp = mkdtempSync( join( tmpdir(), 'compile-scss-' ) );
		const stale = [];
		try {
			for ( const input of inputs ) {
				for ( const fmt of formats ) {
					const output = outPath( input, fmt.savePath, fmt.extensionName || '.css' );
					const rel = relative( root, output ).replace( /\\/g, '/' );
					const probe = join( tmp, basename( output ) );
					const style = fmt.format === 'compressed' ? 'compressed' : 'expanded';
					execSync( `npx --yes sass --style=${ style } --no-source-map "${ input }" "${ probe }"`, { cwd: root, stdio: [ 'ignore', 'ignore', 'inherit' ], shell: true } );
					const fresh = readFileSync( probe, 'utf8' );
					if ( ! existsSync( output ) ) {
						stale.push( `${ rel } — CSS нет` );
						continue;
					}
					const cur = readFileSync( output, 'utf8' );
					if ( clean( cur ) === clean( fresh ) ) {
						console.log( `OK ${ rel }` );
					} else if ( flat( cur ) === flat( fresh ) ) {
						console.log( `OK ${ rel } (разница только в форматировании)` );
					} else {
						stale.push( `${ rel } — не собран из текущего SCSS, разница ~${ lineDistance( clean( cur ), clean( fresh ) ) } строк` );
					}
				}
			}
		} finally {
			rmSync( tmp, { recursive: true, force: true } );
		}
		if ( stale.length ) {
			console.log( 'CSS УСТАРЕЛ:' );
			stale.forEach( ( l ) => console.log( `  ${ l }` ) );
			process.exit( 1 );
		}
		console.log( 'OK check: CSS собран из текущего SCSS' );
		process.exit( 0 );
	}

	const written = [];
	for ( const input of inputs ) {
		for ( const fmt of formats ) {
			const ext = fmt.extensionName || '.css';
			const output = outPath( input, fmt.savePath, ext );
			mkdirSync( dirname( output ), { recursive: true } );
			const style = fmt.format === 'compressed' ? 'compressed' : 'expanded';
			const map = generateMap ? '--source-map' : '--no-source-map';
			execSync( `npx --yes sass --style=${ style } ${ map } "${ input }" "${ output }"`, {
				cwd: root,
				stdio: 'inherit',
				shell: true,
			} );
			written.push( output );
			if ( generateMap ) {
				written.push( `${ output }.map` );
			}
		}
	}
	console.log( 'OK' );
	for ( const f of written ) {
		console.log( f );
	}
} catch ( err ) {
	console.error( err instanceof Error ? err.message : String( err ) );
	process.exit( 1 );
}
