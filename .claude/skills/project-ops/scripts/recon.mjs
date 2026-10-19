/**
 * Разведка и полная проверка безопасности сайта (project-init → recon.md). Только чтение сервера.
 *   node .claude/skills/project-ops/scripts/recon.mjs [--stage] [--deep]   — разведка, целостность, окружение
 *   node .claude/skills/project-ops/scripts/recon.mjs --env-table          — окружения прод / stage / локально рядом
 * Пишет .claude/.state/reports/recon-<конфиг>.json (основа security-check.md и audit.md) и env-<конфиг>.json.
 * --deep — сверка всех файлов плагинов с wordpress.org (долго: качает файлы).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeps, entryType, httpGet, loadConfig, remoteOf, repoRoot, withClient } from './remote.mjs';
import {
	checkCoreKeyFiles, coreChecksums, DEV_ROOT_HINT, DROP_INS, htaccessFindings, MALWARE_GREP, md5, pluginChecksums,
	rootDevFiles, rootExtraPhp, scanMalware, splitUploadPhp, tarBin, uploadsPhpBySftp, wporgInfo,
} from './security.mjs';

const scriptsDir = dirname( fileURLToPath( import.meta.url ) );
const argv = process.argv.slice( 2 );
const isStage = argv.includes( '--stage' );
const deep = argv.includes( '--deep' );

const out = [];
const say = ( line = '' ) => out.push( line );
const red = [];
const yellow = [];
const notes = [];
const progress = ( msg ) => console.error( `… ${ msg }` );

// Параллельно не больше limit задач (SFTP держит несколько запросов на одном соединении).
async function pool( items, limit, fn ) {
	const res = new Array( items.length );
	let next = 0;
	const worker = async () => {
		while ( next < items.length ) {
			const i = next++;
			res[ i ] = await fn( items[ i ], i );
		}
	};
	await Promise.all( Array.from( { length: Math.min( limit, items.length ) }, worker ) );
	return res;
}

/*
 * Списки файлов и md5 на сервере: по SSH — одной командой на дерево (быстро), без SSH — SFTP параллельно.
 * Пути — от корня сайта.
 */
const quote = ( s ) => `'${ String( s ).replace( /'/g, "'\\''" ) }'`;

function makeTree( api, cfg, root, viaSsh ) {
	const sshLines = ( cmd ) => ssh( root, cmd ).text.split( '\n' ).map( ( l ) => l.trim() ).filter( Boolean );
	// Урезанная оболочка (chroot Plesk, shared-хостинг) бывает без find и md5sum — проверить один раз.
	const tools = viaSsh ? sshLines( 'command -v find md5sum ls' ).join( ' ' ) : '';
	const hasFind = /\/find\b/.test( tools );
	const hasMd5 = /\/md5sum\b/.test( tools );
	const hasLs = /\/ls\b/.test( tools );
	// ls -RF: «папка:» — заголовок, имя/ — подпапка, суффиксы * @ | = — тип файла.
	const lsTree = ( rel ) => {
		const files = [];
		let dir = '';
		for ( const line of ssh( root, `ls -RF ${ quote( rel ) } 2>/dev/null` ).text.split( '\n' ) ) {
			const l = line.replace( /\r$/, '' );
			if ( ! l.trim() ) {
				continue;
			}
			if ( l.endsWith( ':' ) && ( l === `${ rel }:` || l.startsWith( `${ rel }/` ) ) ) {
				dir = l.slice( 0, -1 );
				continue;
			}
			if ( l.endsWith( '/' ) ) {
				continue;
			}
			files.push( `${ dir || rel }/${ l.replace( /[*@|=]$/, '' ) }` );
		}
		return files;
	};
	const sftpWalk = async ( rel ) => {
		const files = [];
		let dirs = [ rel ];
		while ( dirs.length ) {
			const lists = await pool( dirs, 8, async ( d ) => [ d, ( await api.list( remoteOf( cfg, d ) ) ) || [] ] );
			dirs = [];
			for ( const [ d, list ] of lists ) {
				for ( const i of list ) {
					if ( i.name === '.' || i.name === '..' ) {
						continue;
					}
					( entryType( i ) === 'dir' ? dirs : files ).push( `${ d }/${ i.name }` );
				}
			}
		}
		return files;
	};
	const byExt = ( list, ext ) => ( ext ? list.filter( ( f ) => f.endsWith( `.${ ext }` ) ) : list );
	return {
		how: ! viaSsh ? 'SFTP' : hasFind ? 'SSH find' : hasLs ? 'SSH ls (find нет)' : 'SFTP (в оболочке нет find и ls)',
		async files( rel, ext = null ) {
			if ( viaSsh && hasFind ) {
				const name = ext ? ` -name '*.${ ext }'` : '';
				return sshLines( `find ${ quote( rel ) } -type f${ name } 2>/dev/null` );
			}
			if ( viaSsh && hasLs ) {
				return byExt( lsTree( rel ), ext );
			}
			return byExt( await sftpWalk( rel ), ext );
		},
		// md5 файлов с кодом (php, js, css, html, json) под rel: { путь: md5 }.
		async md5s( rel, only = null ) {
			const map = {};
			if ( viaSsh && hasFind && hasMd5 ) {
				const lines = sshLines( `find ${ quote( rel ) } -type f \\( -name '*.php' -o -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \\) -exec md5sum {} + 2>/dev/null` );
				for ( const l of lines ) {
					const m = l.match( /^([a-f0-9]{32})\s+\*?(.+)$/ );
					if ( m && ( ! only || only.has( m[ 2 ] ) ) ) {
						map[ m[ 2 ] ] = m[ 1 ];
					}
				}
				return map;
			}
			const files = ( await this.files( rel ) ).filter( ( f ) => /\.(php|js|css|html|json)$/i.test( f ) && ( ! only || only.has( f ) ) );
			await pool( files, 8, async ( f ) => {
				map[ f ] = md5( await api.read( remoteOf( cfg, f ) ) );
			} );
			return map;
		},
	};
}

// .claude/.state/<sub>: reports — отчёты разведки, cache — скачанные оригиналы.
function stateDir( root, sub ) {
	const dir = join( root, '.claude', '.state', sub );
	mkdirSync( dir, { recursive: true } );
	return dir;
}

function accessUrl( root, name ) {
	const path = join( root, 'ACCESS.md' );
	if ( ! existsSync( path ) ) {
		return '';
	}
	const line = readFileSync( path, 'utf8' ).split( '\n' ).find( ( l ) => l.trim().startsWith( `- ${ name }:` ) ) || '';
	const m = line.match( /https?:\/\/[^\s`();]+/ );
	return m ? m[ 0 ].replace( /\/+$/, '' ) : '';
}

function ssh( root, cmd ) {
	const r = spawnSync( process.execPath, [ join( scriptsDir, 'ssh-exec.mjs' ), ...( isStage ? [ '--stage' ] : [] ), '--', cmd ], { cwd: root, encoding: 'utf8', timeout: 180000 } );
	return { ok: r.status === 0, text: ( r.stdout || '' ).trim(), err: ( r.stderr || '' ).trim() };
}

const header = ( text, key ) => {
	const m = text.match( new RegExp( `^[ \\t/*#@]*${ key }:\\s*(.+)$`, 'mi' ) );
	return m ? m[ 1 ].trim() : '';
};

async function readText( api, remote, limit = 8192 ) {
	try {
		const buf = await api.read( remote );
		return limit ? buf.subarray( 0, limit ).toString( 'utf8' ) : buf.toString( 'utf8' );
	} catch {
		return '';
	}
}

// Темы, плагины, mu-plugins, drop-in — по файлам на сервере.
async function inventory( api, cfg ) {
	const inv = { core: '', themes: [], plugins: [], muPlugins: [], dropIns: [] };
	inv.core = ( ( await readText( api, remoteOf( cfg, 'wp-includes/version.php' ) ) ).match( /\$wp_version\s*=\s*'([^']+)'/ ) || [] )[ 1 ] || '';

	for ( const item of ( ( await api.list( remoteOf( cfg, 'wp-content/themes' ) ) ) || [] ) ) {
		if ( entryType( item ) !== 'dir' || item.name.startsWith( '.' ) ) {
			continue;
		}
		const h = await readText( api, remoteOf( cfg, `wp-content/themes/${ item.name }/style.css` ) );
		inv.themes.push( {
			slug: item.name, name: header( h, 'Theme Name' ), version: header( h, 'Version' ), parent: header( h, 'Template' ),
			author: header( h, 'Author' ), updateUri: header( h, 'Update URI' ),
		} );
	}
	const pluginItems = ( ( await api.list( remoteOf( cfg, 'wp-content/plugins' ) ) ) || [] ).filter( ( i ) => ! i.name.startsWith( '.' ) && i.name !== 'index.php' );
	await pool( pluginItems, 6, async ( item ) => {
		let h = '';
		let main = '';
		if ( entryType( item ) === 'dir' ) {
			const dir = `wp-content/plugins/${ item.name }`;
			const files = ( ( await api.list( remoteOf( cfg, dir ) ) ) || [] ).filter( ( i ) => i.name.endsWith( '.php' ) );
			files.sort( ( a, b ) => ( a.name === `${ item.name }.php` ? -1 : b.name === `${ item.name }.php` ? 1 : 0 ) );
			for ( const f of files.slice( 0, 15 ) ) {
				const t = await readText( api, remoteOf( cfg, `${ dir }/${ f.name }` ) );
				if ( header( t, 'Plugin Name' ) ) {
					h = t;
					main = f.name;
					break;
				}
			}
		} else if ( item.name.endsWith( '.php' ) ) {
			h = await readText( api, remoteOf( cfg, `wp-content/plugins/${ item.name }` ) );
			main = item.name;
		}
		if ( ! header( h, 'Plugin Name' ) ) {
			return;
		}
		inv.plugins.push( {
			slug: item.name.replace( /\.php$/, '' ), dir: entryType( item ) === 'dir', main, name: header( h, 'Plugin Name' ), version: header( h, 'Version' ),
			author: header( h, 'Author' ), updateUri: header( h, 'Update URI' ),
		} );
	} );
	inv.plugins.sort( ( a, b ) => a.slug.localeCompare( b.slug ) );
	inv.muPlugins = ( ( await api.list( remoteOf( cfg, 'wp-content/mu-plugins' ) ) ) || [] ).map( ( i ) => i.name ).filter( ( n ) => ! n.startsWith( '.' ) && n !== 'index.php' );
	const wpContent = ( ( await api.list( remoteOf( cfg, 'wp-content' ) ) ) || [] ).map( ( i ) => i.name );
	inv.dropIns = DROP_INS.filter( ( d ) => wpContent.includes( d ) );
	inv.debugLog = ( ( await api.list( remoteOf( cfg, 'wp-content' ) ) ) || [] ).find( ( i ) => i.name === 'debug.log' ) || null;
	return inv;
}

// 1.2.10 против 1.2.9: >0 — a новее.
function cmpVersion( a, b ) {
	const pa = String( a ).split( /[.-]/ ).map( ( x ) => parseInt( x, 10 ) || 0 );
	const pb = String( b ).split( /[.-]/ ).map( ( x ) => parseInt( x, 10 ) || 0 );
	for ( let i = 0; i < Math.max( pa.length, pb.length ); i++ ) {
		if ( ( pa[ i ] || 0 ) !== ( pb[ i ] || 0 ) ) {
			return ( pa[ i ] || 0 ) - ( pb[ i ] || 0 );
		}
	}
	return 0;
}

// Признаки своего кода: префикс проекта в слаге, автор или адрес совпадает с проектом, автора нет.
function ownHints( root ) {
	const hints = [];
	const pj = join( root, 'project-base', 'project.json' );
	if ( existsSync( pj ) ) {
		const p = JSON.parse( readFileSync( pj, 'utf8' ) );
		p.stem && hints.push( p.stem.toLowerCase() );
		[ ...( p.plugins || [] ), ...( p.themes || [] ) ].forEach( ( s ) => hints.push( s.toLowerCase() ) );
	}
	const url = accessUrl( root, 'Публичный URL' );
	url && hints.push( new URL( url ).hostname.replace( /^www\./, '' ).split( '.' )[ 0 ] );
	return hints.filter( Boolean );
}

// Сторонний (wordpress.org) / коммерческий / похоже, свой.
async function classify( inv, root ) {
	const hints = ownHints( root );
	const looksOwn = ( x ) => ! x.author || hints.some( ( h ) => x.slug.toLowerCase().startsWith( h ) || x.author.toLowerCase().includes( h ) );
	await pool( inv.plugins, 6, async ( p ) => {
		p.wporg = await wporgInfo( 'plugin', p.slug );
		p.premiumBuild = p.wporg.listed && p.wporg.latest && cmpVersion( p.version, p.wporg.latest ) > 0;
		if ( p.wporg.listed ) {
			p.kind = p.premiumBuild ? 'премиум-сборка под слагом wordpress.org' : 'wordpress.org';
		} else if ( p.wporg.closed || p.updateUri || /-(pro|premium|business|agency)$/i.test( p.slug ) || ! looksOwn( p ) ) {
			p.kind = 'коммерческий, не с wordpress.org';
		} else {
			p.kind = 'похоже, свой';
		}
	} );
	await pool( inv.themes, 6, async ( t ) => {
		t.wporg = await wporgInfo( 'theme', t.slug );
		t.kind = t.wporg.listed ? 'wordpress.org' : t.updateUri ? 'коммерческий' : t.parent ? 'дочерняя, похоже, своя' : 'похоже, своя или коммерческая';
	} );
}

async function activeTheme( root, cfg, inv, wpcli ) {
	if ( wpcli ) {
		const s = ssh( root, 'wp option get stylesheet' );
		if ( s.ok && s.text ) {
			return { slug: s.text.split( '\n' ).pop().trim(), how: 'WP-CLI' };
		}
	}
	const url = accessUrl( root, isStage ? 'Stage / dev URL' : 'Публичный URL' );
	if ( ! url ) {
		return { slug: '', how: 'нет URL в ACCESS.md' };
	}
	let page = await httpGet( url, cfg, true );
	if ( page.status === null ) {
		// Локальный сервер или холодный кеш отвечает с задержкой — один повтор.
		page = await httpGet( url, cfg, true );
	}
	const refs = [ ...new Set( [ ...String( page.body ).matchAll( /\/wp-content\/themes\/([^/'"?]+)\//g ) ].map( ( m ) => m[ 1 ] ) ) ];
	const child = inv.themes.find( ( t ) => refs.includes( t.slug ) && t.parent );
	if ( child || refs.length ) {
		return { slug: child?.slug || refs[ 0 ], how: 'по HTML главной' };
	}
	// Главная не открылась (пароль, сеть): единственная дочерняя тема почти наверняка активная.
	const children = inv.themes.filter( ( t ) => t.parent );
	const why = `главная ответила ${ page.status ?? 'нет ответа' }`;
	return children.length === 1 ? { slug: children[ 0 ].slug, how: `предположительно — единственная дочерняя (${ why })` } : { slug: '', how: why };
}

// Оригинал темы с wordpress.org → .claude/.state/cache/originals/<slug>-<версия>/<slug>/.
async function originalTheme( root, slug, version ) {
	const base = join( stateDir( root, 'cache' ), 'originals', `${ slug }-${ version }` );
	const dir = join( base, slug );
	if ( existsSync( dir ) ) {
		return dir;
	}
	const res = await fetch( `https://downloads.wordpress.org/theme/${ slug }.${ version }.zip` ).catch( () => null );
	if ( ! res || res.status !== 200 ) {
		return null;
	}
	mkdirSync( base, { recursive: true } );
	const zip = join( base, 'theme.zip' );
	writeFileSync( zip, Buffer.from( await res.arrayBuffer() ) );
	const r = spawnSync( tarBin(), [ '-xf', zip, '-C', base ], { encoding: 'utf8' } );
	return r.status === 0 && existsSync( dir ) ? dir : null;
}

function walkFiles( dir, acc = [], base = dir ) {
	for ( const e of readdirSync( dir, { withFileTypes: true } ) ) {
		const full = join( dir, e.name );
		if ( e.isDirectory() ) {
			walkFiles( full, acc, base );
		} else {
			acc.push( relative( base, full ).split( '\\' ).join( '/' ) );
		}
	}
	return acc;
}

// Тема на сервере против оригинала: изменённые и лишние файлы.
async function compareTheme( tree, root, theme ) {
	const orig = await originalTheme( root, theme.slug, theme.version );
	if ( ! orig ) {
		return { ok: false, note: `оригинал ${ theme.slug } ${ theme.version } с wordpress.org не скачался` };
	}
	const prefix = `wp-content/themes/${ theme.slug }/`;
	const origFiles = new Set( walkFiles( orig ) );
	const remoteFiles = ( await tree.files( prefix.slice( 0, -1 ) ) ).map( ( f ) => f.slice( prefix.length ) );
	if ( ! remoteFiles.length ) {
		return { ok: false, note: `тема ${ theme.slug }: список файлов на сервере пуст (${ tree.how }) — НЕ проверена` };
	}
	const sums = await tree.md5s( prefix.slice( 0, -1 ) );
	const modified = [];
	const added = [];
	for ( const rel of remoteFiles ) {
		if ( ! origFiles.has( rel ) ) {
			added.push( rel );
		} else if ( sums[ prefix + rel ] && sums[ prefix + rel ] !== md5( readFileSync( join( orig, rel ) ) ) ) {
			modified.push( rel );
		}
	}
	return { ok: true, modified, added, total: remoteFiles.length };
}

// Плагин wordpress.org против официальных сумм: лишние PHP (всегда) и изменённые файлы (--deep).
async function comparePlugin( tree, p ) {
	const sums = await pluginChecksums( p.slug, p.version );
	if ( ! sums ) {
		return { ok: false };
	}
	const prefix = `wp-content/plugins/${ p.slug }/`;
	const php = ( await tree.files( prefix.slice( 0, -1 ), 'php' ) ).map( ( f ) => f.slice( prefix.length ) );
	if ( ! php.length ) {
		return { ok: false, empty: true };
	}
	const extraPhp = php.filter( ( rel ) => ! sums[ rel ] );
	const modified = [];
	if ( deep ) {
		const remote = await tree.md5s( prefix.slice( 0, -1 ) );
		for ( const [ path, hash ] of Object.entries( remote ) ) {
			const rel = path.slice( prefix.length );
			if ( sums[ rel ] && ! sums[ rel ].includes( hash ) ) {
				modified.push( rel );
			}
		}
	}
	return { ok: true, extraPhp, modified };
}

// Лишние PHP в wp-admin / wp-includes (нет в оригинале версии).
async function coreExtraFiles( tree, sums ) {
	const php = [ ...await tree.files( 'wp-admin', 'php' ), ...await tree.files( 'wp-includes', 'php' ) ];
	// В ядре сотни PHP: пустой или крошечный список — не «чисто», а сбой листинга.
	if ( php.length < 100 ) {
		return null;
	}
	return php.filter( ( rel ) => ! sums[ rel ] );
}

// Кеш страниц и минификации: после заливки CSS / JS его сбрасывают (project-ops → cache.md).
const CACHE_PLUGINS = {
	'litespeed-cache': 'LiteSpeed Cache',
	'w3-total-cache': 'W3 Total Cache',
	'wp-super-cache': 'WP Super Cache',
	'wp-rocket': 'WP Rocket',
	'sg-cachepress': 'SiteGround Optimizer',
	'wp-optimize': 'WP-Optimize',
	autoptimize: 'Autoptimize',
	'wp-fastest-cache': 'WP Fastest Cache',
	breeze: 'Breeze',
	'cache-enabler': 'Cache Enabler',
	'hummingbird-performance': 'Hummingbird',
	nitropack: 'NitroPack',
};

function envFromHeaders( h ) {
	if ( ! h ) {
		return {};
	}
	const get = ( k ) => h.get( k ) || '';
	const cdn = get( 'cf-ray' ) ? 'Cloudflare' : get( 'x-sucuri-id' ) ? 'Sucuri' : get( 'x-ac' ) || get( 'x-hcdn-request-id' ) ? 'CDN хостинга' : '';
	const cache = [ 'x-cache', 'cf-cache-status', 'x-litespeed-cache', 'x-proxy-cache', 'x-sg-cache', 'x-kinsta-cache', 'x-cache-status' ]
		.filter( ( k ) => get( k ) ).map( ( k ) => `${ k }: ${ get( k ) }` ).join( ', ' );
	return { server: get( 'server' ), poweredBy: get( 'x-powered-by' ), cdn, cache };
}

async function run( root ) {
	process.env.SFTP_CONFIG = isStage ? 'sftp-stage.json' : 'sftp.json';
	process.env.SSH_CONFIG = isStage ? 'ssh-stage.json' : 'ssh.json';
	const cfg = loadConfig( root );
	const envName = isStage ? 'stage' : cfg.protocol === 'local' ? 'local' : 'prod';
	const label = { stage: 'stage', local: 'локально', prod: 'прод' }[ envName ];
	const t = spawnSync( process.execPath, [ join( scriptsDir, 'ssh-exec.mjs' ), ...( isStage ? [ '--stage' ] : [] ), 'test' ], { cwd: root, encoding: 'utf8' } );
	const viaSsh = t.status === 0;
	const wpcli = viaSsh && /WP-CLI:yes/.test( t.stdout || '' );
	const report = { target: label, date: new Date().toISOString(), access: { ssh: viaSsh, wpcli }, findings: {} };

	await withClient( cfg, async ( api ) => {
		say( `# Разведка (${ label }): ${ cfg.host || cfg.remotePath } · ${ viaSsh ? 'SSH + SFTP' : cfg.protocol || 'sftp' } · WP-CLI ${ wpcli ? 'есть' : 'нет' }` );
		const tree = makeTree( api, cfg, root, viaSsh );
		progress( 'состав: темы, плагины, mu-plugins' );
		const inv = await inventory( api, cfg );
		progress( `wordpress.org: ${ inv.plugins.length } плагинов, ${ inv.themes.length } тем` );
		await classify( inv, root );
		const active = await activeTheme( root, cfg, inv, wpcli );
		report.inventory = inv;
		report.activeTheme = active;

		say();
		say( `## Состав — WordPress ${ inv.core || '?' }` );
		say( `Активная тема: ${ active.slug || '—' } (${ active.how })` );
		for ( const th of inv.themes ) {
			say( `  тема ${ th.slug } ${ th.version || '?' }${ th.parent ? ` (дочерняя от ${ th.parent })` : '' } — ${ th.kind }` );
		}
		const byKind = {};
		for ( const p of inv.plugins ) {
			const update = p.wporg.listed && p.wporg.latest && cmpVersion( p.wporg.latest, p.version ) > 0 ? ` → ${ p.wporg.latest }` : '';
			( byKind[ p.kind ] ||= [] ).push( `${ p.slug } ${ p.version || '?' }${ update }` );
		}
		for ( const [ kind, list ] of Object.entries( byKind ) ) {
			say( `Плагины — ${ kind } (${ list.length }): ${ list.join( ', ' ) }` );
		}
		say( `mu-plugins: ${ inv.muPlugins.join( ', ' ) || 'нет' } · drop-in: ${ inv.dropIns.join( ', ' ) || 'нет' }` );
		const own = [
			...inv.themes.filter( ( x ) => x.kind.includes( 'свой' ) || x.kind.includes( 'своя' ) ).map( ( x ) => `тема ${ x.slug }` ),
			...inv.plugins.filter( ( x ) => x.kind === 'похоже, свой' ).map( ( x ) => `плагин ${ x.slug }` ),
		];
		say( `Похоже, свой код (подтвердить у пользователя): ${ own.join( ', ' ) || 'не найден' }` );
		inv.muPlugins.length && yellow.push( `mu-plugins: ${ inv.muPlugins.join( ', ' ) } — выяснить, чьи и зачем` );

		const sums = inv.core ? await coreChecksums( inv.core ) : null;
		if ( wpcli ) {
			const c = ssh( root, 'wp core verify-checksums' );
			( /Success/i.test( c.text + c.err ) ? notes : red ).push( `ядро (WP-CLI): ${ ( c.text || c.err ).split( '\n' ).slice( -1 )[ 0 ] }` );
			const pl = ssh( root, 'wp plugin verify-checksums --all' );
			const bad = ( pl.text + '\n' + pl.err ).split( '\n' ).filter( ( l ) => /checksum does not match|File was added|File is missing/i.test( l ) );
			( bad.length ? red : notes ).push( `плагины (WP-CLI verify-checksums): ${ bad.length ? bad.slice( 0, 10 ).join( '; ' ) : 'совпадают' }` );
		} else {
			progress( 'ядро: ключевые файлы и лишние PHP' );
			const key = await checkCoreKeyFiles( api, cfg, sums );
			if ( key ) {
				key.modified.forEach( ( r ) => red.push( `ядро: ${ r } отличается от оригинала` ) );
				key.unreadable.length && yellow.push( `ядро: не читаются ${ key.unreadable.join( ', ' ) } — НЕ проверены` );
				notes.push( `ядро: ${ key.checked - key.unreadable.length } из ${ key.checked } ключевых файлов сверены` );
				const extra = await coreExtraFiles( tree, sums );
				if ( extra === null ) {
					yellow.push( `ядро: список файлов wp-admin / wp-includes не получен (${ tree.how }) — лишние PHP НЕ проверены` );
				} else {
					extra.length ? red.push( `ядро: лишние PHP — ${ extra.slice( 0, 10 ).join( ', ' ) }` ) : notes.push( `ядро: лишних PHP в wp-admin и wp-includes нет (${ tree.how })` );
				}
			} else {
				notes.push( 'ядро: контрольные суммы недоступны — не сверено' );
			}
			for ( const p of inv.plugins.filter( ( x ) => x.wporg.listed && x.dir && ! x.premiumBuild ) ) {
				progress( `плагин ${ p.slug } ${ p.version }` );
				const res = await comparePlugin( tree, p );
				if ( ! res.ok ) {
					( res.empty ? yellow : notes ).push( res.empty ? `${ p.slug }: список файлов пуст (${ tree.how }) — НЕ проверен` : `${ p.slug } ${ p.version }: сумм на wordpress.org нет — не сверен` );
					continue;
				}
				res.extraPhp.length && red.push( `${ p.slug }: лишние PHP — ${ res.extraPhp.slice( 0, 5 ).join( ', ' ) }` );
				res.modified.length && yellow.push( `${ p.slug }: изменены ${ res.modified.length } файлов — ${ res.modified.slice( 0, 5 ).join( ', ' ) }` );
			}
			notes.push( `плагины wordpress.org: проверены лишние PHP${ deep ? ' и содержимое всех файлов' : ' (содержимое — --deep)' }` );
		}
		// Родитель активной темы и сама активная тема, если они с wordpress.org.
		const checkThemes = inv.themes.filter( ( x ) => x.wporg.listed && ( x.slug === active.slug || inv.themes.some( ( c ) => c.slug === active.slug && c.parent === x.slug ) || deep ) );
		for ( const th of checkThemes ) {
			progress( `тема ${ th.slug } ${ th.version } против оригинала` );
			const res = await compareTheme( tree, root, th );
			if ( ! res.ok ) {
				( /НЕ проверена/.test( res.note ) ? yellow : notes ).push( res.note );
				continue;
			}
			if ( res.modified.length || res.added.filter( ( r ) => r.endsWith( '.php' ) ).length ) {
				yellow.push( `тема ${ th.slug } ${ th.version }: изменено ${ res.modified.length }, добавлено ${ res.added.length } — правки в чужой теме сотрёт обновление: ${ [ ...res.modified, ...res.added ].slice( 0, 8 ).join( ', ' ) }` );
			} else {
				notes.push( `тема ${ th.slug } ${ th.version }: совпадает с оригиналом (${ res.total } файлов)` );
			}
		}

		// Вредоносные шаблоны, uploads, корень, .htaccess.
		progress( 'вредоносные шаблоны, uploads, .htaccess' );
		const slugs = new Set( inv.plugins.map( ( p ) => p.slug ) );
		if ( viaSsh ) {
			const g = ssh( root, `grep -rlE "${ MALWARE_GREP }" --include='*.php' wp-content | grep -v '/uploads/cache/' | head -n 30` );
			const hits = g.text.split( '\n' ).filter( ( l ) => l.endsWith( '.php' ) );
			hits.length ? red.push( `вредоносные шаблоны: ${ hits.join( ', ' ) }` ) : notes.push( 'вредоносные шаблоны в wp-content: не найдены (grep по SSH)' );
			const up = ssh( root, "grep -rl --include='*.php' '' wp-content/uploads | head -n 2000" );
			const { known, unknown } = splitUploadPhp( up.text.split( '\n' ).filter( ( l ) => l.endsWith( '.php' ) && ! l.endsWith( '/index.php' ) ), slugs );
			unknown.length && red.push( `uploads: PHP (${ unknown.length }) — ${ unknown.slice( 0, 5 ).join( ', ' ) }` );
			Object.keys( known ).length && notes.push( `uploads: ${ Object.entries( known ).map( ( [ l, n ] ) => `${ l }: ${ n }` ).join( ', ' ) } — не тревога` );
		} else {
			const { files, dirs } = await uploadsPhpBySftp( api, cfg );
			const { unknown } = splitUploadPhp( files, slugs );
			unknown.length && red.push( `uploads: PHP — ${ unknown.slice( 0, 5 ).join( ', ' ) }` );
			notes.push( `uploads: обход SFTP на 2 уровня (${ dirs } папок)` );
			const toScan = [ ...inv.muPlugins.filter( ( n ) => n.endsWith( '.php' ) ).map( ( n ) => `wp-content/mu-plugins/${ n }` ), ...inv.dropIns.map( ( d ) => `wp-content/${ d }` ) ];
			for ( const rel of toScan ) {
				const hits = scanMalware( await readText( api, remoteOf( cfg, rel ), 0 ) );
				hits.length && red.push( `вредоносные шаблоны: ${ rel }` );
			}
			notes.push( 'вредоносные шаблоны: без SSH проверены только mu-plugins и drop-in' );
		}
		const rootKnown = [];
		const extraRoot = await rootExtraPhp( api, cfg, slugs, rootKnown );
		extraRoot.length && yellow.push( `корень сайта: PHP не из ядра — ${ extraRoot.join( ', ' ) }` );
		// Файлы плагинов в корне известны по имени, содержимое всё равно проверяем.
		for ( const k of rootKnown ) {
			const name = k.split( ' — ' )[ 0 ];
			scanMalware( await readText( api, remoteOf( cfg, name ), 0 ) ).length ? red.push( `вредоносные шаблоны: ${ name }` ) : notes.push( `корень сайта: ${ k } — не тревога, шаблоны не найдены` );
		}
		const devRoot = await rootDevFiles( api, cfg );
		devRoot.length && yellow.push( `корень сайта: файлы разработки — ${ devRoot.join( ', ' ) } (${ DEV_ROOT_HINT })` );
		const siteUrl = accessUrl( root, isStage ? 'Stage / dev URL' : 'Публичный URL' );
		const ht = htaccessFindings( await readText( api, remoteOf( cfg, '.htaccess' ), 0 ), siteUrl ? new URL( siteUrl ).hostname : '' );
		ht.forEach( ( h ) => red.push( `.htaccess: ${ h }` ) );

		if ( wpcli ) {
			const a = ssh( root, 'wp user list --role=administrator --fields=user_login,user_registered --format=csv' );
			const admins = a.text.split( '\n' ).slice( 1 ).filter( Boolean );
			notes.push( `администраторы (${ admins.length }): ${ admins.join( '; ' ) } — незнакомых уточнить у клиента` );
			const su = ssh( root, 'wp option get siteurl' ).text;
			const hm = ssh( root, 'wp option get home' ).text;
			notes.push( `siteurl / home: ${ su } / ${ hm }` );
		} else {
			notes.push( 'администраторы и siteurl / home: без WP-CLI не проверены (админка — пользователь)' );
		}
		notes.push( 'внешние сигналы (Google Safe Browsing, Sucuri SiteCheck) — агент в браузере, с разрешения пользователя' );

		// Окружение.
		const page = siteUrl ? await httpGet( siteUrl, cfg ) : { status: null, headers: null };
		const env = { target: label, date: report.date, wp: inv.core, ...envFromHeaders( page.headers ), status: page.status, dropIns: inv.dropIns };
		if ( wpcli ) {
			env.wpInfo = ssh( root, 'wp --info' ).text.split( '\n' ).filter( ( l ) => /PHP version|MySQL version|OS|Shell/i.test( l ) ).join( ' · ' );
		}
		if ( inv.debugLog ) {
			const size = inv.debugLog.size || 0;
			env.debugLog = `${ Math.round( size / 1024 ) } КБ`;
			if ( size < 2 * 1024 * 1024 ) {
				const lines = ( await readText( api, remoteOf( cfg, 'wp-content/debug.log' ), 0 ) ).split( '\n' );
				const fatal = lines.filter( ( l ) => /PHP (Fatal|Parse)/.test( l ) ).length;
				const warnN = lines.filter( ( l ) => /PHP (Warning|Deprecated|Notice)/.test( l ) ).length;
				env.debugLog += ` · Fatal ${ fatal } · Warning/Deprecated ${ warnN }`;
				fatal && yellow.push( `debug.log: ${ fatal } Fatal — были до нас, записать в аудит` );
			}
		} else {
			env.debugLog = 'нет (WP_DEBUG_LOG выключен или лог в другом месте)';
		}
		writeFileSync( join( stateDir( root, 'reports' ), `env-${ envName }.json` ), JSON.stringify( env, null, '\t' ) + '\n' );
		say();
		say( '## Окружение' );
		say( `Сайт: ${ siteUrl || '— (нет URL)' } → ${ page.status ?? 'нет ответа' }${ page.status === 401 ? ' (закрыт паролем — httpAuth в конфиг)' : '' }` );
		say( `Веб-сервер: ${ env.server || '?' } · PHP: ${ env.poweredBy || env.wpInfo || 'не виден (скрыт сервером)' } · CDN: ${ env.cdn || 'нет' } · кеш: ${ env.cache || 'не виден' }` );
		say( `Drop-in кеша: ${ inv.dropIns.join( ', ' ) || 'нет' } · debug.log: ${ env.debugLog }` );
		const cachePlugins = inv.plugins.filter( ( p ) => CACHE_PLUGINS[ p.slug ] ).map( ( p ) => CACHE_PLUGINS[ p.slug ] );
		say( `Плагины кеша: ${ cachePlugins.join( ', ' ) || 'нет' }${ cachePlugins.length ? ' → ACCESS.md → «Кеш сайта» (project-ops → cache.md)' : '' }` );

		report.findings = { red, yellow, notes };
		report.verdict = red.length ? 'red' : yellow.length ? 'yellow' : 'green';
		writeFileSync( join( stateDir( root, 'reports' ), `recon-${ envName }.json` ), JSON.stringify( report, null, '\t' ) + '\n' );
	} );

	say();
	say( `## Итог: ${ red.length ? '🔴 признаки заражения' : yellow.length ? '🟡 подозрительно' : '🟢 чисто' }` );
	red.forEach( ( l ) => say( `  🔴 ${ l }` ) );
	yellow.forEach( ( l ) => say( `  🟡 ${ l }` ) );
	notes.forEach( ( l ) => say( `  · ${ l }` ) );
	say();
	say( `Отчёт: .claude/.state/reports/recon-${ envName }.json → security-check.md и audit.md (recon.md). Решение по 🟡 / 🔴 — за пользователем.` );
}

function envTable( root ) {
	const dir = join( root, '.claude', '.state', 'reports' );
	const envs = [ 'prod', 'stage', 'local' ].map( ( n ) => join( dir, `env-${ n }.json` ) ).filter( existsSync ).map( ( p ) => JSON.parse( readFileSync( p, 'utf8' ) ) );
	if ( ! envs.length ) {
		console.log( 'Снимков окружения нет — сначала recon.mjs (и с --stage).' );
		return;
	}
	const rows = [ [ 'WordPress', 'wp' ], [ 'Веб-сервер', 'server' ], [ 'PHP', 'poweredBy' ], [ 'WP-CLI --info', 'wpInfo' ], [ 'CDN', 'cdn' ], [ 'Кеш', 'cache' ], [ 'Drop-in', 'dropIns' ], [ 'debug.log', 'debugLog' ], [ 'Снято', 'date' ] ];
	console.log( `| | ${ envs.map( ( e ) => e.target ).join( ' | ' ) } |` );
	console.log( `|---|${ envs.map( () => '---' ).join( '|' ) }|` );
	for ( const [ title, key ] of rows ) {
		const vals = envs.map( ( e ) => ( Array.isArray( e[ key ] ) ? e[ key ].join( ', ' ) : String( e[ key ] ?? '' ) ).slice( 0, 60 ) || '—' );
		const differs = new Set( vals ).size > 1 && key !== 'date';
		console.log( `| ${ differs ? '**' + title + '**' : title } | ${ vals.join( ' | ' ) } |` );
	}
	console.log( 'Жирным — отличается между окружениями: первые кандидаты на «на одном сервере работает, на другом нет».' );
}

try {
	ensureDeps();
	const root = repoRoot();
	if ( argv.includes( '--env-table' ) ) {
		envTable( root );
	} else {
		await run( root );
		console.log( out.join( '\n' ) );
	}
} catch ( e ) {
	console.log( out.join( '\n' ) );
	console.error( String( e instanceof Error ? e.message : e ).replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
