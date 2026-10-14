/**
 * SSH: .vscode/ssh.json, пустые поля — из sftp.json.
 * Пароль в stdout не пишем.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
		'Нет зависимостей. Один раз: npm install --prefix .claude/skills/project-ops'
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

function execRemote( cfg, command, Client ) {
	return new Promise( ( resolve, reject ) => {
		const conn = new Client();
		conn.on( 'ready', () => {
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
		conn.on( 'error', reject );
		conn.connect( authOpts( cfg ) );
	} );
}

function parseArgs( argv ) {
	const dash = argv.indexOf( '--' );
	if ( dash >= 0 ) {
		const cmd = argv.slice( dash + 1 ).join( ' ' ).trim();
		if ( ! cmd ) {
			throw new Error( 'После -- нужна команда, например: -- wp cache flush' );
		}
		return { mode: 'run', cmd };
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
	const cfg = loadConfig( root );
	const args = parseArgs( process.argv );
	if ( args.mode === 'test' ) {
		const probe = [
			'pwd',
			`if command -v ${ cfg.wpCli } >/dev/null 2>&1; then echo WP-CLI:yes; ${ cfg.wpCli } --info | head -n 5; else echo WP-CLI:no; fi`,
		].join( '; ' );
		await execRemote( cfg, probe, Client );
		console.log( 'OK', cfg.host, cfg.cwd );
	} else {
		await execRemote( cfg, args.cmd, Client );
	}
} catch ( err ) {
	const msg = err instanceof Error ? err.message : String( err );
	console.error( msg.replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
