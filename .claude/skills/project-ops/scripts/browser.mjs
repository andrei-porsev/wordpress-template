/**
 * Браузер для проверки вёрстки через playwright-cli — запасной путь, когда Playwright MCP недоступен (решение 055).
 * Запуск из корня:
 *   node .claude/skills/project-ops/scripts/browser.mjs open <url>       браузер без окна, конфиг .vscode/playwright-mcp.json (пароль stage)
 *   node .claude/skills/project-ops/scripts/browser.mjs <команда> [...]  resize, set-color-scheme, snapshot, screenshot, console, requests, eval, click…, close
 * Адреса — только домены проекта из ACCESS.md и .vscode/local.json. Сессия одна на проект (stem из project.json).
 * Снимки и скриншоты без --filename — в .claude/.state/browser/ (вне git и заливки); --filename — от корня проекта.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const CLI = join( skillDir, 'node_modules', '@playwright', 'cli', 'playwright-cli.js' );

// Команды, которых хватает для layout-check; остальные (run-code, route, state-*, install…) закрыты.
const ALLOWED = new Set( [
	'open', 'goto', 'close', 'list', 'reload', 'go-back', 'go-forward',
	'snapshot', 'find', 'screenshot', 'console', 'requests', 'eval',
	'resize', 'set-color-scheme', 'clear-color-scheme', 'set-reduced-motion', 'clear-reduced-motion', 'set-media', 'clear-media',
	'click', 'dblclick', 'hover', 'press', 'keydown', 'keyup', 'type', 'fill', 'select', 'check', 'uncheck', 'mousewheel',
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

const [ cmd, ...rest ] = process.argv.slice( 2 );
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
const session = String( project?.stem || basename( root ) ).replace( /[^\w-]+/g, '-' );
const stateDir = join( root, '.claude', '.state', 'browser' );
mkdirSync( stateDir, { recursive: true } );

// --filename — от корня проекта, как filename у MCP (снимки «было → стало» в .claude/.state/reports/shots/).
const own = rest.map( ( a ) => a.replace( /^--filename=(.+)$/, ( m, p ) => `--filename=${ resolve( root, p ) }` ) );
const args = [ CLI, `-s=${ session }`, cmd, ...own ];
const config = join( root, '.vscode', 'playwright-mcp.json' );
if ( cmd === 'open' && existsSync( config ) ) {
	args.push( `--config=${ config }` );
}

// cwd — папка состояния: туда CLI пишет .playwright-cli/.
const r = spawnSync( process.execPath, args, { cwd: stateDir, encoding: 'utf8' } );
const out = ( r.stdout || '' ).replace( /\]\((?!https?:)([^)]+)\)/g, ( m, p ) => `](.claude/.state/browser/${ p.replace( /\\/g, '/' ) })` );
process.stdout.write( out );
process.stderr.write( r.stderr || '' );
process.exit( r.status ?? 1 );
