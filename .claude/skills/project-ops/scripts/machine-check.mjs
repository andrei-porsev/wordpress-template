/**
 * Проверка машины — один раз на компьютер (project-init → этап 10): Node, PHP, phpcs, git, SSH-ключ, tar, WP-CLI LocalWP / OSPanel.
 * Итог — ~/.wp-template/machine.json; повтор — через 30 дней, при сбое или с --force. Ничего не устанавливает и не меняет PATH:
 * найденное и недостающее печатает с командами для человека.
 *   node .claude/skills/project-ops/scripts/machine-check.mjs [--force]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, readHome, writeHome } from './home.mjs';
import { tarBin } from './security.mjs';

const STALE_DAYS = 30;
const skillDir = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const win = process.platform === 'win32';

const sh = ( cmd, args = [] ) => {
	const r = spawnSync( cmd, args, { encoding: 'utf8', shell: win, timeout: 30000 } );
	return { ok: r.status === 0, out: `${ r.stdout || '' }${ r.stderr || '' }`.trim() };
};
const firstLine = ( t ) => String( t ).split( '\n' )[ 0 ].trim();

// Где искать PHP, если его нет в PATH: LocalWP, OSPanel 5 / 6, XAMPP, Laragon.
function phpCandidates() {
	const found = [];
	const roots = [];
	if ( win ) {
		const appdata = process.env.APPDATA || join( homedir(), 'AppData', 'Roaming' );
		roots.push( [ join( appdata, 'Local', 'lightning-services' ), ( d ) => d.startsWith( 'php-' ), [ 'bin', 'win64', 'php.exe' ] ] );
		for ( const drive of [ 'C:', 'D:', 'E:' ] ) {
			roots.push( [ `${ drive }\\OSPanel\\modules\\php`, () => true, [ 'php.exe' ] ] );
			roots.push( [ `${ drive }\\OSPanel\\modules`, ( d ) => /^php/i.test( d ), [ 'php.exe' ] ] );
			roots.push( [ `${ drive }\\laragon\\bin\\php`, () => true, [ 'php.exe' ] ] );
			const x = `${ drive }\\xampp\\php\\php.exe`;
			existsSync( x ) && found.push( x );
		}
	}
	for ( const [ base, match, tail ] of roots ) {
		if ( ! existsSync( base ) ) {
			continue;
		}
		for ( const d of readdirSync( base ).filter( match ) ) {
			const p = join( base, d, ...tail );
			existsSync( p ) && found.push( p );
		}
	}
	return [ ...new Set( found ) ].sort().reverse();
}

function sshKeyState() {
	const dir = join( homedir(), '.ssh' );
	for ( const name of [ 'id_ed25519', 'id_ecdsa', 'id_rsa' ] ) {
		const p = join( dir, name );
		if ( existsSync( p ) ) {
			const head = readFileSync( p, 'utf8' ).slice( 0, 80 );
			return { path: p, pub: existsSync( `${ p }.pub` ), format: /OPENSSH|RSA PRIVATE|EC PRIVATE/.test( head ) ? 'OpenSSH' : 'неизвестный' };
		}
	}
	const ppk = existsSync( dir ) ? readdirSync( dir ).find( ( f ) => f.endsWith( '.ppk' ) ) : null;
	return { path: null, ppk: ppk ? join( dir, ppk ) : null };
}

function check() {
	const r = { date: new Date().toISOString(), platform: process.platform, items: {}, todo: [] };
	const item = ( key, ok, value, todo ) => {
		r.items[ key ] = { ok, value };
		if ( ! ok && todo ) {
			r.todo.push( todo );
		}
	};

	const nodeMajor = Number( process.versions.node.split( '.' )[ 0 ] );
	item( 'node', nodeMajor >= 20, process.version, 'Node 20+ — обновить с nodejs.org' );
	item( 'npm-deps', existsSync( join( skillDir, 'node_modules', 'ssh2-sftp-client' ) ), 'зависимости project-ops', 'node .claude/skills/project-ops/scripts/install-deps.mjs (в каждом проекте)' );
	// Playwright MCP и playwright-cli берут установленный Google Chrome (канал chrome), свой браузер не качают.
	const chrome = win
		? [ process.env.ProgramFiles, process.env[ 'ProgramFiles(x86)' ], process.env.LOCALAPPDATA ].filter( Boolean ).map( ( d ) => join( d, 'Google', 'Chrome', 'Application', 'chrome.exe' ) ).find( existsSync )
		: [ '/Applications/Google Chrome.app', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable' ].find( existsSync );
	item( 'chrome', Boolean( chrome ), chrome || 'нет', 'Google Chrome — для проверки вёрстки в Playwright (google.com/chrome)' );

	const php = sh( 'php', [ '-v' ] );
	if ( php.ok ) {
		item( 'php', true, firstLine( php.out ) );
	} else {
		const c = phpCandidates();
		item( 'php', false, c.length ? `нет в PATH; найден: ${ c[ 0 ] }` : 'не найден',
			c.length ? `PHP в PATH (человек): добавить папку «${ dirname( c[ 0 ] ) }» в переменную Path (Параметры → Система → О системе → Дополнительные параметры → Переменные среды), перезапустить терминал`
				: 'PHP локально нет: без SSH PHP-файлы не проверить до заливки — поставить PHP (LocalWP / OSPanel) или отметить «PHP локально: нет»' );
	}

	const phpcs = sh( 'phpcs', [ '--version' ] );
	const standards = phpcs.ok ? sh( 'phpcs', [ '-i' ] ).out : '';
	item( 'phpcs', phpcs.ok && /WordPress/.test( standards ), phpcs.ok ? `${ firstLine( phpcs.out ).replace( /by Squiz.*/, '' ).trim() }${ /WordPress/.test( standards ) ? ', стандарт WordPress' : ', БЕЗ стандарта WordPress' }` : 'нет',
		'phpcs + WPCS (по желанию): composer global require --dev wp-coding-standards/wpcs dealerdirect/phpcodesniffer-composer-installer' );

	const git = sh( 'git', [ '--version' ] );
	const name = sh( 'git', [ 'config', '--global', 'user.name' ] ).out;
	const email = sh( 'git', [ 'config', '--global', 'user.email' ] ).out;
	item( 'git', git.ok && Boolean( name ) && Boolean( email ), git.ok ? `${ firstLine( git.out ) } · ${ name || 'имя не задано' } <${ email || 'почта не задана' }>` : 'нет',
		'git: git config --global user.name "…" и user.email "…"' );
	// Действующее значение: Git для Windows ставит true на уровне системы, не глобально.
	const crlf = sh( 'git', [ 'config', 'core.autocrlf' ] ).out;
	item( 'autocrlf', crlf !== 'true', crlf || 'не задан', 'git config --global core.autocrlf input — перекрывает системное true; иначе рабочая копия с CRLF, а сервер на LF (в шаблоне есть .gitattributes)' );

	const key = sshKeyState();
	item( 'ssh-key', Boolean( key.path ) && key.pub, key.path ? `${ key.path } (${ key.format }${ key.pub ? ', .pub есть' : ', .pub НЕТ' })` : key.ppk ? `только PuTTY: ${ key.ppk }` : 'нет',
		key.ppk && ! key.path ? 'ключ PuTTY → OpenSSH: PuTTYgen → Load → Conversions → Export OpenSSH key → ~/.ssh/id_ed25519'
			: `SSH-ключ (после «да»): ssh-keygen -t ed25519 -f "${ join( homedir(), '.ssh', 'id_ed25519' ) }" -N "" -C "<почта>"` );

	const tar = sh( tarBin(), [ '--version' ] );
	item( 'tar', tar.ok && ! ( win && /GNU tar/.test( tar.out ) ), firstLine( tar.out ).split( ' - ' )[ 0 ] || 'нет', 'tar с zip нужен для сверки тем с оригиналом (Windows 10+ — встроенный System32\tar.exe)' );

	const wp = sh( 'wp', [ '--version' ] );
	const localWpCli = win ? [ 'C:\\Program Files (x86)\\Local\\resources\\extraResources\\bin\\wp-cli\\wp-cli.phar', 'C:\\Program Files\\Local\\resources\\extraResources\\bin\\wp-cli\\wp-cli.phar' ].find( existsSync ) : null;
	item( 'wp-cli-local', wp.ok || Boolean( localWpCli ), wp.ok ? firstLine( wp.out ) : localWpCli ? `LocalWP: ${ localWpCli }` : 'нет (локальный WP-CLI нужен только для локальной копии)', null );

	item( 'servers', Boolean( readHome( 'servers.json' ) ), readHome( 'servers.json' ) ? `${ Object.keys( readHome( 'servers.json' ).servers || {} ).join( ', ' ) || 'пусто' }` : 'нет',
		`профиль своего сервера (по желанию): скопировать .claude/skills/project-ops/servers.example.json → ${ join( homeDir(), 'servers.json' ) } и заполнить` );
	r.ok = Object.entries( r.items ).every( ( [ k, v ] ) => v.ok || [ 'phpcs', 'wp-cli-local', 'servers', 'npm-deps' ].includes( k ) );
	return r;
}

const prev = readHome( 'machine.json' );
const ageDays = prev ? ( Date.now() - Date.parse( prev.date ) ) / 86400000 : Infinity;
if ( prev && prev.ok && ageDays < STALE_DAYS && ! process.argv.includes( '--force' ) ) {
	console.log( `Машина проверена ${ Math.floor( ageDays ) } дн. назад — всё в порядке (повтор через ${ Math.ceil( STALE_DAYS - ageDays ) } дн. или --force).` );
	process.exit( 0 );
}
const res = check();
writeHome( 'machine.json', res );
const titles = { node: 'Node', 'npm-deps': 'Зависимости', chrome: 'Chrome', php: 'PHP', phpcs: 'phpcs', git: 'git', autocrlf: 'core.autocrlf', 'ssh-key': 'SSH-ключ', tar: 'tar', 'wp-cli-local': 'WP-CLI локально', servers: 'Профиль сервера' };
for ( const [ k, v ] of Object.entries( res.items ) ) {
	console.log( `${ v.ok ? '✅' : '⚠️ ' } ${ titles[ k ] || k }: ${ v.value }` );
}
if ( res.todo.length ) {
	console.log( '\nСделать (человек; агент только подсказывает):' );
	res.todo.forEach( ( t ) => console.log( `  — ${ t }` ) );
}
console.log( `\nИтог сохранён: ${ join( homeDir(), 'machine.json' ) }${ res.ok ? '' : ' — есть обязательные пункты, повтор при следующем запуске' }` );
