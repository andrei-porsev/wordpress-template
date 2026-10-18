/**
 * Локальная копия сайта (LocalWP, OSPanel): WP-CLI со своей защитой, проверка, junction своего кода.
 *   local-exec.mjs detect <путь к корню WP> [--tool localwp|ospanel] [--yes]   — найти PHP, порт БД, URL, wp-cli → .vscode/local.json
 *   local-exec.mjs status                                                       — PHP, база, сайт; что сделать человеку
 *   local-exec.mjs link [--yes]                                                 — junction своих тем / плагинов в сайт (проект отдельно от сайта)
 *   local-exec.mjs -- wp <команда> [--yes]                                      — WP-CLI локального сайта
 * Защита: чтение — сразу; разрушающее (db drop / reset, site empty / delete) — запрещено; меняющее — только с --yes (после «да» пользователя)
 * и с дампом БД в .claude/.state/backups/db/local-<время>.sql перед изменением. Не WP-CLI — не выполняется.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';

const READ_VERBS = new Set( [ 'list', 'get', 'status', 'version', 'is-active', 'is-installed', 'exists', 'check', 'info', 'search', 'path', 'count',
	'verify-checksums', 'check-update', 'structure', 'tables', 'size', 'export', 'pluck', 'type' ] );
const DENY = [ [ 'db', 'drop' ], [ 'db', 'reset' ], [ 'db', 'clean' ], [ 'site', 'empty' ], [ 'site', 'delete' ] ];

const root = process.cwd();
const cfgPath = join( root, '.vscode', 'local.json' );
const argv = process.argv.slice( 2 );
const yes = argv.includes( '--yes' );
const args = argv.filter( ( a ) => a !== '--yes' );

const readJson = ( p ) => JSON.parse( readFileSync( p, 'utf8' ) );
const opt = ( name ) => ( args.includes( name ) ? args[ args.indexOf( name ) + 1 ] : '' );

function portOpen( port ) {
	return new Promise( ( res ) => {
		const s = createConnection( { host: '127.0.0.1', port } );
		s.setTimeout( 2000 );
		s.on( 'connect', () => {
			s.destroy();
			res( true );
		} );
		s.on( 'error', () => res( false ) );
		s.on( 'timeout', () => {
			s.destroy();
			res( false );
		} );
	} );
}

// LocalWP: <сайт>/app/public → <сайт>/local-site.json; PHP — %APPDATA%/Local/lightning-services/php-<версия>+N.
function detectLocalWp( sitePath ) {
	const meta = join( sitePath, '..', '..', 'local-site.json' );
	if ( ! existsSync( meta ) ) {
		return null;
	}
	const j = readJson( meta );
	const phpVer = j.services?.php?.version;
	const db = j.services?.mariadb || j.services?.mysql;
	const services = join( process.env.APPDATA || '', 'Local', 'lightning-services' );
	const phpDir = existsSync( services ) ? readdirSync( services ).filter( ( d ) => d.startsWith( `php-${ phpVer }` ) ).sort().pop() : '';
	const php = phpDir ? join( services, phpDir, 'bin', 'win64', 'php.exe' ) : '';
	// mysql / mysqldump из той же MariaDB — без них wp db export и search-replace не работают.
	const dbName = j.services?.mariadb ? 'mariadb' : 'mysql';
	const dbDir = existsSync( services ) ? readdirSync( services ).filter( ( d ) => d.startsWith( `${ dbName }-${ db?.version }` ) ).sort().pop() : '';
	const dbBin = dbDir ? [ 'win64', 'win32' ].map( ( a ) => join( services, dbDir, 'bin', a, 'bin' ) ).find( ( p ) => existsSync( join( p, 'mysqldump.exe' ) ) ) || '' : '';
	const bundled = [ 'C:\\Program Files (x86)\\Local\\resources\\extraResources\\bin\\wp-cli\\wp-cli.phar', 'C:\\Program Files\\Local\\resources\\extraResources\\bin\\wp-cli\\wp-cli.phar' ].find( existsSync );
	return {
		tool: 'localwp', sitePath, url: j.domain ? `http://${ j.domain }` : '', php,
		wpCli: existsSync( join( sitePath, 'wp-cli.phar' ) ) ? join( sitePath, 'wp-cli.phar' ) : bundled || '',
		dbPort: db?.ports?.MYSQL?.[ 0 ] || 3306, dbBin, siteName: j.name,
	};
}

// OSPanel: PHP — <диск>:/OSPanel/modules/php/PHP_*/php.exe (OSPanel 5) или modules/PHP-* (OSPanel 6); БД — 3306.
function detectOsPanel( sitePath ) {
	const drive = resolve( sitePath ).slice( 0, 2 );
	const bases = [ `${ drive }\\OSPanel\\modules\\php`, `${ drive }\\OSPanel\\modules` ];
	let php = '';
	for ( const b of bases.filter( existsSync ) ) {
		const d = readdirSync( b ).filter( ( x ) => /^php/i.test( x ) && existsSync( join( b, x, 'php.exe' ) ) ).sort().pop();
		if ( d ) {
			php = join( b, d, 'php.exe' );
			break;
		}
	}
	return { tool: 'ospanel', sitePath, url: '', php, wpCli: existsSync( join( sitePath, 'wp-cli.phar' ) ) ? join( sitePath, 'wp-cli.phar' ) : '', dbPort: 3306 };
}

function loadCfg() {
	if ( ! existsSync( cfgPath ) ) {
		throw new Error( 'Нет .vscode/local.json — сначала: local-exec.mjs detect <путь к корню WordPress локального сайта>' );
	}
	return readJson( cfgPath );
}

// php с расширениями для WP-CLI: голый php.exe LocalWP без php.ini не грузит mysqli; порт БД — нестандартный.
function phpArgs( cfg ) {
	const ext = join( dirname( cfg.php ), 'ext' );
	const a = [ '-d', 'memory_limit=512M', '-d', `mysqli.default_port=${ cfg.dbPort }` ];
	if ( cfg.tool === 'localwp' ) {
		a.unshift( '-n', '-d', `extension_dir=${ ext }`, ...[ 'mysqli', 'mbstring', 'openssl', 'curl', 'fileinfo', 'gd', 'intl', 'zip', 'exif' ]
			.filter( ( e ) => existsSync( join( ext, `php_${ e }.dll` ) ) ).flatMap( ( e ) => [ '-d', `extension=${ e }` ] ) );
	}
	return a;
}

function wp( cfg, wpArgs ) {
	// mysql / mysqldump — из клиента БД сайта (PATH), порт — нестандартный.
	const env = { ...process.env };
	if ( cfg.dbBin ) {
		env.PATH = `${ cfg.dbBin };${ env.PATH || env.Path || '' }`;
		env.Path = env.PATH;
	}
	const extra = wpArgs[ 0 ] === 'db' && [ 'export', 'import', 'query', 'cli', 'size' ].includes( wpArgs[ 1 ] ) ? [ `--port=${ cfg.dbPort }`, '--protocol=TCP' ] : [];
	return spawnSync( cfg.php, [ ...phpArgs( cfg ), cfg.wpCli, `--path=${ cfg.sitePath }`, ...wpArgs, ...extra ], { encoding: 'utf8', timeout: 300000, env } );
}

function classify( wpArgs ) {
	const words = wpArgs.filter( ( w ) => ! w.startsWith( '-' ) );
	const [ group, verb ] = words;
	if ( DENY.some( ( [ g, v ] ) => g === group && v === verb ) ) {
		return 'deny';
	}
	if ( [ 'eval', 'eval-file', 'shell' ].includes( group ) ) {
		return 'change';
	}
	if ( group === 'db' && verb === 'query' ) {
		return /^\s*(select|show|describe|explain)\b/i.test( words.slice( 2 ).join( ' ' ) ) ? 'read' : 'change';
	}
	if ( group === 'search-replace' ) {
		return wpArgs.includes( '--dry-run' ) ? 'read' : 'change';
	}
	if ( [ 'help', 'cli' ].includes( group ) || ! group ) {
		return 'read';
	}
	return READ_VERBS.has( verb ) || READ_VERBS.has( group ) ? 'read' : 'change';
}

async function cmdDetect() {
	const sitePath = resolve( args[ 1 ] || '' );
	if ( ! args[ 1 ] || ! existsSync( join( sitePath, 'wp-config.php' ) ) ) {
		throw new Error( 'Нужен путь к корню WordPress локального сайта (папка с wp-config.php), например D:\\WPLocalSites\\site\\app\\public' );
	}
	const tool = opt( '--tool' );
	const cfg = tool === 'ospanel' ? detectOsPanel( sitePath ) : detectLocalWp( sitePath ) || detectOsPanel( sitePath );
	const sameRoot = resolve( sitePath ).toLowerCase() === resolve( root ).toLowerCase();
	console.log( `Локальный сайт: ${ cfg.tool === 'localwp' ? `LocalWP «${ cfg.siteName }»` : 'OSPanel' } · ${ sitePath }` );
	console.log( `  PHP: ${ cfg.php || 'НЕ найден' } · БД: порт ${ cfg.dbPort } · URL: ${ cfg.url || '— (указать в ACCESS.md → «Локально»)' }` );
	console.log( `  WP-CLI: ${ cfg.wpCli || 'НЕ найден' } · клиент БД: ${ cfg.dbBin || 'не найден (wp db export не сработает)' }` );
	console.log( `  Раскладка: ${ sameRoot ? 'проект внутри папки сайта — junction не нужен' : 'проект отдельно от сайта — свой код подключить junction (local-exec.mjs link)' }` );
	const manual = [];
	cfg.php || manual.push( 'PHP сайта не найден — указать путь к php.exe в .vscode/local.json → php' );
	cfg.wpCli || manual.push( `wp-cli.phar нет — скачать с https://wp-cli.org (официальный wp-cli.phar) в ${ sitePath } (человек)` );
	manual.forEach( ( m ) => console.log( `  СДЕЛАТЬ ВРУЧНУЮ: ${ m }` ) );
	if ( ! yes ) {
		console.log( 'ПЛАН: после «да» — тот же запуск с --yes (запишет .vscode/local.json, без секретов).' );
		return;
	}
	mkdirSync( dirname( cfgPath ), { recursive: true } );
	writeFileSync( cfgPath, JSON.stringify( cfg, null, '\t' ) + '\n' );
	console.log( 'OK: .vscode/local.json. Дальше: ACCESS.md → «Локально», local-exec.mjs status.' );
}

async function cmdStatus() {
	const cfg = loadCfg();
	const manual = [];
	const php = cfg.php && existsSync( cfg.php ) ? spawnSync( cfg.php, [ ...phpArgs( cfg ), '-v' ], { encoding: 'utf8' } ) : null;
	console.log( `PHP: ${ php?.status === 0 ? php.stdout.split( '\n' )[ 0 ] : 'не запускается' }` );
	php?.status === 0 || manual.push( 'PHP не запускается — проверить путь в .vscode/local.json' );
	const db = await portOpen( cfg.dbPort );
	console.log( `База (порт ${ cfg.dbPort }): ${ db ? 'запущена' : 'не отвечает' }` );
	db || manual.push( cfg.tool === 'localwp' ? `запустить сайт в LocalWP (кнопка Start site у «${ cfg.siteName || 'сайта' }»)` : 'запустить OSPanel (MySQL / MariaDB)' );
	if ( db && cfg.wpCli ) {
		const r = wp( cfg, [ 'option', 'get', 'siteurl' ] );
		console.log( `WP-CLI: ${ r.status === 0 ? `работает, siteurl ${ r.stdout.trim() }` : `ошибка — ${ ( r.stdout + r.stderr ).trim().split( '\n' ).pop() }` }` );
	}
	if ( cfg.url ) {
		const res = await fetch( cfg.url, { redirect: 'manual' } ).catch( () => null );
		console.log( `Сайт ${ cfg.url }: ${ res ? `HTTP ${ res.status }` : 'не отвечает' }` );
	}
	manual.forEach( ( m ) => console.log( `СДЕЛАТЬ ВРУЧНУЮ: ${ m }` ) );
	process.exitCode = manual.length ? 2 : 0;
}

function cmdLink() {
	const cfg = loadCfg();
	if ( resolve( cfg.sitePath ).toLowerCase() === resolve( root ).toLowerCase() ) {
		console.log( 'Проект лежит в папке сайта — свой код сайт видит напрямую, junction не нужен.' );
		return;
	}
	const project = readJson( join( root, 'project-base', 'project.json' ) );
	const pairs = [
		...( project.themes || [] ).map( ( s ) => `wp-content/themes/${ s }` ),
		...( project.plugins || [] ).map( ( s ) => `wp-content/plugins/${ s }` ),
		...( project.muPlugins || [] ).map( ( s ) => `wp-content/mu-plugins/${ s }` ),
	];
	const plan = [];
	for ( const rel of pairs ) {
		const target = join( root, rel );
		const link = join( cfg.sitePath, rel );
		if ( ! existsSync( target ) ) {
			plan.push( [ rel, 'пропуск — в проекте нет папки' ] );
		} else if ( existsSync( link ) && lstatSync( link ).isSymbolicLink() ) {
			plan.push( [ rel, 'уже связано' ] );
		} else if ( existsSync( link ) ) {
			plan.push( [ rel, 'СТОП — в сайте настоящая папка; не трогаю (переименовать или удалить её — человек, после сверки)' ] );
		} else {
			plan.push( [ rel, 'создать junction', target, link ] );
		}
	}
	plan.forEach( ( [ rel, what ] ) => console.log( `  ${ rel }: ${ what }` ) );
	if ( ! yes ) {
		console.log( 'ПЛАН: после «да» — с --yes.' );
		return;
	}
	for ( const [ , what, target, link ] of plan ) {
		if ( what === 'создать junction' ) {
			mkdirSync( dirname( link ), { recursive: true } );
			symlinkSync( target, link, 'junction' );
		}
	}
	console.log( 'OK: junction созданы — правки в проекте сразу видны локальному сайту.' );
}

async function cmdWp() {
	const cfg = loadCfg();
	const dash = argv.indexOf( '--' );
	const rest = argv.slice( dash + 1 ).filter( ( a ) => a !== '--yes' );
	if ( rest[ 0 ] !== 'wp' ) {
		throw new Error( 'Только WP-CLI: local-exec.mjs -- wp <команда>. Другие команды на локальном сайте этим скриптом не выполняются.' );
	}
	const wpArgs = rest.slice( 1 );
	const kind = classify( wpArgs );
	if ( kind === 'deny' ) {
		throw new Error( `Запрещено: wp ${ wpArgs.join( ' ' ) } уничтожает данные.` );
	}
	if ( ! await portOpen( cfg.dbPort ) && ! [ 'core', 'cli', 'help' ].includes( wpArgs[ 0 ] ) ) {
		throw new Error( `База на порту ${ cfg.dbPort } не отвечает — СДЕЛАТЬ ВРУЧНУЮ: ${ cfg.tool === 'localwp' ? 'запустить сайт в LocalWP (Start site)' : 'запустить OSPanel' }.` );
	}
	if ( kind === 'change' ) {
		if ( ! yes ) {
			throw new Error( `wp ${ wpArgs.join( ' ' ) } меняет локальный сайт: спросить пользователя, после «да» — тот же запуск с --yes (перед изменением — дамп БД).` );
		}
		const dir = join( root, '.claude', '.state', 'backups', 'db' );
		mkdirSync( dir, { recursive: true } );
		const dump = join( dir, `local-${ new Date().toISOString().replace( /[-:]/g, '' ).slice( 0, 15 ) }.sql` );
		const d = wp( cfg, [ 'db', 'export', dump ] );
		if ( d.status !== 0 ) {
			throw new Error( `Дамп БД не сделан — изменение не выполняю: ${ ( d.stdout + d.stderr ).trim() }` );
		}
		console.error( `Дамп: ${ dump }` );
	}
	const r = wp( cfg, wpArgs );
	process.stdout.write( r.stdout || '' );
	process.stderr.write( r.stderr || '' );
	process.exitCode = r.status ?? 1;
}

try {
	const cmd = args[ 0 ];
	if ( argv.includes( '--' ) ) {
		await cmdWp();
	} else if ( cmd === 'detect' ) {
		await cmdDetect();
	} else if ( cmd === 'status' ) {
		await cmdStatus();
	} else if ( cmd === 'link' ) {
		cmdLink();
	} else {
		throw new Error( 'Команда: detect <путь> | status | link | -- wp <команда> [--yes]' );
	}
} catch ( e ) {
	console.error( String( e instanceof Error ? e.message : e ) );
	process.exit( 1 );
}
