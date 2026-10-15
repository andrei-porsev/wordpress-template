/**
 * Компиляция entry из Live Sass settings — тот же путь, что у человека в редакторе.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

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
		throw new Error( 'includeItems пуст — пропиши entry SCSS в .vscode/settings.json.' );
	}

	const inputs = items.flatMap( ( item ) => expandItem( root, item ) );
	if ( ! inputs.length ) {
		throw new Error( 'По includeItems не найдено ни одного entry.' );
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
