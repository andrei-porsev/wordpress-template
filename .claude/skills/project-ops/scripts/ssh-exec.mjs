/**
 * SSH: .vscode/ssh.json, пустые поля — из sftp.json.
 * Пароль в stdout не пишем.
 * --stdin <файл> — локальный файл во ввод команды на сервере (длинный текст: wp post update <ID> -), на сервер он не записывается.
 * dump [метка] — дамп БД в ../claude-backup/<время>[-метка].sql (вне каталога сайта, права 600); печатает «DUMP <путь>».
 * media <файл> [--name=…] [--title=…] [--alt=…] — картинка в медиатеку со своим именем файла (через ../claude-tmp/, затем удаляется); печатает «MEDIA <ID> <имя>».
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
						resolve( out );
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

// Локальный файл по SFTP в каталог на сервере (относительно cwd), каталог создаётся.
function sftpPut( root, cfg, Client, local, dir, name ) {
	assertAuthAllowed( root, cfg );
	const hk = {};
	const base = `${ cfg.cwd.replace( /\/+$/, '' ) }/${ dir }`;
	return new Promise( ( resolve, reject ) => {
		const conn = new Client();
		conn.on( 'ready', () => {
			recordAuth( root, cfg, true );
			conn.sftp( ( err, sftp ) => {
				if ( err ) {
					conn.end();
					reject( err );
					return;
				}
				sftp.mkdir( base, () => {
					sftp.fastPut( local, `${ base }/${ name }`, ( e ) => {
						conn.end();
						e ? reject( e ) : resolve();
					} );
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

// Дампы БД — на уровень выше каталога сайта: по HTTP недоступны.
const DUMP_DIR = '../claude-backup';

// Фото для медиатеки — временно вне каталога сайта, после импорта удаляется.
const MEDIA_TMP = '../claude-tmp';
const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

// Непрозрачный PNG (фотография) → JPEG 85, не больше 2560 px: в 3–5 раз легче. PNG с прозрачностью (логотип, схема) — как есть.
async function photoAsJpeg( path ) {
	if ( ! /\.png$/i.test( path ) ) {
		return null;
	}
	let sharp;
	try {
		sharp = ( await import( 'sharp' ) ).default;
	} catch {
		console.error( 'media: нет sharp (install-deps.mjs) — PNG загружается без перевода в JPEG.' );
		return null;
	}
	if ( ! ( await sharp( path ).stats() ).isOpaque ) {
		return null;
	}
	const out = join( mkdtempSync( join( tmpdir(), 'media-' ) ), 'photo.jpg' );
	await sharp( path ).rotate().resize( { width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true } ).jpeg( { quality: 85, mozjpeg: true } ).toFile( out );
	return out;
}

// media <файл> [--name=<имя-латиницей>] [--title=…] [--alt=…]: имя файла в медиатеке — своё, а не как у источника.
function parseMedia( argv, root ) {
	const file = argv[ 3 ];
	if ( ! file || file.startsWith( '--' ) ) {
		throw new Error( 'Нужно: media <файл> [--name=…] [--title=…] [--alt=…]' );
	}
	const path = resolve( root, file );
	if ( SECRET_FILE.test( path ) || ! MEDIA_EXT.test( path ) ) {
		throw new Error( `media: ${ file } — только картинки (jpg, png, webp, gif, avif).` );
	}
	if ( ! existsSync( path ) ) {
		throw new Error( `media: нет файла ${ file }` );
	}
	const opt = ( key ) => ( argv.find( ( a ) => a.startsWith( `--${ key }=` ) ) || '' ).slice( key.length + 3 );
	const ext = path.match( MEDIA_EXT )[ 0 ].toLowerCase().replace( '.jpeg', '.jpg' );
	const slug = ( opt( 'name' ) || basename( path ).replace( MEDIA_EXT, '' ) ).toLowerCase().replace( /[^a-z0-9-]+/g, '-' ).replace( /-+/g, '-' ).replace( /^-|-$/g, '' ).slice( 0, 80 );
	if ( ! slug ) {
		throw new Error( 'media: имя файла — латиницей (--name=moleben-lavra-2026-10-12).' );
	}
	return { mode: 'media', path, name: `${ slug }${ ext }`, title: opt( 'title' ), alt: opt( 'alt' ) };
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

function parseArgs( argv, root ) {
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
	if ( mode === 'dump' ) {
		const label = ( argv[ 3 ] || '' ).toLowerCase().replace( /[^a-z0-9-]+/g, '-' ).replace( /^-+|-+$/g, '' ).slice( 0, 40 );
		const stamp = new Date().toISOString().replace( /[-:T]/g, '' ).slice( 0, 14 );
		return { mode: 'dump', file: `${ DUMP_DIR }/${ stamp }${ label ? `-${ label }` : '' }.sql` };
	}
	if ( mode === 'media' ) {
		return parseMedia( argv, root );
	}
	throw new Error( 'Команда: test | dump [метка] | media <файл> | -- <cmd>' );
}

try {
	ensureDeps();
	const { Client } = await import( 'ssh2' );
	const root = repoRoot();
	const args = parseArgs( process.argv, root );
	const input = args.stdin ? readStdinFile( args.stdin, root ) : null;
	const cfg = loadConfig( root );
	if ( args.mode === 'test' ) {
		const probe = [
			'pwd',
			`if command -v ${ cfg.wpCli } >/dev/null 2>&1; then echo WP-CLI:yes; ${ cfg.wpCli } --info | head -n 5; else echo WP-CLI:no; fi`,
		].join( '; ' );
		await execRemote( root, cfg, probe, Client );
		console.log( 'OK', cfg.host, cfg.cwd );
	} else if ( args.mode === 'dump' ) {
		// umask 077: каталог 700 и файл 600 — в дампе хеши паролей пользователей.
		await execRemote( root, cfg, `umask 077 && mkdir -p ${ DUMP_DIR } && wp db export ${ shQuote( args.file ) } --quiet && ls -l ${ shQuote( args.file ) }`, Client );
		console.log( 'DUMP', args.file );
	} else if ( args.mode === 'media' ) {
		const jpeg = await photoAsJpeg( args.path );
		if ( jpeg ) {
			console.error( `media: PNG-фото → JPEG (${ Math.round( statSync( args.path ).size / 1024 ) } → ${ Math.round( statSync( jpeg ).size / 1024 ) } КБ)` );
			args.path = jpeg;
			args.name = args.name.replace( /\.png$/i, '.jpg' );
		}
		await sftpPut( root, cfg, Client, args.path, MEDIA_TMP, args.name );
		const tmp = `${ MEDIA_TMP }/${ args.name }`;
		const flags = [ args.title && `--title=${ shQuote( args.title ) }`, args.alt && `--alt=${ shQuote( args.alt ) }` ].filter( Boolean ).join( ' ' );
		// Временный файл удаляется и при ошибке импорта; код выхода — от импорта.
		const out = await execRemote( root, cfg, `wp media import ${ shQuote( tmp ) } ${ flags } --porcelain; s=$?; rm -f ${ shQuote( tmp ) }; exit $s`, Client );
		console.log( 'MEDIA', ( out.match( /^\d+/m ) || [ '?' ] )[ 0 ], args.name );
	} else {
		await execRemote( root, cfg, args.cmd, Client, input );
	}
} catch ( err ) {
	const msg = err instanceof Error ? err.message : String( err );
	console.error( msg.replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
