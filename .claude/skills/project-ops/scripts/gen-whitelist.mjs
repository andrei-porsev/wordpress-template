/**
 * Из project-base/project.json: whitelist слагов → .gitignore и .vscode/sftp.json; entry SCSS → .vscode/settings.json.
 * Запуск из корня: node .claude/skills/project-ops/scripts/gen-whitelist.mjs
 * blocks: "plugin-slug/block-slug" (блок внутри своего плагина).
 * scss: пути entry как в Live Sass ("/wp-content/themes/<slug>/assets/scss/*.scss"); пусто — includeItems не трогается.
 * markup: true — вёрстка макета в markup/ (git и sftp-stage.json; в sftp.json прода её нет, deploy на прод не выкатывает).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const projectPath = join( root, 'project-base', 'project.json' );
if ( ! existsSync( projectPath ) ) {
	console.error( 'Нет project-base/project.json. Запускай из корня репозитория.' );
	process.exit( 1 );
}

const project = JSON.parse( readFileSync( projectPath, 'utf8' ) );
const list = ( key ) => ( Array.isArray( project[ key ] ) ? project[ key ].filter( Boolean ) : [] );
const themes = list( 'themes' );
const plugins = list( 'plugins' );
const muPlugins = list( 'muPlugins' );
const blocks = list( 'blocks' );
const scss = list( 'scss' );
const markup = project.markup === true;

const slugRe = /^[A-Za-z0-9._-]+$/;
for ( const s of [ ...themes, ...plugins, ...muPlugins ] ) {
	if ( ! slugRe.test( s ) ) {
		console.error( `Недопустимый слаг: ${ s }` );
		process.exit( 1 );
	}
}
for ( const b of blocks ) {
	if ( ! /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test( b ) ) {
		console.error( `Блок должен быть "plugin-slug/block-slug": ${ b }` );
		process.exit( 1 );
	}
}
const own = { themes, plugins, 'mu-plugins': muPlugins };
for ( const s of scss ) {
	if ( markup && /^\/markup\/[^"\\]+\.scss$/.test( s ) ) {
		continue;
	}
	const m = s.match( /^\/wp-content\/(themes|plugins|mu-plugins)\/([^/]+)\/[^"\\]+\.scss$/ );
	if ( ! m || ! own[ m[ 1 ] ].includes( m[ 2 ] ) ) {
		console.error( `scss: entry должен лежать в своей теме или плагине из project.json ("/wp-content/themes/<slug>/…/<файл>.scss") или в /markup/ при "markup": true: ${ s }` );
		process.exit( 1 );
	}
}

const MARK_START = '# >>> project.json (генерируется, не править вручную)';
const MARK_END = '# <<< project.json';

// Блок разрешений одного типа: /wp-content/<kind>/* закрыт, свои слаги открыты.
function gitBlock( kind, slugs ) {
	const out = [ `!/wp-content/${ kind }/`, `/wp-content/${ kind }/*` ];
	for ( const s of slugs ) {
		out.push( `!/wp-content/${ kind }/${ s }/`, `!/wp-content/${ kind }/${ s }/**` );
	}
	return out;
}

const gitLines = [
	MARK_START,
	'!/wp-content/',
	'/wp-content/*',
	...gitBlock( 'themes', themes ),
	...gitBlock( 'plugins', plugins ),
	...gitBlock( 'mu-plugins', muPlugins ),
	...( markup ? [ '!/markup/', '!/markup/**' ] : [] ),
	MARK_END,
];

function patchGitignore() {
	const path = join( root, '.gitignore' );
	const src = readFileSync( path, 'utf8' );
	const start = src.indexOf( MARK_START );
	const end = src.indexOf( MARK_END );
	if ( start < 0 || end < start ) {
		console.error( '.gitignore: нет маркеров project.json.' );
		process.exit( 1 );
	}
	const eol = src.includes( '\r\n' ) ? '\r\n' : '\n';
	const next = src.slice( 0, start ) + gitLines.join( eol ) + src.slice( end + MARK_END.length );
	writeFileSync( path, next );
	console.log( 'OK .gitignore' );
}

// Список ignore для sftp: всё закрыто, свои пакеты открыты; withMarkup — ещё markup/ (только для stage).
function ignoreList( withMarkup ) {
	const ignore = [
		'/*',
		...( withMarkup ? [ '!/markup', '!/markup/**' ] : [] ),
		'!/wp-content',
		'/wp-content/*',
		'!/wp-content/themes',
		'!/wp-content/plugins',
		'!/wp-content/mu-plugins',
	];
	const kinds = [ [ 'themes', themes ], [ 'plugins', plugins ], [ 'mu-plugins', muPlugins ] ];
	for ( const [ kind, slugs ] of kinds ) {
		ignore.push( `/wp-content/${ kind }/*` );
		for ( const s of slugs ) {
			ignore.push( `!/wp-content/${ kind }/${ s }`, `!/wp-content/${ kind }/${ s }/**` );
		}
	}
	ignore.push(
		'**/.DS_Store',
		'**/Thumbs.db',
		'**/desktop.ini',
		'**/*.log',
		'**/*.tmp',
		'**/*.temp',
		'**/*.bak',
		'**/node_modules/',
		'**/vendor/',
		'**/*.md'
	);
	return ignore;
}

function patchSftp() {
	const path = join( root, '.vscode', 'sftp.json' );
	if ( ! existsSync( path ) ) {
		console.warn( 'Нет .vscode/sftp.json — пропуск.' );
		return;
	}
	const cfg = JSON.parse( readFileSync( path, 'utf8' ) );
	cfg.ignore = ignoreList( false );

	// Watcher: собранный CSS темы и плагинов, style.css блоков.
	const parts = [
		...themes.map( ( t ) => `themes/${ t }/assets/css/**` ),
		...plugins.map( ( p ) => `plugins/${ p }/assets/css/**` ),
		...blocks.flatMap( ( b ) => {
			const [ p, bl ] = b.split( '/' );
			return [ `plugins/${ p }/blocks/${ bl }/style.css`, `plugins/${ p }/blocks/${ bl }/style.css.map` ];
		} ),
	];
	if ( parts.length ) {
		cfg.watcher = { ...( cfg.watcher || {} ), files: `wp-content/{${ parts.join( ',' ) }}` };
	}
	writeFileSync( path, JSON.stringify( cfg, null, '\t' ) + '\n' );
	console.log( 'OK .vscode/sftp.json' );
}

// Stage: тот же список плюс markup/ — вёрстку клиент смотрит только на stage.
function patchSftpStage() {
	const path = join( root, '.vscode', 'sftp-stage.json' );
	if ( ! existsSync( path ) ) {
		return;
	}
	const cfg = JSON.parse( readFileSync( path, 'utf8' ) );
	cfg.ignore = ignoreList( markup );
	writeFileSync( path, JSON.stringify( cfg, null, '\t' ) + '\n' );
	console.log( `OK .vscode/sftp-stage.json${ markup ? ' (с markup/)' : '' }` );
}

// includeItems Live Sass — правка текста: в settings.json комментарии (JSONC), пересборка их бы стёрла.
function patchVscode() {
	if ( ! scss.length ) {
		return;
	}
	const path = join( root, '.vscode', 'settings.json' );
	if ( ! existsSync( path ) ) {
		console.warn( 'Нет .vscode/settings.json — пропуск.' );
		return;
	}
	const src = readFileSync( path, 'utf8' );
	const re = /^([ \t]*)("liveSassCompile\.settings\.includeItems"\s*:\s*)\[[^\]]*\]/m;
	if ( ! re.test( src ) ) {
		console.error( '.vscode/settings.json: нет liveSassCompile.settings.includeItems.' );
		process.exit( 1 );
	}
	const eol = src.includes( '\r\n' ) ? '\r\n' : '\n';
	const next = src.replace( re, ( _, ind, key ) => `${ ind }${ key }[${ eol }${ scss.map( ( s ) => `${ ind }\t${ JSON.stringify( s ) }` ).join( ',' + eol ) }${ eol }${ ind }]` );
	writeFileSync( path, next );
	console.log( 'OK .vscode/settings.json (includeItems)' );
}

patchGitignore();
patchSftp();
patchSftpStage();
patchVscode();

if ( ! themes.length && ! plugins.length && ! muPlugins.length ) {
	console.warn( 'Внимание: слаги пусты — whitelist закрывает всю wp-content.' );
}
