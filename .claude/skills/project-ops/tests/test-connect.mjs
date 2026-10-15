/**
 * Проверка connect.mjs без сервера: лимит неудачных входов, файл ключа, отпечаток ключа сервера, диагностика.
 * node .claude/skills/project-ops/tests/test-connect.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAuthAllowed, checkKeyFile, diagnose, forgetHost, hostVerifier, recordAuth, resetAuth } from '../scripts/connect.mjs';

const root = join( tmpdir(), 'wp-template-test-connect' );
rmSync( root, { recursive: true, force: true } );
mkdirSync( root, { recursive: true } );
const cfg = { host: 'example.test', port: 22, username: 'u' };

let fails = 0;
const check = ( name, ok ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }` );
	fails += ok ? 0 : 1;
};
const throws = ( fn ) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

// Лимит неудачных входов.
check( 'первый вход разрешён', ! throws( () => assertAuthAllowed( root, cfg ) ) );
recordAuth( root, cfg, false );
check( 'после 1 ошибки — ещё можно', ! throws( () => assertAuthAllowed( root, cfg ) ) );
recordAuth( root, cfg, false );
check( 'после 2 ошибок — стоп', throws( () => assertAuthAllowed( root, cfg ) ) );
check( 'другой хост не затронут', ! throws( () => assertAuthAllowed( root, { ...cfg, host: 'other.test' } ) ) );
resetAuth( root, cfg );
check( 'после сброса — можно', ! throws( () => assertAuthAllowed( root, cfg ) ) );
recordAuth( root, cfg, false );
recordAuth( root, cfg, true );
check( 'успешный вход обнуляет счётчик', ! throws( () => { recordAuth( root, cfg, false ); assertAuthAllowed( root, cfg ); } ) );
resetAuth( root, cfg );

// Файл ключа.
const key = ( name, text ) => {
	const p = join( root, name );
	writeFileSync( p, text );
	return p;
};
check( 'ключа нет', /нет/.test( checkKeyFile( { privateKeyPath: join( root, 'missing' ) } ) || '' ) );
check( '.ppk распознан', /PuTTY/.test( checkKeyFile( { privateKeyPath: key( 'k.ppk', 'PuTTY-User-Key-File-3: ssh-ed25519\n' ) } ) || '' ) );
check( 'зашифрованный без фразы', /парольной фразой/.test( checkKeyFile( { privateKeyPath: key( 'enc', '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n' ) } ) || '' ) );
check( '.pub вместо приватного', /не похож/.test( checkKeyFile( { privateKeyPath: key( 'k.pub', 'ssh-ed25519 AAAA user@host\n' ) } ) || '' ) );
check( 'нормальный OpenSSH', checkKeyFile( { privateKeyPath: key( 'ok', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n' ) } ) === null );
check( 'вход по паролю — не проверяется', checkKeyFile( { password: 'x' } ) === null );

// Отпечаток ключа сервера.
const s1 = {};
check( 'первый вход — ключ запомнен', hostVerifier( root, cfg, s1 )( Buffer.from( 'key-A' ) ) && s1.firstSeen );
const s2 = {};
check( 'тот же ключ — пускает', hostVerifier( root, cfg, s2 )( Buffer.from( 'key-A' ) ) && ! s2.hostKeyChanged );
const s3 = {};
check( 'другой ключ — отказ', ! hostVerifier( root, cfg, s3 )( Buffer.from( 'key-B' ) ) && Boolean( s3.hostKeyChanged ) );
forgetHost( root, cfg );
const s4 = {};
check( 'после forget — новый ключ принят', hostVerifier( root, cfg, s4 )( Buffer.from( 'key-B' ) ) && s4.firstSeen );

// Диагностика.
const cases = [
	[ 'getaddrinfo ENOTFOUND x', /не найден/ ],
	[ 'connect: Address lookup failed for host', /не найден/ ],
	[ 'Timed out while waiting for handshake', /Нет ответа на порту/ ],
	[ 'connect ECONNREFUSED 1.2.3.4:22', /отказывает/ ],
	[ 'All configured authentication methods failed', /Вход не принят/ ],
	[ '530 Login incorrect.', /Вход не принят/ ],
	[ 'Encrypted private key detected, but no passphrase given', /парольной фразой/ ],
	[ 'Cannot parse privateKey: Unsupported key format', /не читается/ ],
	[ 'ECONNRESET', /оборвал/ ],
	[ 'Unable to exec', /оболочка/ ],
];
for ( const [ msg, re ] of cases ) {
	check( `диагноз: ${ msg.slice( 0, 40 ) }`, re.test( diagnose( new Error( msg ), cfg ) ) );
}

console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки connect прошли' );
process.exit( fails ? 1 : 0 );
