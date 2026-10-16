/**
 * Проверка подключения (project-init → access.md): цепочка SSH + SFTP → только SFTP → FTPS / FTP, файл ключа, ключ сервера,
 * лимит неудачных входов, путь к WordPress, что умеет оболочка. Итог — какой строкой записать в ACCESS.md → «Подключение».
 *   node .claude/skills/project-ops/scripts/connect-check.mjs [--stage] [--reset-auth] [--forget-host]
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKeyFile, forgetHost, resetAuth } from './connect.mjs';
import { ensureDeps, loadConfig, repoRoot } from './remote.mjs';

const scriptsDir = dirname( fileURLToPath( import.meta.url ) );
const argv = process.argv.slice( 2 );
const stage = argv.includes( '--stage' );
const stageArg = stage ? [ '--stage' ] : [];

const run = ( script, ...args ) => {
	const r = spawnSync( process.execPath, [ join( scriptsDir, script ), ...stageArg, ...args ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120000 } );
	return { ok: r.status === 0, out: `${ r.stdout || '' }${ r.stderr || '' }`.trim() };
};
const lastLine = ( t ) => t.split( '\n' ).filter( Boolean ).pop() || '';

try {
	ensureDeps();
	const root = repoRoot();
	if ( stage ) {
		process.env.SFTP_CONFIG = 'sftp-stage.json';
		process.env.SSH_CONFIG = 'ssh-stage.json';
	}
	const cfg = loadConfig( root );
	if ( argv.includes( '--reset-auth' ) ) {
		resetAuth( root, cfg );
		console.log( `Счётчик неудачных входов для ${ cfg.host } сброшен. Перед повтором — убедиться, что доступ исправлен.` );
		process.exit( 0 );
	}
	if ( argv.includes( '--forget-host' ) ) {
		forgetHost( root, cfg );
		console.log( `Ключ сервера ${ cfg.host } забыт — при следующем входе запомнится новый. Только если смена ключа подтверждена.` );
		process.exit( 0 );
	}

	const lines = [ `# Подключение (${ stage ? 'stage' : 'прод' }): ${ cfg.username || '?' }@${ cfg.host }:${ cfg.port || 22 } · ${ cfg.protocol || 'sftp' }` ];
	const keyProblem = checkKeyFile( cfg );
	lines.push( cfg.privateKeyPath ? `Ключ: ${ keyProblem || 'файл в порядке' }` : 'Вход: по паролю (из json, в чат не выводится)' );
	if ( keyProblem ) {
		lines.push( 'Итог: ключ не годится — исправить и повторить.' );
		console.log( lines.join( '\n' ) );
		process.exit( 1 );
	}

	const ftp = cfg.protocol === 'ftp' || cfg.protocol === 'ftps';
	let ssh = { ok: false, out: 'не проверялся (конфиг FTP)' };
	let tools = '';
	if ( ! ftp ) {
		ssh = run( 'ssh-exec.mjs', 'test' );
		if ( ssh.ok ) {
			tools = run( 'ssh-exec.mjs', '--', 'command -v wp php find md5sum grep ls 2>/dev/null' ).out;
		}
	}
	const files = run( 'sftp-sync.mjs', 'test' );
	const wpcli = /WP-CLI:yes/.test( ssh.out );
	const has = ( name ) => new RegExp( `/${ name }\\b` ).test( tools );

	lines.push( `SSH: ${ ssh.ok ? 'да' : `нет — ${ lastLine( ssh.out ) }` }` );
	lines.push( `${ ftp ? cfg.protocol.toUpperCase() : 'SFTP' }: ${ files.ok ? 'да' : `нет — ${ lastLine( files.out ) }` }` );

	if ( files.ok ) {
		const ls = run( 'sftp-sync.mjs', 'list' );
		const isWp = /\swp-config\.php$/m.test( ls.out ) && /\swp-content$/m.test( ls.out );
		lines.push( `Путь к сайту (${ cfg.remotePath || '/' }): ${ isWp ? 'WordPress найден' : 'wp-config.php здесь нет — проверить remotePath (каталог с wp-config.php)' }` );
		if ( ! isWp && /^\/https?docs\/?$/.test( cfg.remotePath || '' ) ) {
			lines.push( '  Plesk без chroot (SSH /bin/bash) видит настоящий корень: remotePath и ssh.json → cwd — /var/www/vhosts/<домен>/httpdocs' );
		}
	}
	if ( ssh.ok ) {
		lines.push( `WP-CLI: ${ wpcli ? 'да' : 'нет' } · php: ${ has( 'php' ) ? 'да' : 'нет' } · find: ${ has( 'find' ) ? 'да' : 'нет' } · md5sum: ${ has( 'md5sum' ) ? 'да' : 'нет' }` );
		if ( ! has( 'find' ) && ! has( 'php' ) ) {
			lines.push( '  оболочка урезанная (chroot): WP-CLI и php не запустить — для Plesk: SSH /bin/bash вместо chrooted, WP-CLI — установить (часть F плана)' );
		} else if ( has( 'wp' ) && ! has( 'php' ) ) {
			lines.push( "  php нет в PATH (Plesk: /opt/plesk/php/<версия>/bin) — человек: echo 'export PATH=/opt/plesk/php/<версия>/bin:$PATH' > ~/.bashrc (файл есть — строкой в начало)" );
			lines.push( '  wp с префиксом php не запускать: guard-wpcli узнаёт WP-CLI только по первому слову wp' );
		}
	}

	let mode;
	if ( ssh.ok && files.ok ) {
		mode = 'SSH + SFTP';
	} else if ( files.ok ) {
		mode = ftp ? cfg.protocol.toUpperCase() : 'только SFTP';
	} else {
		mode = 'нет';
	}
	lines.push( '' );
	lines.push( `Итог для ACCESS.md → «Подключение»: ${ mode }` );
	if ( mode === 'нет' ) {
		lines.push( 'Заливки и сверки не будет. Диагностика — в ошибках выше; не повторять вход вслепую (лимит 2 неудачные попытки).' );
	} else {
		lines.push( `Заливка и откат: да · сверка с сервером: да · WP-CLI: ${ wpcli ? 'да' : 'нет — шаги с базой делает человек (access.md → «Без SSH»)' }` );
		if ( ! ssh.ok ) {
			lines.push( 'Без SSH: локальный PHP обязателен (php -l до заливки), debug.log — через sftp-sync fetch.' );
		}
		if ( cfg.protocol === 'ftp' ) {
			lines.push( '⚠️ FTP без шифрования: пароль идёт открытым текстом — попросить у хостинга SFTP или FTPS.' );
		}
	}
	console.log( lines.join( '\n' ) );
} catch ( e ) {
	console.error( String( e instanceof Error ? e.message : e ).replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
