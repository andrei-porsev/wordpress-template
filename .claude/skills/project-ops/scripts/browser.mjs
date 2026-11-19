/**
 * Браузер для проверки вёрстки через playwright-cli — запасной путь, когда Playwright MCP недоступен (решение 039).
 * Запуск из корня:
 *   node .claude/skills/project-ops/scripts/browser.mjs open <url>       видимое окно, конфиг .vscode/playwright-mcp.json (пароль stage)
 *   node .claude/skills/project-ops/scripts/browser.mjs <команда> [...]  resize, set-color-scheme, snapshot, screenshot, console, requests, eval, click…, close
 *   --browser=webkit|firefox у любой команды — отдельная сессия этого браузера (skill qa, направление B); установка — install-deps.mjs --browsers
 * Адреса — только домены проекта из ACCESS.md и .vscode/local.json. Сессия одна на проект (stem из project.json).
 * Снимки и скриншоты без --filename — в .claude/.state/browser/ (вне git и заливки); --filename — от корня проекта.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const CLI = join( skillDir, 'node_modules', '@playwright', 'cli', 'playwright-cli.js' );

// Команды, которых хватает для layout-check; остальные (run-code, route, state-*, install…) закрыты.
const ALLOWED = new Set( [
	'open', 'goto', 'close', 'list', 'reload', 'go-back', 'go-forward',
	'snapshot', 'find', 'screenshot', 'console', 'requests', 'eval',
	'resize', 'set-color-scheme', 'clear-color-scheme', 'set-reduced-motion', 'clear-reduced-motion', 'set-media', 'clear-media',
	'click', 'dblclick', 'hover', 'press', 'keydown', 'keyup', 'type', 'fill', 'select', 'check', 'uncheck', 'mousemove', 'mousewheel',
	'dialog-accept', 'dialog-dismiss',
] );
const NAV = new Set( [ 'open', 'goto' ] );
const ACCESS_FIELDS = [ 'Публичный URL', 'Stage / dev URL', 'Локальный URL', 'Админка URL' ];

const root = process.cwd();
const fail = ( msg ) => {
	console.error( msg );
	process.exit( 1 );
};

function readJson( path ) {
	try {
		return JSON.parse( readFileSync( path, 'utf8' ) );
	} catch {
		return null;
	}
}

// Хост без www. — www-вариант домена считается тем же сайтом.
const bareHost = ( url ) => new URL( url ).hostname.toLowerCase().replace( /^www\./, '' );

function projectHosts( dir ) {
	const hosts = new Set();
	const access = join( dir, 'ACCESS.md' );
	if ( existsSync( access ) ) {
		for ( const line of readFileSync( access, 'utf8' ).split( '\n' ) ) {
			const field = ACCESS_FIELDS.find( ( f ) => line.trim().startsWith( `- ${ f }:` ) );
			for ( const m of field ? line.matchAll( /https?:\/\/[^\s`()]+/g ) : [] ) {
				hosts.add( bareHost( m[ 0 ] ) );
			}
		}
	}
	const local = readJson( join( dir, '.vscode', 'local.json' ) );
	if ( local?.url ) {
		hosts.add( bareHost( local.url ) );
	}
	return hosts;
}

const ENGINES = new Set( [ 'chromium', 'webkit', 'firefox' ] );

// --browser=<движок> или --browser <движок> — вынимается из аргументов, сессию и флаг для open подставляет скрипт.
const argv = process.argv.slice( 2 );
let engine = 'chromium';
for ( let i = 0; i < argv.length; i++ ) {
	const m = argv[ i ].match( /^--browser(?:=(.*))?$/ );
	if ( m ) {
		const value = m[ 1 ] ?? argv[ i + 1 ] ?? '';
		argv.splice( i, m[ 1 ] === undefined ? 2 : 1 );
		engine = value.toLowerCase();
		break;
	}
}
if ( ! ENGINES.has( engine ) ) {
	fail( `Браузер «${ engine }» не поддерживается: chromium (по умолчанию), webkit, firefox.` );
}

const [ cmd, ...rest ] = argv;
if ( ! cmd ) {
	fail( 'Команда: open <url> | goto <url> | resize <w> <h> | set-color-scheme dark | snapshot | screenshot | console | requests | eval <js> | close' );
}
if ( ! ALLOWED.has( cmd ) ) {
	fail( `Команда «${ cmd }» закрыта. Доступны: ${ [ ...ALLOWED ].join( ', ' ) }.` );
}
if ( rest.some( ( a ) => /^(-s|--session|--config|--profile|--extension)\b/.test( a ) ) ) {
	fail( 'Сессию и конфиг подставляет скрипт — флаги -s, --config, --profile, --extension не передавать.' );
}

const url = NAV.has( cmd ) ? rest.find( ( a ) => ! a.startsWith( '-' ) ) : '';
if ( url ) {
	let host;
	try {
		host = bareHost( url );
	} catch {
		fail( `Не адрес: ${ url } (нужен полный, с https://).` );
	}
	const hosts = projectHosts( root );
	if ( ! hosts.has( host ) ) {
		fail( `${ host } — не домен проекта (${ [ ...hosts ].join( ', ' ) || 'URL в ACCESS.md не заполнены' }). Чужие сайты — только по просьбе человека, не этим скриптом.` );
	}
} else if ( cmd === 'goto' ) {
	fail( 'goto без адреса.' );
}
if ( ! existsSync( CLI ) ) {
	fail( 'Нет playwright-cli. Один раз: node .claude/skills/project-ops/scripts/install-deps.mjs' );
}

const project = readJson( join( root, 'project-base', 'project.json' ) );
const stem = String( project?.stem || basename( root ) ).replace( /[^\w-]+/g, '-' );
const session = engine === 'chromium' ? stem : `${ stem }-${ engine }`;
const stateDir = join( root, '.claude', '.state', 'browser' );
mkdirSync( stateDir, { recursive: true } );

// Конфиг для WebKit и Firefox — тот же, без аргументов запуска Chromium (--start-maximized у них не работает).
function engineConfig( path ) {
	if ( engine === 'chromium' ) {
		return path;
	}
	const cfg = readJson( path ) || {};
	cfg.browser = { ...( cfg.browser || {} ), browserName: engine };
	delete cfg.browser.launchOptions?.args;
	delete cfg.browser.launchOptions?.channel;
	const out = join( stateDir, `playwright-${ engine }.json` );
	writeFileSync( out, JSON.stringify( cfg, null, '\t' ) );
	return out;
}

// --filename — от корня проекта, как filename у MCP (снимки «было → стало» в .claude/.state/reports/shots/).
const own = rest.map( ( a ) => a.replace( /^--filename=(.+)$/, ( m, p ) => `--filename=${ resolve( root, p ) }` ) );
const args = [ CLI, `-s=${ session }`, cmd, ...own ];
const config = join( root, '.vscode', 'playwright-mcp.json' );
if ( cmd === 'open' ) {
	// Окно видно человеку: он смотрит, что делает агент.
	if ( ! rest.includes( '--headed' ) ) {
		args.push( '--headed' );
	}
	if ( existsSync( config ) || engine !== 'chromium' ) {
		args.push( `--config=${ engineConfig( config ) }` );
	}
	if ( engine !== 'chromium' ) {
		args.push( `--browser=${ engine }` );
	}
}

// cwd — папка состояния: туда CLI пишет .playwright-cli/.
const r = spawnSync( process.execPath, args, { cwd: stateDir, encoding: 'utf8' } );
const out = ( r.stdout || '' ).replace( /\]\((?!https?:)([^)]+)\)/g, ( m, p ) => `](.claude/.state/browser/${ p.replace( /\\/g, '/' ) })` );
process.stdout.write( out );
process.stderr.write( r.stderr || '' );
if ( /is not installed/.test( ( r.stdout || '' ) + ( r.stderr || '' ) ) ) {
	console.error( `\nБраузер ${ engine } не установлен. Один раз: node .claude/skills/project-ops/scripts/install-deps.mjs --browsers` );
}
process.exit( r.status ?? 1 );
