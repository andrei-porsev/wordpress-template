/**
 * Подключение к серверу: проверка ключа сервера (отпечаток запоминается при первом входе), лимит неудачных входов
 * (Fail2Ban блокирует IP после нескольких ошибок), проверка файла ключа, понятная диагностика ошибок.
 * Используют remote.mjs (SFTP), ssh-exec.mjs, connect-check.mjs. Состояние — .claude/.state/ (не в git).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_AUTH_FAILS = 2;
const AUTH_LOCK_MS = 30 * 60 * 1000;

function statePath( root, name ) {
	return join( root, '.claude', '.state', name );
}

function readState( root, name ) {
	try {
		return JSON.parse( readFileSync( statePath( root, name ), 'utf8' ) );
	} catch {
		return {};
	}
}

function writeState( root, name, data ) {
	const path = statePath( root, name );
	mkdirSync( dirname( path ), { recursive: true } );
	writeFileSync( path, JSON.stringify( data, null, '\t' ) + '\n' );
}

const hostId = ( cfg ) => `${ cfg.username }@${ cfg.host }:${ cfg.port || 22 }`;

// Перед входом: не было ли уже 2 неудачных подряд за последние 30 минут.
export function assertAuthAllowed( root, cfg ) {
	const st = readState( root, 'auth-fails.json' )[ hostId( cfg ) ];
	if ( st && st.count >= MAX_AUTH_FAILS && Date.now() - st.last < AUTH_LOCK_MS ) {
		const left = Math.ceil( ( AUTH_LOCK_MS - ( Date.now() - st.last ) ) / 60000 );
		throw new Error( `Стоп: ${ st.count } неудачных входа подряд на ${ cfg.host } — ещё попытка может заблокировать IP (Fail2Ban). ` +
			`Сначала разобраться с доступом (connect-check.mjs, access.md → «Диагностика»); повтор через ${ left } мин или connect-check.mjs --reset-auth.` );
	}
}

export function recordAuth( root, cfg, ok ) {
	const all = readState( root, 'auth-fails.json' );
	const id = hostId( cfg );
	if ( ok ) {
		delete all[ id ];
	} else {
		all[ id ] = { count: ( all[ id ]?.count || 0 ) + 1, last: Date.now() };
	}
	writeState( root, 'auth-fails.json', all );
}

export function resetAuth( root, cfg ) {
	recordAuth( root, cfg, true );
}

export function isAuthError( err ) {
	return /authentication methods failed|Authentication failed|Permission denied|530 /i.test( String( err?.message || err ) );
}

/*
 * hostVerifier для ssh2: первый вход — запомнить отпечаток; потом — пускать только с тем же.
 * Сменился — запись в err.hostKeyChanged и отказ до попытки входа.
 */
export function hostVerifier( root, cfg, state = {} ) {
	return ( key ) => {
		const fp = 'SHA256:' + createHash( 'sha256' ).update( key ).digest( 'base64' ).replace( /=+$/, '' );
		const known = readState( root, 'known-hosts.json' );
		const id = `${ cfg.host }:${ cfg.port || 22 }`;
		state.fingerprint = fp;
		if ( ! known[ id ] ) {
			known[ id ] = { fingerprint: fp, first: new Date().toISOString() };
			writeState( root, 'known-hosts.json', known );
			state.firstSeen = true;
			return true;
		}
		if ( known[ id ].fingerprint !== fp ) {
			state.hostKeyChanged = { was: known[ id ].fingerprint, now: fp };
			return false;
		}
		return true;
	};
}

export function hostKeyError( cfg, state ) {
	const c = state.hostKeyChanged;
	return new Error( `СТОП: сменился ключ сервера ${ cfg.host } (было ${ c.was }, стало ${ c.now }). Это переустановка сервера — или подмена. ` +
		'Не подключаюсь. Уточнить у хостинга или владельца сервера; если смена ожидаемая — connect-check.mjs --forget-host.' );
}

export function forgetHost( root, cfg ) {
	const known = readState( root, 'known-hosts.json' );
	delete known[ `${ cfg.host }:${ cfg.port || 22 }` ];
	writeState( root, 'known-hosts.json', known );
}

// Файл ключа: есть ли, не PuTTY ли, нужна ли парольная фраза.
export function checkKeyFile( cfg ) {
	if ( ! cfg.privateKeyPath ) {
		return null;
	}
	if ( ! existsSync( cfg.privateKeyPath ) ) {
		return `Файла ключа нет: ${ cfg.privateKeyPath }. Путь — в ssh.json / sftp.json → privateKeyPath.`;
	}
	const head = readFileSync( cfg.privateKeyPath, 'utf8' ).slice( 0, 200 );
	if ( /PuTTY-User-Key-File/.test( head ) ) {
		return 'Ключ в формате PuTTY (.ppk) — скрипты его не читают. PuTTYgen → Load → Conversions → Export OpenSSH key, путь к новому файлу — в privateKeyPath.';
	}
	if ( /BEGIN (ENCRYPTED PRIVATE KEY|.*PRIVATE KEY)/.test( head ) && /ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test( readFileSync( cfg.privateKeyPath, 'utf8' ).slice( 0, 400 ) ) && ! cfg.passphrase ) {
		return 'Ключ зашифрован парольной фразой, а passphrase в json нет.';
	}
	if ( ! /BEGIN .*PRIVATE KEY/.test( head ) ) {
		return `Файл ${ cfg.privateKeyPath } не похож на приватный ключ (это .pub?).`;
	}
	return null;
}

// Ошибка подключения → что случилось и что делать (access.md → «Диагностика»).
export function diagnose( err, cfg = {} ) {
	const m = String( err?.message || err );
	const port = cfg.port || 22;
	if ( /ENOTFOUND|getaddrinfo|Address lookup failed/i.test( m ) ) {
		return `Хост ${ cfg.host } не найден — опечатка в адресе или домен ещё не указывает на сервер.`;
	}
	if ( /ETIMEDOUT|Timed out while waiting for handshake|timed out/i.test( m ) ) {
		return `Нет ответа на порту ${ port } — закрыт фаерволом (панель хостинга; у IONOS ещё облачный фаервол) или не тот порт (SiteGround 18765, Hostinger 65002).`;
	}
	if ( /ECONNREFUSED/i.test( m ) ) {
		return `Порт ${ port } отказывает — SSH / SFTP выключен на сервере или порт другой. Включить в панели хостинга.`;
	}
	if ( /ECONNRESET|Connection lost|kex|handshake failed/i.test( m ) ) {
		return 'Сервер оборвал соединение при рукопожатии — возможна блокировка IP (Fail2Ban) или несовместимые алгоритмы. Подождать / проверить блокировки в панели.';
	}
	if ( /Encrypted private key detected|passphrase/i.test( m ) ) {
		return 'Ключ зашифрован парольной фразой — добавить passphrase в json или ключ без фразы.';
	}
	if ( /Cannot parse privateKey|Unsupported key format/i.test( m ) ) {
		return 'Файл ключа не читается — формат PuTTY (.ppk) или повреждён; нужен OpenSSH (PuTTYgen → Export OpenSSH key).';
	}
	if ( /authentication methods failed|Authentication failed|Permission denied|530 /i.test( m ) ) {
		return 'Вход не принят: не тот логин или пароль, ключ не добавлен в authorized_keys, вход по паролю запрещён, или права на ~/.ssh не 700 / 600. ' +
			`Не повторять вслепую — лимит ${ MAX_AUTH_FAILS } попытки.`;
	}
	if ( /Unable to exec|Channel open failure|exit 1/i.test( m ) ) {
		return 'Вошёл, но команды не выполняются — оболочка /bin/false или chroot без нужных программ. Plesk: «Доступ к веб-хостингу» → SSH /bin/bash.';
	}
	if ( /No such file|ENOENT/i.test( m ) ) {
		return 'Путь на сервере не найден — проверить remotePath / cwd (каталог с wp-config.php).';
	}
	return '';
}
