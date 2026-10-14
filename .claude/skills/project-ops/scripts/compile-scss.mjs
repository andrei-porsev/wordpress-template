/**
 * Компиляция entry из Live Sass settings — тот же путь, что у человека в редакторе.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

	const written = [];
	for ( const item of items ) {
		const input = resolve( root, String( item ).replace( /^\//, '' ) );
		if ( ! existsSync( input ) ) {
			throw new Error( `Нет entry: ${ item }` );
		}
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
