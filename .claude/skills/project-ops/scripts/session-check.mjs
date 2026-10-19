/**
 * Запуск сессии (WORKFLOW.md → 2.1): локальное состояние, сверка своего кода с сервером, версии WP и плагинов против прошлой сессии,
 * быстрая проверка безопасности, обновления скиллов. Только чтение: на сервере ничего не меняет, локально пишет снимки в .claude/.state/.
 * Версии и проверка — через SFTP / FTP, без WP-CLI.
 *   node .claude/skills/project-ops/scripts/session-check.mjs [--stage]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffState, ensureDeps, entryType, git, GROUP_TITLES, KIND_TITLES, loadConfig, remoteOf, repoRoot, rootsOrThrow, withClient } from './remote.mjs';
import { checkCoreKeyFiles, coreChecksums, DEV_ROOT_HINT, rootDevFiles, rootExtraPhp, splitUploadPhp, uploadsPhpBySftp } from './security.mjs';

const scriptsDir = dirname( fileURLToPath( import.meta.url ) );

const out = [];
const say = ( line = '' ) => out.push( line );

function stateFile( root, name ) {
	return join( root, '.claude', '.state', name );
}

function readState( root, name ) {
	const path = stateFile( root, name );
	try {
		return existsSync( path ) ? JSON.parse( readFileSync( path, 'utf8' ) ) : null;
	} catch {
		return null;
	}
}

function writeState( root, name, data ) {
	const path = stateFile( root, name );
	mkdirSync( dirname( path ), { recursive: true } );
	writeFileSync( path, JSON.stringify( data, null, '\t' ) + '\n' );
}

function accessField( root, name ) {
	const path = join( root, 'ACCESS.md' );
	if ( ! existsSync( path ) ) {
		return '';
	}
	const line = readFileSync( path, 'utf8' ).split( '\n' ).find( ( l ) => l.trim().startsWith( `- ${ name }:` ) ) || '';
	const v = line.trim().slice( `- ${ name }:`.length ).trim();
	return v === '—' ? '' : v;
}

// Незакрытые ручные шаги из INDEX.md → «Сделать вручную».
function manualSteps( root ) {
	const path = join( root, 'project-base', 'INDEX.md' );
	if ( ! existsSync( path ) ) {
		return;
	}
	const text = readFileSync( path, 'utf8' );
	const block = ( text.split( /^## Сделать вручную\s*$/m )[ 1 ] || '' ).split( /^## /m )[ 0 ];
	const open = block.split( '\n' ).map( ( l ) => l.trim() ).filter( ( l ) => /^- (\[ \] )?/.test( l ) && ! /^- \[x\]/i.test( l ) && l !== '- —' );
	if ( open.length ) {
		say( `## 🖐 Сделать вручную (${ open.length }) — напомнить пользователю` );
		open.forEach( ( l ) => say( `  ${ l }` ) );
		say();
	}
}

// 0. Локальное состояние.
function localState( root ) {
	say( '## Локально' );
	let dirty = [];
	let ahead = null;
	try {
		dirty = git( root, 'status', '--porcelain' ).split( '\n' ).filter( Boolean );
		const up = spawnSync( 'git', [ 'rev-list', '--count', '@{u}..HEAD' ], { cwd: root, encoding: 'utf8' } );
		ahead = up.status === 0 ? Number( up.stdout.trim() ) : null;
	} catch ( e ) {
		say( `git недоступен: ${ e.message }` );
		return;
	}
	say( dirty.length ? `Незакоммичено: ${ dirty.length } — закоммитить до сверки:` : 'Незакоммиченного нет.' );
	dirty.slice( 0, 15 ).forEach( ( l ) => say( `  ${ l }` ) );
	if ( dirty.length > 15 ) {
		say( `  … ещё ${ dirty.length - 15 }` );
	}
	say( ahead === null ? 'Remote не настроен — `git push` некуда.' : ahead ? `Не запушено коммитов: ${ ahead }.` : 'Всё запушено.' );
}

const header = ( text, key ) => {
	const m = text.match( new RegExp( `^[ \\t/*#@]*${ key }:\\s*(.+)$`, 'mi' ) );
	return m ? m[ 1 ].trim() : '';
};

async function readHead( api, remote ) {
	try {
		return ( await api.read( remote ) ).subarray( 0, 8192 ).toString( 'utf8' );
	} catch {
		return '';
	}
}

// Версии ядра, плагинов, тем, список mu-plugins — по файлам на сервере.
async function collectVersions( api, cfg ) {
	const v = { core: '', plugins: {}, themes: {}, muPlugins: [] };
	const ver = await readHead( api, remoteOf( cfg, 'wp-includes/version.php' ) );
	v.core = ( ver.match( /\$wp_version\s*=\s*'([^']+)'/ ) || [] )[ 1 ] || '';

	const plugins = ( await api.list( remoteOf( cfg, 'wp-content/plugins' ) ) ) || [];
	for ( const item of plugins ) {
		if ( item.name.startsWith( '.' ) || item.name === 'index.php' ) {
			continue;
		}
		if ( entryType( item ) !== 'dir' ) {
			if ( item.name.endsWith( '.php' ) ) {
				const h = await readHead( api, remoteOf( cfg, `wp-content/plugins/${ item.name }` ) );
				if ( header( h, 'Plugin Name' ) ) {
					v.plugins[ item.name.replace( /\.php$/, '' ) ] = header( h, 'Version' ) || '?';
				}
			}
			continue;
		}
		const dir = `wp-content/plugins/${ item.name }`;
		let h = await readHead( api, remoteOf( cfg, `${ dir }/${ item.name }.php` ) );
		if ( ! header( h, 'Plugin Name' ) ) {
			h = '';
			for ( const f of ( ( await api.list( remoteOf( cfg, dir ) ) ) || [] ).filter( ( i ) => i.name.endsWith( '.php' ) ).slice( 0, 12 ) ) {
				const t = await readHead( api, remoteOf( cfg, `${ dir }/${ f.name }` ) );
				if ( header( t, 'Plugin Name' ) ) {
					h = t;
					break;
				}
			}
		}
		v.plugins[ item.name ] = header( h, 'Version' ) || '?';
	}

	const themes = ( await api.list( remoteOf( cfg, 'wp-content/themes' ) ) ) || [];
	for ( const item of themes.filter( ( i ) => entryType( i ) === 'dir' && ! i.name.startsWith( '.' ) ) ) {
		const h = await readHead( api, remoteOf( cfg, `wp-content/themes/${ item.name }/style.css` ) );
		v.themes[ item.name ] = header( h, 'Version' ) || '?';
	}
	const mu = ( await api.list( remoteOf( cfg, 'wp-content/mu-plugins' ) ) ) || [];
	v.muPlugins = mu.map( ( i ) => i.name ).filter( ( n ) => ! n.startsWith( '.' ) && n !== 'index.php' ).sort();
	return v;
}

function diffMap( before, after ) {
	const lines = [];
	for ( const k of Object.keys( { ...before, ...after } ).sort() ) {
		if ( ! ( k in before ) ) {
			lines.push( `  + ${ k } ${ after[ k ] } — новый` );
		} else if ( ! ( k in after ) ) {
			lines.push( `  − ${ k } — удалён` );
		} else if ( before[ k ] !== after[ k ] ) {
			lines.push( `  ${ k }: ${ before[ k ] } → ${ after[ k ] }` );
		}
	}
	return lines;
}

// Переопределения шаблонов Woo в своих темах: путь и @version.
function wooOverrides( root ) {
	const path = join( root, 'project-base', 'project.json' );
	const project = existsSync( path ) ? JSON.parse( readFileSync( path, 'utf8' ) ) : {};
	const found = [];
	for ( const slug of project.themes || [] ) {
		const base = join( root, 'wp-content', 'themes', slug, 'woocommerce' );
		const walk = ( dir ) => {
			if ( ! existsSync( dir ) ) {
				return;
			}
			for ( const name of readdirSync( dir, { withFileTypes: true } ) ) {
				const full = join( dir, name.name );
				if ( name.isDirectory() ) {
					walk( full );
				} else if ( name.name.endsWith( '.php' ) ) {
					const ver = ( readFileSync( full, 'utf8' ).match( /@version\s+([\d.]+)/ ) || [] )[ 1 ] || '?';
					found.push( `${ posix.join( slug, 'woocommerce', posix.relative( base.split( '\\' ).join( '/' ), full.split( '\\' ).join( '/' ) ) ) } @version ${ ver }` );
				}
			}
		};
		walk( base );
	}
	return found;
}

async function versionsSection( api, cfg, root, label ) {
	const now = await collectVersions( api, cfg );
	const name = `versions-${ String( cfg.configName ).replace( /\.json$/, '' ) }.json`;
	const prev = readState( root, name );
	writeState( root, name, { ...now, checked: new Date().toISOString() } );
	say( `WordPress ${ now.core || '?' } · плагинов ${ Object.keys( now.plugins ).length } · тем ${ Object.keys( now.themes ).length } · mu-plugins ${ now.muPlugins.length }` );
	if ( ! prev ) {
		say( `Снимок версий (${ label }) создан — сравнение со следующей сессии.` );
		return { now, prev: null };
	}
	const lines = [];
	if ( prev.core !== now.core ) {
		lines.push( `  WordPress: ${ prev.core } → ${ now.core }` );
	}
	lines.push( ...diffMap( prev.plugins, now.plugins ), ...diffMap( prev.themes, now.themes ) );
	const newMu = now.muPlugins.filter( ( n ) => ! prev.muPlugins.includes( n ) );
	say( lines.length ? `Изменилось с ${ prev.checked.slice( 0, 10 ) }:` : `С ${ prev.checked.slice( 0, 10 ) } версии не менялись.` );
	lines.forEach( ( l ) => say( l ) );
	if ( newMu.length ) {
		say( `⚠️ Новые mu-plugins: ${ newMu.join( ', ' ) } — проверить, кто и зачем поставил.` );
	}
	if ( prev.plugins.woocommerce && now.plugins.woocommerce && prev.plugins.woocommerce !== now.plugins.woocommerce ) {
		const ov = wooOverrides( root );
		if ( ov.length ) {
			say( `⚠️ WooCommerce обновился — сверить @version переопределений в теме (WooCommerce → Статус → Шаблоны):` );
			ov.forEach( ( l ) => say( `  ${ l }` ) );
		}
	}
	return { now, prev };
}

async function quickSecurity( api, cfg, root, core, viaSsh, plugins ) {
	const warn = [];
	const info = [];
	// Ядро: контрольные суммы ключевых файлов с wordpress.org.
	if ( core ) {
		const res = await checkCoreKeyFiles( api, cfg, await coreChecksums( core ) );
		if ( res ) {
			res.modified.forEach( ( rel ) => warn.push( `ядро: ${ rel } отличается от оригинала WordPress ${ core }` ) );
			res.unreadable.forEach( ( rel ) => warn.push( `ядро: ${ rel } не читается` ) );
			info.push( `ядро: ${ res.checked } ключевых файлов сверены с оригиналом` );
		} else {
			info.push( 'ядро: контрольные суммы wordpress.org недоступны — не сверено' );
		}
	}
	// Корень: PHP-файлы, которых нет в ядре.
	const rootKnown = [];
	const extra = await rootExtraPhp( api, cfg, plugins, rootKnown );
	if ( extra.length ) {
		warn.push( `корень сайта: PHP не из ядра — ${ extra.join( ', ' ) }` );
	}
	rootKnown.length && info.push( `корень сайта: ${ rootKnown.join( ', ' ) } (не тревога)` );
	const dev = await rootDevFiles( api, cfg );
	if ( dev.length ) {
		warn.push( `корень сайта: файлы разработки — ${ dev.join( ', ' ) } (${ DEV_ROOT_HINT })` );
	}
	// uploads: PHP там быть не должно (кроме известных кешей плагинов).
	const reportUploads = ( files, how ) => {
		const { known, unknown } = splitUploadPhp( files, plugins );
		if ( unknown.length ) {
			warn.push( `uploads: PHP-файлы (${ unknown.length }) — ${ unknown.slice( 0, 5 ).join( ', ' ) }${ unknown.length > 5 ? ' …' : '' }` );
		}
		const knownText = Object.entries( known ).map( ( [ l, n ] ) => `${ l }: ${ n }` ).join( ', ' );
		info.push( `uploads: ${ how }${ knownText ? ` (не тревога — ${ knownText })` : '' }` );
	};
	if ( viaSsh ) {
		const r = spawnSync( process.execPath, [ join( scriptsDir, 'ssh-exec.mjs' ), ...( process.env.SSH_CONFIG === 'ssh-stage.json' ? [ '--stage' ] : [] ), '--', "grep -rl --include='*.php' '' wp-content/uploads | head -n 2000" ], { cwd: root, encoding: 'utf8' } );
		const files = ( r.stdout || '' ).split( '\n' ).map( ( l ) => l.trim() ).filter( ( l ) => l.endsWith( '.php' ) && ! l.endsWith( '/index.php' ) );
		reportUploads( files, 'проверено по SSH' );
	} else {
		const { files, dirs } = await uploadsPhpBySftp( api, cfg );
		reportUploads( files, `обход SFTP на 2 уровня (${ dirs } папок) — глубже не проверено` );
	}
	say( warn.length ? `🟡 Требует внимания (полная проверка — project-init → recon.md):` : '🟢 Признаков вмешательства не найдено.' );
	warn.forEach( ( w ) => say( `  ${ w }` ) );
	info.forEach( ( l ) => say( `  · ${ l }` ) );
}

async function serverSection( root, configName, label ) {
	process.env.SFTP_CONFIG = configName;
	process.env.SSH_CONFIG = configName === 'sftp-stage.json' ? 'ssh-stage.json' : 'ssh.json';
	let cfg;
	try {
		cfg = loadConfig( root );
	} catch ( e ) {
		say( `## Сервер (${ label })` );
		say( `Не настроен: ${ e.message }` );
		return;
	}
	const ssh = spawnSync( process.execPath, [ join( scriptsDir, 'ssh-exec.mjs' ), ...( label === 'stage' ? [ '--stage' ] : [] ), 'test' ], { cwd: root, encoding: 'utf8' } );
	const viaSsh = ssh.status === 0;
	try {
		await withClient( cfg, async ( api ) => {
			say( `## Сервер (${ label }): ${ cfg.host || cfg.remotePath } · ${ viaSsh ? 'SSH + SFTP' : cfg.protocol || 'sftp' }` );
			let roots = [];
			try {
				roots = rootsOrThrow( cfg );
			} catch ( e ) {
				say( `Сверка кода пропущена: ${ e.message }` );
			}
			if ( roots.length ) {
				const { groups, hasSnapshot } = await diffState( api, cfg, root, roots );
				const dirty = [ 'remote', 'local', 'conflict', 'unknown' ].filter( ( k ) => groups[ k ].length );
				say( dirty.length ? `Свой код: совпадают ${ groups.same.length }, есть отличия:` : `Свой код: совпадает с сервером (${ groups.same.length } файлов).` );
				for ( const k of dirty ) {
					say( `  ${ GROUP_TITLES[ k ] }: ${ groups[ k ].length }` );
					groups[ k ].slice( 0, 10 ).forEach( ( i ) => say( `    ${ i.rel } — ${ KIND_TITLES[ i.kind ] || i.kind }` ) );
				}
				if ( groups.remote.length ) {
					say( '  → sync-down и отдельный коммит «sync: изменения с сервера (не мои)».' );
				}
				if ( [ ...groups.remote, ...groups.conflict, ...groups.unknown ].some( ( i ) => i.rel.endsWith( '.scss' ) ) ) {
					say( '  → среди них SCSS: после sync-down — compile-scss.mjs --check (собран ли CSS на сервере из него, WORKFLOW.md → 2.1).' );
				}
				if ( ! hasSnapshot ) {
					say( '  (снимка синхронизации не было — первая сверка)' );
				}
			}
			const { now } = await versionsSection( api, cfg, root, label );
			await quickSecurity( api, cfg, root, now.core, viaSsh, new Set( Object.keys( now.plugins ) ) );
		} );
	} catch ( e ) {
		say( `## Сервер (${ label })` );
		say( `Нет связи: ${ String( e.message ).replace( /password[=:]\S+/gi, 'password=***' ) } — заливки на ${ label } только после успешной сверки.` );
	}
}

try {
	ensureDeps();
	const root = repoRoot();
	const onlyStage = process.argv.includes( '--stage' );
	manualSteps( root );
	localState( root );
	say();
	if ( ! onlyStage ) {
		await serverSection( root, 'sftp.json', 'прод' );
		say();
	}
	if ( onlyStage || existsSync( join( root, '.vscode', 'sftp-stage.json' ) ) ) {
		await serverSection( root, 'sftp-stage.json', 'stage' );
		say();
	}
	say( '## Обновления' );
	const sk = spawnSync( process.execPath, [ join( scriptsDir, 'skills-sync.mjs' ), 'check', '--hook' ], { cwd: root, encoding: 'utf8' } );
	const skText = ( sk.stdout || '' ).trim();
	say( skText || 'Скиллы и шаблон: обновлений нет (или проверка уже была сегодня).' );
	const mode = accessField( root, 'Режим заливки' );
	say( `Режим заливки: ${ mode || '— (по умолчанию guarded-auto)' }` );
	// Короткий manual на задачу (решение 045): «manual (задача …, с <дата>; после выкатки — <режим>)».
	if ( /^manual\s*\(задача/i.test( mode ) ) {
		say( '  → временный manual: выкатить задачу (sftp-sync.mjs deploy) и вернуть режим — или спросить пользователя, если задача ещё идёт.' );
	}
	console.log( out.join( '\n' ) );
} catch ( e ) {
	console.log( out.join( '\n' ) );
	console.error( e instanceof Error ? e.message : String( e ) );
	process.exit( 1 );
}
