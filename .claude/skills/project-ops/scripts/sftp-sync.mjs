/**
 * SFTP/FTP из .vscode/sftp.json (или sftp-ftp.json).
 * Пароль в stdout/stderr не пишем — иначе всплывёт в чат агента.
 * Снимок последней синхронизации — .claude/.state/sync-<конфиг>.json: по нему compare отличает чужие правки от своих.
 */
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.mjs';

const skillDir = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const SKIP_DIRS = new Set( [
	'node_modules',
	'vendor',
	'.git',
	'.claude',
	'.cursor',
	'project-base',
] );
const SKIP_FILES = new Set( [
	'.DS_Store',
	'Thumbs.db',
	'desktop.ini',
] );
const KEEP_PARENTS = new Set( [
	'wp-content',
	'wp-content/themes',
	'wp-content/plugins',
	'wp-content/mu-plugins',
] );

function repoRoot() {
	const cwd = process.cwd();
	if ( existsSync( join( cwd, '.vscode', 'sftp.json' ) ) ) {
		return cwd;
	}
	throw new Error( 'Запускай из корня репозитория (нет .vscode/sftp.json).' );
}

function ensureDeps() {
	if ( existsSync( join( skillDir, 'node_modules', 'ssh2-sftp-client' ) ) ) {
		return;
	}
	throw new Error(
		'Нет зависимостей. Один раз: node .claude/skills/project-ops/scripts/install-deps.mjs'
	);
}

function pick( ...vals ) {
	for ( const v of vals ) {
		if ( v !== undefined && v !== null && String( v ).trim() !== '' ) {
			return v;
		}
	}
	return '';
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

function loadConfig( root ) {
	let fileName = process.env.SFTP_CONFIG || 'sftp.json';
	const settingsPath = join( root, '.vscode', 'settings.json' );
	if ( existsSync( settingsPath ) ) {
		const settings = parseJsonc( readFileSync( settingsPath, 'utf8' ) );
		if ( settings[ 'sftp.config' ] && ! process.env.SFTP_CONFIG ) {
			fileName = settings[ 'sftp.config' ];
		}
	}
	const cfgPath = join( root, '.vscode', fileName );
	if ( ! existsSync( cfgPath ) ) {
		throw new Error( `Нет ${ fileName }. Заполни доступ (SFTP) или скопируй example для FTP.` );
	}
	const sftp = readJson( cfgPath );
	const ssh = fileName === 'sftp.json' ? readJson( join( root, '.vscode', 'ssh.json' ) ) : {};
	const raw = {
		...sftp,
		host: pick( sftp.host, ssh.host ),
		port: pick( sftp.port, ssh.port ) || sftp.port,
		username: pick( sftp.username, ssh.username ),
		password: pick( sftp.password, ssh.password ),
		privateKeyPath: pick( sftp.privateKeyPath, ssh.privateKeyPath ),
		passphrase: pick( sftp.passphrase, ssh.passphrase ),
		remotePath: pick( sftp.remotePath, ssh.cwd ),
	};
	if ( raw.protocol === 'local' ) {
		raw.configName = fileName;
		return raw;
	}
	if ( ! raw.host ) {
		throw new Error( 'host пустой — заполни sftp.json или ssh.json и ACCESS.md.' );
	}
	if ( ! raw.username ) {
		throw new Error( 'username пустой — заполни sftp.json / ssh.json.' );
	}
	if ( ! raw.password && ! raw.privateKeyPath ) {
		throw new Error( 'Нет password и нет privateKeyPath — заполнить одно из двух.' );
	}
	raw.configName = fileName;
	return raw;
}

// Хеш содержимого; у текста CRLF → LF, чтобы рабочая копия Windows не «отличалась» от сервера.
function hashOf( buf ) {
	const sample = buf.subarray( 0, 8000 );
	const text = ! sample.includes( 0 );
	const data = text ? Buffer.from( buf.toString( 'utf8' ).replace( /\r\n/g, '\n' ), 'utf8' ) : buf;
	return createHash( 'sha1' ).update( data ).digest( 'hex' );
}

function snapshotPath( root, cfg ) {
	const name = String( cfg.configName || 'sftp.json' ).replace( /\.json$/, '' );
	return join( root, '.claude', '.state', `sync-${ name }.json` );
}

function loadSnapshot( root, cfg ) {
	const path = snapshotPath( root, cfg );
	if ( ! existsSync( path ) ) {
		return null;
	}
	try {
		return JSON.parse( readFileSync( path, 'utf8' ) );
	} catch {
		return null;
	}
}

function saveSnapshot( root, cfg, snap ) {
	const path = snapshotPath( root, cfg );
	mkdirSync( dirname( path ), { recursive: true } );
	snap.updated = new Date().toISOString();
	writeFileSync( path, JSON.stringify( snap, null, '\t' ) + '\n' );
}

// Файл совпадает с сервером: запомнить хеш и размер/время на сервере (по ним compare не качает неизменённое).
function remember( snap, rel, hash, remote ) {
	snap.files[ rel ] = { hash, size: remote?.size ?? null, mtime: remote?.mtime ?? null };
}

function toPosix( rel ) {
	return rel.split( sep ).join( '/' ).replace( /^\.?\//, '' );
}

function remoteOf( cfg, rel ) {
	const base = String( cfg.remotePath || '/' ).replace( /\/+$/, '' ) || '';
	return posix.join( base, toPosix( rel ) );
}

function localOf( root, rel ) {
	return resolve( root, toPosix( rel ) );
}

function whitelistRoots( ignore ) {
	const roots = [];
	for ( const p of ignore || [] ) {
		if ( ! p.startsWith( '!/' ) || p.includes( '*' ) ) {
			continue;
		}
		const rel = p.slice( 2 ).replace( /\/+$/, '' );
		if ( KEEP_PARENTS.has( rel ) ) {
			continue;
		}
		if ( rel.includes( '{' ) ) {
			console.warn( 'Пропуск плейсхолдера в ignore:', rel );
			continue;
		}
		roots.push( rel );
	}
	return [ ...new Set( roots ) ];
}

function skipName( name, isDir ) {
	if ( isDir ) {
		return SKIP_DIRS.has( name );
	}
	if ( SKIP_FILES.has( name ) ) {
		return true;
	}
	return /\.(log|tmp|temp|bak|md)$/i.test( name );
}

function walkLocal( dir, root, acc = [] ) {
	if ( ! existsSync( dir ) ) {
		return acc;
	}
	for ( const name of readdirSync( dir ) ) {
		const full = join( dir, name );
		const st = statSync( full );
		if ( skipName( name, st.isDirectory() ) ) {
			continue;
		}
		if ( st.isDirectory() ) {
			walkLocal( full, root, acc );
		} else {
			acc.push( toPosix( relative( root, full ) ) );
		}
	}
	return acc;
}

function authOpts( cfg ) {
	const opts = {
		host: cfg.host,
		port: cfg.port || ( cfg.protocol === 'ftp' || cfg.protocol === 'ftps' ? 21 : 22 ),
		username: cfg.username,
	};
	if ( cfg.privateKeyPath ) {
		opts.privateKey = readFileSync( cfg.privateKeyPath );
		if ( cfg.passphrase ) {
			opts.passphrase = cfg.passphrase;
		}
	} else if ( cfg.password ) {
		opts.password = cfg.password;
	}
	if ( cfg.connectTimeout ) {
		opts.readyTimeout = cfg.connectTimeout;
	}
	return opts;
}

async function withSftp( cfg, fn ) {
	const SftpClient = ( await import( 'ssh2-sftp-client' ) ).default;
	const sftp = new SftpClient();
	await sftp.connect( authOpts( cfg ) );
	try {
		return await fn( {
			async existsType( remote ) {
				const t = await sftp.exists( remote );
				if ( t === 'd' ) {
					return 'dir';
				}
				return t ? 'file' : false;
			},
			async exists( remote ) {
				return Boolean( await sftp.exists( remote ) );
			},
			async mkdir( remote ) {
				await sftp.mkdir( remote, true );
			},
			async uploadFile( local, remote ) {
				await sftp.mkdir( posix.dirname( remote ), true );
				await sftp.fastPut( local, remote );
			},
			async downloadFile( remote, local ) {
				mkdirSync( dirname( local ), { recursive: true } );
				await sftp.fastGet( remote, local );
			},
			async read( remote ) {
				return await sftp.get( remote );
			},
			async remove( remote ) {
				await sftp.delete( remote );
			},
			async list( remote ) {
				try {
					return await sftp.list( remote );
				} catch {
					return null;
				}
			},
		} );
	} finally {
		await sftp.end();
	}
}

async function withFtp( cfg, fn ) {
	const { Client } = await import( 'basic-ftp' );
	const client = new Client( cfg.connectTimeout || 20000 );
	const secure = cfg.protocol === 'ftps' || cfg.secure === true;
	await client.access( {
		host: cfg.host,
		port: cfg.port || 21,
		user: cfg.username,
		password: cfg.password,
		secure,
		secureOptions: cfg.secureOptions,
	} );
	try {
		return await fn( {
			async existsType( remote ) {
				try {
					const parent = posix.dirname( remote );
					const name = posix.basename( remote );
					const list = await client.list( parent === '.' ? '/' : parent );
					const item = list.find( ( i ) => i.name === name );
					if ( ! item ) {
						return false;
					}
					return item.isDirectory ? 'dir' : 'file';
				} catch {
					return false;
				}
			},
			async exists( remote ) {
				return Boolean( await this.existsType( remote ) );
			},
			async mkdir( remote ) {
				await client.ensureDir( remote );
				await client.cd( '/' );
			},
			async uploadFile( local, remote ) {
				await client.ensureDir( posix.dirname( remote ) );
				await client.cd( '/' );
				await client.uploadFrom( local, remote );
			},
			async downloadFile( remote, local ) {
				mkdirSync( dirname( local ), { recursive: true } );
				await client.downloadTo( local, remote );
			},
			async read( remote ) {
				const chunks = [];
				const sink = new PassThrough();
				sink.on( 'data', ( c ) => chunks.push( c ) );
				await client.downloadTo( sink, remote );
				return Buffer.concat( chunks );
			},
			async remove( remote ) {
				await client.remove( remote );
			},
			async list( remote ) {
				try {
					return await client.list( remote );
				} catch {
					return null;
				}
			},
		} );
	} finally {
		client.close();
	}
}

// protocol: local — «сервер» в папке remotePath на этой машине (проверка логики compare / deploy без сервера).
async function withLocal( cfg, fn ) {
	const at = ( remote ) => resolve( remote );
	return await fn( {
		async existsType( remote ) {
			if ( ! existsSync( at( remote ) ) ) {
				return false;
			}
			return statSync( at( remote ) ).isDirectory() ? 'dir' : 'file';
		},
		async exists( remote ) {
			return existsSync( at( remote ) );
		},
		async mkdir( remote ) {
			mkdirSync( at( remote ), { recursive: true } );
		},
		async uploadFile( local, remote ) {
			mkdirSync( dirname( at( remote ) ), { recursive: true } );
			writeFileSync( at( remote ), readFileSync( local ) );
		},
		async downloadFile( remote, local ) {
			mkdirSync( dirname( local ), { recursive: true } );
			writeFileSync( local, readFileSync( at( remote ) ) );
		},
		async read( remote ) {
			return readFileSync( at( remote ) );
		},
		async remove( remote ) {
			unlinkSync( at( remote ) );
		},
		async list( remote ) {
			if ( ! existsSync( at( remote ) ) ) {
				return null;
			}
			return readdirSync( at( remote ) ).map( ( name ) => {
				const st = statSync( join( at( remote ), name ) );
				return { name, type: st.isDirectory() ? 'd' : '-', size: st.size, modifyTime: st.mtimeMs };
			} );
		},
	} );
}

function isFtp( cfg ) {
	return cfg.protocol === 'ftp' || cfg.protocol === 'ftps';
}

function withClient( cfg, fn ) {
	if ( cfg.protocol === 'local' ) {
		return withLocal( cfg, fn );
	}
	return isFtp( cfg ) ? withFtp( cfg, fn ) : withSftp( cfg, fn );
}

function entryType( item ) {
	if ( item.type === 'd' || item.type === 2 || item.isDirectory ) {
		return 'dir';
	}
	return 'file';
}

// Размер и время изменения из листинга: SFTP — modifyTime (мс), FTP — modifiedAt (Date).
function entryMeta( item ) {
	const t = item.modifyTime ?? ( item.modifiedAt ? item.modifiedAt.getTime() : null );
	return { size: item.size ?? null, mtime: t ?? null };
}

// Все файлы под remoteDir с размером и временем: { rel: { size, mtime } }.
async function walkRemoteMeta( api, remoteDir, baseRemote, acc = {} ) {
	const list = await api.list( remoteDir );
	if ( ! list ) {
		return acc;
	}
	for ( const item of list ) {
		const kind = entryType( item );
		if ( item.name === '.' || item.name === '..' || skipName( item.name, kind === 'dir' ) ) {
			continue;
		}
		const remote = posix.join( remoteDir, item.name );
		if ( kind === 'dir' ) {
			await walkRemoteMeta( api, remote, baseRemote, acc );
		} else {
			acc[ posix.relative( baseRemote, remote ) ] = entryMeta( item );
		}
	}
	return acc;
}

async function walkRemote( api, remoteDir, baseRemote, acc = [] ) {
	const list = await api.list( remoteDir );
	if ( ! list ) {
		return acc;
	}
	for ( const item of list ) {
		const name = item.name;
		const kind = entryType( item );
		if ( skipName( name, kind === 'dir' ) ) {
			continue;
		}
		const remote = posix.join( remoteDir, name );
		if ( kind === 'dir' ) {
			await walkRemote( api, remote, baseRemote, acc );
		} else {
			acc.push( posix.relative( baseRemote, remote ) );
		}
	}
	return acc;
}

/*
 * Состояние своих файлов: локально, на сервере и в снимке последней синхронизации.
 * Группы: same, remote (чужие правки), local (не залито), conflict (изменено и там и там), unknown (отличается, снимка нет).
 * У каждого: { rel, kind: changed | added | deleted }.
 */
async function diffState( api, cfg, root, roots ) {
	const snap = loadSnapshot( root, cfg );
	const known = snap?.files || {};
	const groups = { same: [], remote: [], local: [], conflict: [], unknown: [] };
	const remoteHash = {};

	const remoteMeta = {};
	for ( const rel of roots ) {
		const base = remoteOf( cfg, rel );
		const meta = await walkRemoteMeta( api, base, base );
		for ( const [ inner, m ] of Object.entries( meta ) ) {
			remoteMeta[ toPosix( join( rel, inner ) ) ] = m;
		}
	}
	const localFiles = new Set();
	for ( const rel of roots ) {
		for ( const f of walkLocal( localOf( root, rel ), root ) ) {
			localFiles.add( f );
		}
	}

	const all = new Set( [ ...Object.keys( remoteMeta ), ...localFiles, ...Object.keys( known ).filter( ( r ) => roots.some( ( x ) => r === x || r.startsWith( x + '/' ) ) ) ] );
	for ( const rel of [ ...all ].sort() ) {
		const s = known[ rel ];
		const m = remoteMeta[ rel ];
		const lh = localFiles.has( rel ) ? hashOf( readFileSync( localOf( root, rel ) ) ) : null;
		let rh = null;
		if ( m ) {
			// Размер и время на сервере как в снимке — файл там не менялся, качать не нужно.
			rh = s && s.size === m.size && s.mtime === m.mtime && s.mtime !== null ? s.hash : hashOf( await api.read( remoteOf( cfg, rel ) ) );
			remoteHash[ rel ] = { hash: rh, ...m };
		}
		const sh = s?.hash ?? null;
		const kindOf = ( a, b ) => ( a && ! b ? 'added' : ! a && b ? 'deleted' : 'changed' );

		if ( lh === rh ) {
			groups.same.push( { rel, kind: 'same' } );
		} else if ( ! snap ) {
			// Без снимка направление ясно, только если файл есть с одной стороны.
			if ( lh === null ) {
				groups.remote.push( { rel, kind: 'added' } );
			} else if ( rh === null ) {
				groups.local.push( { rel, kind: 'added' } );
			} else {
				groups.unknown.push( { rel, kind: 'changed' } );
			}
		} else if ( lh === sh ) {
			groups.remote.push( { rel, kind: kindOf( rh, sh ) } );
		} else if ( rh === sh ) {
			groups.local.push( { rel, kind: kindOf( lh, sh ) } );
		} else {
			groups.conflict.push( { rel, kind: 'changed' } );
		}
	}
	return { groups, remoteHash, hasSnapshot: Boolean( snap ) };
}

function rootsOrThrow( cfg ) {
	const roots = whitelistRoots( cfg.ignore );
	if ( ! roots.length ) {
		throw new Error( 'Whitelist пуст — сначала project-init (слаги в sftp.json ignore).' );
	}
	return roots;
}

const GROUP_TITLES = {
	remote: 'Изменены на сервере (чужие правки)',
	local: 'Изменены локально (не залиты)',
	conflict: 'Конфликт: изменены и там, и там',
	unknown: 'Отличаются (снимка нет — с какой стороны правка, неизвестно)',
};
const KIND_TITLES = { added: 'новый', deleted: 'удалён', changed: 'изменён' };

function printGroups( groups ) {
	console.log( `Совпадают: ${ groups.same.length }` );
	for ( const key of [ 'remote', 'local', 'conflict', 'unknown' ] ) {
		if ( ! groups[ key ].length ) {
			continue;
		}
		console.log( `${ GROUP_TITLES[ key ] }: ${ groups[ key ].length }` );
		for ( const item of groups[ key ] ) {
			console.log( `  ${ item.rel } — ${ KIND_TITLES[ item.kind ] || item.kind }` );
		}
	}
}

async function cmdCompare( cfg, root, json ) {
	const roots = rootsOrThrow( cfg );
	await withClient( cfg, async ( api ) => {
		const { groups, remoteHash, hasSnapshot } = await diffState( api, cfg, root, roots );
		// Совпадающие — уже синхронны: освежить их размер и время, чтобы следующая сверка их не качала.
		const snap = loadSnapshot( root, cfg ) || { files: {} };
		for ( const { rel } of groups.same ) {
			if ( remoteHash[ rel ] ) {
				remember( snap, rel, remoteHash[ rel ].hash, remoteHash[ rel ] );
			} else {
				delete snap.files[ rel ];
			}
		}
		saveSnapshot( root, cfg, snap );
		if ( json ) {
			console.log( JSON.stringify( { hasSnapshot, groups } ) );
			return;
		}
		if ( ! hasSnapshot ) {
			console.log( 'Снимка синхронизации нет: первая сверка, отличия — без направления.' );
		}
		printGroups( groups );
		const dirty = groups.remote.length + groups.local.length + groups.conflict.length + groups.unknown.length;
		console.log( dirty ? 'ЕСТЬ ОТЛИЧИЯ' : 'OK compare: всё совпадает' );
	} );
}

async function cmdList( cfg, rel ) {
	await withClient( cfg, async ( api ) => {
		const remote = remoteOf( cfg, rel || '' );
		const list = await api.list( remote );
		if ( ! list ) {
			throw new Error( `Нет на сервере: ${ rel || '/' }` );
		}
		for ( const item of list ) {
			if ( item.name === '.' || item.name === '..' ) {
				continue;
			}
			const { size, mtime } = entryMeta( item );
			const when = mtime ? new Date( mtime ).toISOString().slice( 0, 16 ).replace( 'T', ' ' ) : '';
			console.log( `${ entryType( item ) === 'dir' ? 'd' : '-' }  ${ String( size ?? '' ).padStart( 9 ) }  ${ when }  ${ item.name }` );
		}
	} );
}

async function cmdTest( cfg ) {
	await withClient( cfg, async ( api ) => {
		const ok = await api.exists( cfg.remotePath || '/' );
		if ( ! ok ) {
			const list = await api.list( posix.dirname( cfg.remotePath || '/' ) );
			if ( ! list ) {
				throw new Error( 'remotePath недоступен.' );
			}
		}
	} );
	console.log( 'OK', cfg.host, cfg.remotePath );
}

async function cmdUpload( cfg, root, rels ) {
	if ( ! rels.length ) {
		throw new Error( 'Нужен путь: upload <rel> [<rel>…]' );
	}
	const files = [];
	for ( const rel of rels ) {
		const local = localOf( root, rel );
		if ( ! existsSync( local ) ) {
			throw new Error( `Нет локально: ${ rel }` );
		}
		if ( statSync( local ).isDirectory() ) {
			files.push( ...walkLocal( local, root ) );
		} else {
			files.push( toPosix( rel ) );
		}
	}
	const snap = loadSnapshot( root, cfg ) || { files: {} };
	await withClient( cfg, async ( api ) => {
		for ( const rel of files ) {
			const local = localOf( root, rel );
			await api.uploadFile( local, remoteOf( cfg, rel ) );
			// Время на сервере после заливки неизвестно — compare сверит содержимое и допишет его.
			remember( snap, rel, hashOf( readFileSync( local ) ), { size: null, mtime: null } );
			console.log( '↑', rel );
		}
	} );
	saveSnapshot( root, cfg, snap );
	console.log( 'OK upload', files.length );
}

async function cmdDownload( cfg, root, rels ) {
	if ( ! rels.length ) {
		throw new Error( 'Нужен путь: download <rel> [<rel>…]' );
	}
	await withClient( cfg, async ( api ) => {
		let n = 0;
		for ( const rel of rels ) {
			const remote = remoteOf( cfg, rel );
			const kind = await api.existsType( remote );
			if ( kind === 'dir' ) {
				const files = await walkRemote( api, remote, remote );
				for ( const inner of files ) {
					const r = toPosix( join( rel, inner ) );
					await api.downloadFile( posix.join( remote, inner ), localOf( root, r ) );
					console.log( '↓', r );
					n++;
				}
			} else if ( kind === 'file' ) {
				await api.downloadFile( remote, localOf( root, rel ) );
				console.log( '↓', toPosix( rel ) );
				n++;
			} else {
				throw new Error( `Нет на сервере: ${ rel }` );
			}
		}
		console.log( 'OK download', n );
	} );
}

// Забрать один файл в произвольный локальный путь (бэкап перед заливкой). Нет на сервере — код 3.
async function cmdFetch( cfg, rel, out ) {
	if ( ! rel || ! out ) {
		throw new Error( 'Нужно: fetch <rel> <локальный-путь>' );
	}
	await withClient( cfg, async ( api ) => {
		const remote = remoteOf( cfg, rel );
		if ( await api.existsType( remote ) !== 'file' ) {
			console.log( 'MISSING', toPosix( rel ) );
			process.exitCode = 3;
			return;
		}
		await api.downloadFile( remote, resolve( out ) );
		console.log( 'OK fetch', toPosix( rel ) );
	} );
}

// Залить произвольный локальный файл на путь rel (откат из бэкапа).
async function cmdPut( cfg, local, rel ) {
	if ( ! local || ! rel || ! existsSync( local ) ) {
		throw new Error( 'Нужно: put <локальный-файл> <rel>' );
	}
	await withClient( cfg, async ( api ) => {
		await api.uploadFile( resolve( local ), remoteOf( cfg, rel ) );
		console.log( 'OK put', toPosix( rel ) );
	} );
}

// Удалить файл на сервере (откат новой заливки).
async function cmdRemove( cfg, rel ) {
	if ( ! rel ) {
		throw new Error( 'Нужно: remove <rel>' );
	}
	await withClient( cfg, async ( api ) => {
		const remote = remoteOf( cfg, rel );
		if ( await api.existsType( remote ) === 'file' ) {
			await api.remove( remote );
		}
		console.log( 'OK remove', toPosix( rel ) );
	} );
}

// Скачать с сервера только изменённое там; незалитые локальные правки и конфликты не трогать (--force — перезаписать всё).
async function cmdSyncDown( cfg, root, force ) {
	const roots = rootsOrThrow( cfg );
	await withClient( cfg, async ( api ) => {
		const { groups, remoteHash } = await diffState( api, cfg, root, roots );
		const snap = loadSnapshot( root, cfg ) || { files: {} };
		const take = [ ...groups.remote ];
		if ( force ) {
			take.push( ...groups.conflict, ...groups.unknown, ...groups.local.filter( ( i ) => i.kind !== 'added' ) );
		}
		let down = 0;
		let removed = 0;
		for ( const { rel } of take ) {
			if ( remoteHash[ rel ] ) {
				await api.downloadFile( remoteOf( cfg, rel ), localOf( root, rel ) );
				remember( snap, rel, remoteHash[ rel ].hash, remoteHash[ rel ] );
				console.log( '↓', rel );
				down++;
			} else {
				// Удалён на сервере, локально не менялся — удалить и локально (история остаётся в git).
				if ( existsSync( localOf( root, rel ) ) ) {
					unlinkSync( localOf( root, rel ) );
				}
				delete snap.files[ rel ];
				console.log( '✕', rel );
				removed++;
			}
		}
		for ( const { rel } of groups.same ) {
			if ( remoteHash[ rel ] ) {
				remember( snap, rel, remoteHash[ rel ].hash, remoteHash[ rel ] );
			} else {
				delete snap.files[ rel ];
			}
		}
		saveSnapshot( root, cfg, snap );

		const kept = force ? [] : [ ...groups.local, ...groups.conflict, ...groups.unknown ];
		if ( kept.length ) {
			console.log( `Не тронуто (локальные правки или конфликт — решить вручную): ${ kept.length }` );
			for ( const item of kept ) {
				console.log( `  ${ item.rel } — ${ KIND_TITLES[ item.kind ] || item.kind }` );
			}
		}
		console.log( `OK sync-down: скачано ${ down }, удалено ${ removed }, не тронуто ${ kept.length }` );
	} );
}

async function cmdSyncUp( cfg, root ) {
	const roots = whitelistRoots( cfg.ignore );
	if ( ! roots.length ) {
		throw new Error( 'Whitelist пуст — сначала project-init (слаги в sftp.json ignore).' );
	}
	const files = [];
	for ( const rel of roots ) {
		files.push( ...walkLocal( localOf( root, rel ), root ) );
	}
	await withClient( cfg, async ( api ) => {
		for ( const rel of files ) {
			await api.uploadFile( localOf( root, rel ), remoteOf( cfg, rel ) );
			console.log( '↑', rel );
		}
	} );
	console.log( 'OK sync-up', files.length );
}

// --stage: конфиг sftp-stage.json / ssh-stage.json вместо боевого.
if ( process.argv.includes( '--stage' ) ) {
	process.env.SFTP_CONFIG = 'sftp-stage.json';
	process.env.SSH_CONFIG = 'ssh-stage.json';
}
const flags = new Set( process.argv.filter( ( a ) => [ '--force', '--json' ].includes( a ) ) );
const [ , , cmd, ...args ] = process.argv.filter( ( a ) => a !== '--stage' && ! flags.has( a ) );

try {
	ensureDeps();
	const root = repoRoot();
	const cfg = loadConfig( root );
	switch ( cmd ) {
		case 'test':
			await cmdTest( cfg );
			break;
		case 'upload':
			await cmdUpload( cfg, root, args );
			break;
		case 'download':
			await cmdDownload( cfg, root, args );
			break;
		case 'fetch':
			await cmdFetch( cfg, args[ 0 ], args[ 1 ] );
			break;
		case 'put':
			await cmdPut( cfg, args[ 0 ], args[ 1 ] );
			break;
		case 'remove':
			await cmdRemove( cfg, args[ 0 ] );
			break;
		case 'sync-down':
			await cmdSyncDown( cfg, root, flags.has( '--force' ) );
			break;
		case 'sync-up':
			await cmdSyncUp( cfg, root );
			break;
		case 'compare':
			await cmdCompare( cfg, root, flags.has( '--json' ) );
			break;
		case 'list':
			await cmdList( cfg, args[ 0 ] );
			break;
		default:
			throw new Error( 'Команда: test | list | compare | download | upload | fetch | put | remove | sync-down | sync-up' );
	}
} catch ( err ) {
	const msg = err instanceof Error ? err.message : String( err );
	console.error( msg.replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
