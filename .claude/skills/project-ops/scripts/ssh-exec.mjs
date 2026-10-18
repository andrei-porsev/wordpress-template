/**
 * SSH: .vscode/ssh.json, пустые поля — из sftp.json.
 * Пароль в stdout не пишем.
 * --stdin <файл> — локальный файл во ввод команды на сервере (длинный текст: wp post update <ID> -), на сервер он не записывается.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAuthAllowed, checkKeyFile, diagnose, hostKeyError, hostVerifier, isAuthError, recordAuth } from './connect.mjs';

// --stage: конфиг sftp-stage.json / ssh-stage.json вместо боевого.
if ( process.argv.includes( '--stage' ) ) {
	process.env.SFTP_CONFIG = 'sftp-stage.json';
	process.env.SSH_CONFIG = 'ssh-stage.json';
	process.argv = process.argv.filter( ( a ) => a !== '--stage' );
}

const skillDir = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

function repoRoot() {
	const cwd = process.cwd();
	if ( existsSync( join( cwd, '.vscode', 'sftp.json' ) ) || existsSync( join( cwd, 'ACCESS.md' ) ) ) {
		return cwd;
	}
	throw new Error( 'Запускай из корня репозитория.' );
}

function ensureDeps() {
	if ( existsSync( join( skillDir, 'node_modules', 'ssh2' ) ) ) {
		return;
	}
	throw new Error(
		'Нет зависимостей. Один раз: node .claude/skills/project-ops/scripts/install-deps.mjs'
	);
}

function readJson( path ) {
	if ( ! existsSync( path ) ) {
		return {};
	}
	let raw = JSON.parse( readFileSync( path, 'utf8' ) );
	if ( Array.isArray( raw ) ) {
		raw = raw[ 0 ] || {};
	}
	return raw;
}

function pick( ...vals ) {
	for ( const v of vals ) {
		if ( v !== undefined && v !== null && String( v ).trim() !== '' ) {
			return v;
		}
	}
	return '';
}

function loadConfig( root ) {
	const ssh = readJson( join( root, '.vscode', process.env.SSH_CONFIG || 'ssh.json' ) );
	const sftp = readJson( join( root, '.vscode', process.env.SFTP_CONFIG || 'sftp.json' ) );
	const cfg = {
		host: pick( ssh.host, sftp.host ),
		port: Number( pick( ssh.port, sftp.port, 22 ) ),
		username: pick( ssh.username, sftp.username ),
		password: pick( ssh.password, sftp.password ),
		privateKeyPath: pick( ssh.privateKeyPath, sftp.privateKeyPath ),
		passphrase: pick( ssh.passphrase, sftp.passphrase ),
		cwd: pick( ssh.cwd, sftp.remotePath, '/' ),
		wpCli: pick( ssh.wpCli, 'wp' ),
		readyTimeout: Number( pick( ssh.connectTimeout, sftp.connectTimeout, 20000 ) ),
	};
	if ( ! cfg.host ) {
		throw new Error( 'Нет host — заполни .vscode/ssh.json или sftp.json и ACCESS.md.' );
	}
	if ( ! cfg.username ) {
		throw new Error( 'Нет username — заполни ssh.json / sftp.json.' );
	}
	if ( ! cfg.password && ! cfg.privateKeyPath ) {
		throw new Error( 'Нет password и нет privateKeyPath.' );
	}
	return cfg;
}

function authOpts( cfg ) {
	const opts = {
		host: cfg.host,
		port: cfg.port,
		username: cfg.username,
		readyTimeout: cfg.readyTimeout,
	};
	if ( cfg.privateKeyPath ) {
		opts.privateKey = readFileSync( cfg.privateKeyPath );
		if ( cfg.passphrase ) {
			opts.passphrase = cfg.passphrase;
		}
	} else {
		opts.password = cfg.password;
	}
	return opts;
}

function shQuote( s ) {
	return `'${ String( s ).replace( /'/g, `'\\''` ) }'`;
}

function execRemote( root, cfg, command, Client, input = null ) {
	const keyProblem = checkKeyFile( cfg );
	if ( keyProblem ) {
		return Promise.reject( new Error( keyProblem ) );
	}
	assertAuthAllowed( root, cfg );
	const hk = {};
	return new Promise( ( resolve, reject ) => {
		const conn = new Client();
		conn.on( 'ready', () => {
			recordAuth( root, cfg, true );
			const full = `cd ${ shQuote( cfg.cwd ) } && ${ command }`;
			conn.exec( full, ( err, stream ) => {
				if ( err ) {
					conn.end();
					reject( err );
					return;
				}
				let out = '';
				let errOut = '';
				stream.on( 'data', ( d ) => {
					out += d;
				} );
				stream.stderr.on( 'data', ( d ) => {
					errOut += d;
				} );
				if ( input ) {
					stream.end( input );
				}
				stream.on( 'close', ( code ) => {
					conn.end();
					if ( out ) {
						process.stdout.write( out );
					}
					if ( errOut ) {
						process.stderr.write( errOut );
					}
					if ( code ) {
						reject( new Error( `exit ${ code }` ) );
					} else {
						resolve();
					}
				} );
			} );
		} );
		conn.on( 'error', ( e ) => {
			if ( hk.hostKeyChanged ) {
				reject( hostKeyError( cfg, hk ) );
				return;
			}
			if ( isAuthError( e ) ) {
				recordAuth( root, cfg, false );
			}
			const why = diagnose( e, cfg );
			reject( new Error( why ? `${ e.message } — ${ why }` : e.message ) );
		} );
		conn.connect( { ...authOpts( cfg ), hostVerifier: hostVerifier( root, cfg, hk ) } );
	} );
}

// Доступы и секреты во ввод команды не отправляем.
const SECRET_FILE = /(^|[\\/])(\.vscode[\\/]|\.env|wp-config|\.ssh[\\/])|\.(pem|key|ppk)$|id_(rsa|ed25519)/i;

function readStdinFile( file, root ) {
	const path = resolve( root, file );
	if ( SECRET_FILE.test( path ) ) {
		throw new Error( `--stdin: ${ file } — доступы и секреты на сервер не отправляем.` );
	}
	if ( ! existsSync( path ) ) {
		throw new Error( `--stdin: нет файла ${ file }` );
	}
	return readFileSync( path );
}

function parseArgs( argv ) {
	const dash = argv.indexOf( '--' );
	const si = argv.indexOf( '--stdin' );
	const stdin = si >= 0 && ( dash < 0 || si < dash ) ? argv[ si + 1 ] : null;
	if ( si >= 0 && ( dash < 0 || si < dash ) && ( ! stdin || stdin === '--' ) ) {
		throw new Error( 'Нужно: --stdin <файл> -- <команда>, например: --stdin draft.html -- wp post update 123 -' );
	}
	if ( dash >= 0 ) {
		// Одна строка — команда оболочки как есть (конвейер, кавычки); несколько аргументов — каждый в кавычках,
		// иначе пробелы и апострофы в значениях (--post_title="пам'яті …") теряются при склейке.
		const parts = argv.slice( dash + 1 );
		const cmd = ( parts.length === 1 ? parts[ 0 ] : parts.map( ( a ) => ( /^[\w@%+=:,./-]+$/.test( a ) ? a : shQuote( a ) ) ).join( ' ' ) ).trim();
		if ( ! cmd ) {
			throw new Error( 'После -- нужна команда, например: -- wp cache flush' );
		}
		return { mode: 'run', cmd, stdin };
	}
	const mode = argv[ 2 ] || '';
	if ( mode === 'test' ) {
		return { mode: 'test' };
	}
	throw new Error( 'Команда: test | -- <cmd>' );
}

try {
	ensureDeps();
	const { Client } = await import( 'ssh2' );
	const root = repoRoot();
	const args = parseArgs( process.argv );
	const input = args.stdin ? readStdinFile( args.stdin, root ) : null;
	const cfg = loadConfig( root );
	if ( args.mode === 'test' ) {
		const probe = [
			'pwd',
			`if command -v ${ cfg.wpCli } >/dev/null 2>&1; then echo WP-CLI:yes; ${ cfg.wpCli } --info | head -n 5; else echo WP-CLI:no; fi`,
		].join( '; ' );
		await execRemote( root, cfg, probe, Client );
		console.log( 'OK', cfg.host, cfg.cwd );
	} else {
		await execRemote( root, cfg, args.cmd, Client, input );
	}
} catch ( err ) {
	const msg = err instanceof Error ? err.message : String( err );
	console.error( msg.replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
