/**
 * Общие проверки безопасности и запросы к wordpress.org для session-check.mjs и recon.mjs. Только чтение сервера.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { entryType, remoteOf } from './remote.mjs';

// Файлы ядра, которые сверяем каждую сессию (version.php не берём — отличается у локализаций).
export const CORE_KEY_FILES = [
	'index.php', 'wp-load.php', 'wp-settings.php', 'wp-login.php', 'wp-blog-header.php', 'xmlrpc.php',
	'wp-includes/load.php', 'wp-includes/plugin.php', 'wp-includes/pluggable.php', 'wp-admin/index.php', 'wp-admin/admin.php',
];

export const CORE_ROOT_PHP = new Set( [
	'index.php', 'wp-activate.php', 'wp-blog-header.php', 'wp-comments-post.php', 'wp-config.php', 'wp-config-sample.php', 'wp-cron.php',
	'wp-links-opml.php', 'wp-load.php', 'wp-login.php', 'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php',
] );

// Drop-in в wp-content: object-cache / advanced-cache — кеш, db / sunrise — подмена БД и мультисайт. Неожиданный — повод проверить.
export const DROP_INS = [ 'object-cache.php', 'advanced-cache.php', 'db.php', 'db-error.php', 'install.php', 'maintenance.php', 'sunrise.php', 'php-error.php', 'fatal-error-handler.php' ];

// PHP в uploads, который пишут сами плагины (скомпилированные шаблоны, правила) — не тревога, но считается.
// plugin — известен только при установленном плагине: под знакомые имена маскируется вредоносный код.
const AIOS = 'all-in-one-wp-security-and-firewall';
export const KNOWN_UPLOAD_PHP = [
	{ prefix: 'wp-content/uploads/cache/wpml/twig/', label: 'кеш шаблонов WPML' },
	{ prefix: 'wp-content/uploads/aios/', label: 'правила файервола AIOS', plugin: AIOS },
];

// PHP в корне сайта, который ставят плагины (auto_prepend_file в .user.ini).
export const KNOWN_ROOT_PLUGIN_PHP = { 'aios-bootstrap.php': { label: 'файервол AIOS', plugin: AIOS } };

// mu-plugins, которые ставят плагины сами.
export const KNOWN_MU_PLUGINS = { 'aios-firewall-loader.php': { label: 'загрузчик файервола AIOS', plugin: AIOS } };

const knownFor = ( k, plugins ) => k && ( ! k.plugin || Boolean( plugins?.has( k.plugin ) ) );

// mu-plugins → известные («имя — что это», только при установленном плагине) и неизвестные (выяснить, чьи и зачем).
export function splitMuPlugins( names, plugins = null ) {
	const known = [];
	const unknown = [];
	for ( const name of names ) {
		const k = KNOWN_MU_PLUGINS[ name ];
		knownFor( k, plugins ) ? known.push( `${ name } — ${ k.label }` ) : unknown.push( name );
	}
	return { known, unknown };
}

export const MALWARE_PATTERNS = [
	/eval\s*\(\s*base64_decode/i,
	/eval\s*\(\s*gzinflate/i,
	/eval\s*\(\s*str_rot13/i,
	/assert\s*\(\s*\$_(POST|GET|REQUEST|COOKIE)/i,
	/preg_replace\s*\(\s*['"].*\/e['"]/i,
	/\\x65\\x76\\x61\\x6c/i,
	/(system|passthru|shell_exec)\s*\(\s*\$_(POST|GET|REQUEST)/i,
];
export const MALWARE_GREP = "eval\\s*\\(\\s*(base64_decode|gzinflate|str_rot13)|assert\\s*\\(\\s*\\$_(POST|GET|REQUEST)|(system|passthru|shell_exec)\\s*\\(\\s*\\$_(POST|GET|REQUEST)";

// tar, который распаковывает zip: на Windows — встроенный bsdtar; GNU tar из Git Bash раньше в PATH и zip не умеет.
export function tarBin() {
	if ( process.platform === 'win32' ) {
		const sys = join( process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe' );
		if ( existsSync( sys ) ) {
			return sys;
		}
	}
	return 'tar';
}

export function md5( buf ) {
	return createHash( 'md5' ).update( buf ).digest( 'hex' );
}

// plugins — Set слагов установленных плагинов.
export function splitUploadPhp( files, plugins = null ) {
	const known = {};
	const unknown = [];
	for ( const f of files ) {
		const k = KNOWN_UPLOAD_PHP.find( ( x ) => f.startsWith( x.prefix ) );
		if ( knownFor( k, plugins ) ) {
			known[ k.label ] = ( known[ k.label ] || 0 ) + 1;
		} else {
			unknown.push( f );
		}
	}
	return { known, unknown };
}

export function scanMalware( text ) {
	return MALWARE_PATTERNS.filter( ( re ) => re.test( text ) ).map( ( re ) => re.source );
}

async function getJson( url ) {
	try {
		const res = await fetch( url );
		return { status: res.status, body: await res.json() };
	} catch {
		return { status: 0, body: null };
	}
}

export async function coreChecksums( version ) {
	const { body } = await getJson( `https://api.wordpress.org/core/checksums/1.0/?version=${ encodeURIComponent( version ) }&locale=en_US` );
	return body?.checksums || null;
}

// wordpress.org: { listed: true/false, closed, version } — closed означает, что страница есть, но плагин снят (часто — коммерческий).
export async function wporgInfo( kind, slug ) {
	const action = kind === 'theme' ? 'themes/info/1.2/?action=theme_information' : 'plugins/info/1.2/?action=plugin_information';
	const { status, body } = await getJson( `https://api.wordpress.org/${ action }&request[slug]=${ encodeURIComponent( slug ) }&request[fields][sections]=0` );
	if ( status === 200 && body && ! body.error ) {
		return { listed: true, closed: false, latest: body.version || '' };
	}
	return { listed: false, closed: body?.error === 'closed', latest: '' };
}

export async function pluginChecksums( slug, version ) {
	const { status, body } = await getJson( `https://downloads.wordpress.org/plugin-checksums/${ encodeURIComponent( slug ) }/${ encodeURIComponent( version ) }.json` );
	if ( status !== 200 || ! body?.files ) {
		return null;
	}
	const files = {};
	for ( const [ rel, sums ] of Object.entries( body.files ) ) {
		files[ rel ] = [].concat( sums.md5 || [] );
	}
	return files;
}

// Ключевые файлы ядра против оригинала: { checked, modified[], unreadable[] } или null, если сумм нет.
export async function checkCoreKeyFiles( api, cfg, sums ) {
	if ( ! sums ) {
		return null;
	}
	const modified = [];
	const unreadable = [];
	for ( const rel of CORE_KEY_FILES ) {
		try {
			if ( sums[ rel ] && md5( await api.read( remoteOf( cfg, rel ) ) ) !== sums[ rel ] ) {
				modified.push( rel );
			}
		} catch {
			unreadable.push( rel );
		}
	}
	return { checked: CORE_KEY_FILES.length, modified, unreadable };
}

// PHP в корне, который кладут инструменты разработки, — не тревога.
export const KNOWN_ROOT_PHP = new Set( [ 'local-xdebuginfo.php' ] );

// PHP в корне сайта, которого нет в ядре (кроме известных служебных); known — файлы установленных плагинов («имя — плагин»).
export async function rootExtraPhp( api, cfg, plugins = null, known = [] ) {
	const list = ( await api.list( remoteOf( cfg, '' ) ) ) || [];
	return list.filter( ( i ) => entryType( i ) !== 'dir' && i.name.endsWith( '.php' ) && ! CORE_ROOT_PHP.has( i.name ) && ! KNOWN_ROOT_PHP.has( i.name ) ).map( ( i ) => i.name ).filter( ( name ) => {
		const k = KNOWN_ROOT_PLUGIN_PHP[ name ];
		if ( knownFor( k, plugins ) ) {
			known.push( `${ name } — ${ k.label }` );
			return false;
		}
		return true;
	} );
}

// Папки и файлы редакторов и разработки в корне сайта — в них бывают доступы к серверу (sftp.json, .env).
export const DEV_ROOT = new Set( [ '.vscode', '.cursor', '.idea', '.git', '.env', 'sftp-config.json', '.ftpconfig', 'sftp.json' ] );

export async function rootDevFiles( api, cfg ) {
	const list = ( await api.list( remoteOf( cfg, '' ) ) ) || [];
	return list.filter( ( i ) => DEV_ROOT.has( i.name ) ).map( ( i ) => i.name );
}

export const DEV_ROOT_HINT = 'могут быть доступы: код ответа — HEAD-запросом в браузере (403/404 — закрыто), удалить с сервера — человек';

// PHP в uploads без SSH: обход SFTP на depth уровней.
export async function uploadsPhpBySftp( api, cfg, depth = 2, maxDirs = 300 ) {
	const found = [];
	let dirs = 0;
	const walk = async ( rel, d ) => {
		const list = ( await api.list( remoteOf( cfg, rel ) ) ) || [];
		dirs++;
		for ( const i of list ) {
			if ( i.name.startsWith( '.' ) ) {
				continue;
			}
			if ( entryType( i ) === 'dir' ) {
				if ( d < depth && dirs < maxDirs ) {
					await walk( `${ rel }/${ i.name }`, d + 1 );
				}
			} else if ( i.name.endsWith( '.php' ) && i.name !== 'index.php' ) {
				found.push( `${ rel }/${ i.name }` );
			}
		}
	};
	await walk( 'wp-content/uploads', 0 );
	return { files: found, dirs };
}

// Подозрительное в .htaccess: редиректы на чужие домены, base64, подмешивание PHP, PHP-обработчик для картинок.
export function htaccessFindings( text, siteHost ) {
	const hits = [];
	for ( const line of String( text ).split( '\n' ) ) {
		const t = line.trim();
		if ( ! t || t.startsWith( '#' ) ) {
			continue;
		}
		if ( /auto_(prepend|append)_file/i.test( t ) ) {
			hits.push( `подмешивание PHP: ${ t }` );
		} else if ( /base64/i.test( t ) ) {
			hits.push( `base64: ${ t.slice( 0, 120 ) }` );
		} else if ( /Add(Handler|Type).*(php|x-httpd).*\.(jpe?g|png|gif|ico|txt)/i.test( t ) ) {
			hits.push( `PHP для картинок: ${ t }` );
		} else {
			const m = t.match( /^Rewrite(Rule|Cond).*https?:\/\/([^/\s$]+)/i );
			if ( m && siteHost && ! m[ 2 ].includes( siteHost ) && ! siteHost.includes( m[ 2 ] ) ) {
				hits.push( `редирект на ${ m[ 2 ] }: ${ t.slice( 0, 120 ) }` );
			}
		}
	}
	return hits;
}
