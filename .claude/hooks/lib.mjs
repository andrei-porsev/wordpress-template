/**
 * Общее для хуков: stdin, пути, project.json, ACCESS.md, состояние сессии.
 * Хуки не должны ломать работу: любой сбой внутри хука — exit 0 (см. safe()).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export function readInput() {
	try {
		const raw = readFileSync( 0, 'utf8' );
		return raw.trim() ? JSON.parse( raw ) : {};
	} catch {
		return {};
	}
}

export function repoRoot( input ) {
	return resolve( process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() );
}

// Путь файла относительно корня в posix-виде; null — файл вне репозитория.
export function toRel( root, filePath ) {
	if ( ! filePath ) {
		return null;
	}
	const abs = isAbsolute( filePath ) ? filePath : resolve( root, filePath );
	const rel = relative( root, abs ).split( '\\' ).join( '/' );
	if ( rel.startsWith( '..' ) || isAbsolute( rel ) ) {
		return null;
	}
	return rel;
}

export function loadProject( root ) {
	const path = join( root, 'project-base', 'project.json' );
	const empty = { stem: '', themes: [], plugins: [], muPlugins: [], blocks: [] };
	if ( ! existsSync( path ) ) {
		return empty;
	}
	try {
		return { ...empty, ...JSON.parse( readFileSync( path, 'utf8' ) ) };
	} catch {
		return empty;
	}
}

// Значение поля из ACCESS.md: строка вида «- Имя: значение». Прочерк = пусто.
export function accessField( root, name ) {
	const path = join( root, 'ACCESS.md' );
	if ( ! existsSync( path ) ) {
		return '';
	}
	const prefix = `- ${ name }:`;
	for ( const line of readFileSync( path, 'utf8' ).split( '\n' ) ) {
		const t = line.trim();
		if ( t.startsWith( prefix ) ) {
			const v = t.slice( prefix.length ).trim();
			return v === '—' || v === '-' ? '' : v;
		}
	}
	return '';
}

// Первый токен, похожий на URL.
export function firstUrl( text ) {
	for ( const tok of String( text ).split( /[\s`()]+/ ) ) {
		if ( tok.startsWith( 'http://' ) || tok.startsWith( 'https://' ) ) {
			return tok.replace( /\/+$/, '' );
		}
	}
	return '';
}

// guarded-auto | stage-auto | manual | local. Не задан — guarded-auto (решение 012). «manual (local)» — manual.
export function deployMode( root ) {
	const v = accessField( root, 'Режим заливки' ).toLowerCase();
	for ( const m of [ 'guarded-auto', 'stage-auto', 'manual', 'local' ] ) {
		if ( v.startsWith( m ) ) {
			return m;
		}
	}
	return 'guarded-auto';
}

// Конфиг заливки (.vscode/sftp.json и т.п.) или null.
export function deployConfig( root, configName = 'sftp.json' ) {
	try {
		const raw = JSON.parse( readFileSync( join( root, '.vscode', configName ), 'utf8' ) );
		return Array.isArray( raw ) ? raw[ 0 ] : raw;
	} catch {
		return null;
	}
}

// Есть ли в конфиге хост (без него заливать нечем); protocol local — «сервер» в папке.
export function deployConfigured( root, configName = 'sftp.json' ) {
	const cfg = deployConfig( root, configName );
	return Boolean( cfg && ( String( cfg.host || '' ).trim() || cfg.protocol === 'local' ) );
}

// Хеш содержимого как в снимке синхронизации (sftp-sync): у текста CRLF → LF.
export function syncHash( buf ) {
	const text = ! buf.subarray( 0, 8000 ).includes( 0 );
	const data = text ? Buffer.from( buf.toString( 'utf8' ).replace( /\r\n/g, '\n' ), 'utf8' ) : buf;
	return createHash( 'sha1' ).update( data ).digest( 'hex' );
}

// Хеш файла в снимке последней синхронизации (.claude/.state/sync-<конфиг>.json) или null.
export function snapshotHash( root, configName, rel ) {
	try {
		const snap = JSON.parse( readFileSync( join( root, '.claude', '.state', `sync-${ configName.replace( /\.json$/, '' ) }.json` ), 'utf8' ) );
		return snap.files?.[ rel ]?.hash || null;
	} catch {
		return null;
	}
}

// Путь пакета: wp-content/<kind>/<slug>/… → { kind, slug } или null.
export function packageOf( rel ) {
	const parts = rel.split( '/' );
	if ( parts[ 0 ] !== 'wp-content' || parts.length < 4 ) {
		return null;
	}
	if ( ! [ 'themes', 'plugins', 'mu-plugins' ].includes( parts[ 1 ] ) ) {
		return null;
	}
	return { kind: parts[ 1 ], slug: parts[ 2 ] };
}

export function projectSlugs( project, kind ) {
	const key = { themes: 'themes', plugins: 'plugins', 'mu-plugins': 'muPlugins' }[ kind ];
	return Array.isArray( project[ key ] ) ? project[ key ] : [];
}

function statePath( root, sessionId ) {
	return join( root, '.claude', '.state', `${ sessionId || 'default' }.json` );
}

export function loadState( root, sessionId ) {
	try {
		return JSON.parse( readFileSync( statePath( root, sessionId ), 'utf8' ) );
	} catch {
		return { structural: {}, mapTouched: false, reminded: false };
	}
}

export function saveState( root, sessionId, state ) {
	const path = statePath( root, sessionId );
	mkdirSync( join( root, '.claude', '.state' ), { recursive: true } );
	writeFileSync( path, JSON.stringify( state ) );
}

// Журнал действий агента (в git не идёт): заливки, откаты, решения охранников.
export function audit( root, event, data = {} ) {
	try {
		mkdirSync( join( root, '.claude', '.state' ), { recursive: true } );
		const line = JSON.stringify( { t: new Date().toISOString(), event, ...data } );
		appendFileSync( join( root, '.claude', '.state', 'audit.log' ), `${ line }\n` );
	} catch {
		// Журнал не должен ломать работу.
	}
}

// Защитные механизмы агента: править может только человек. Для сопровождения шаблона:
// запуск claude с CLAUDE_TEMPLATE_DEV=1 снимает эту защиту.
export function isGuardrail( rel ) {
	if ( process.env.CLAUDE_TEMPLATE_DEV === '1' ) {
		return false;
	}
	return rel === '.claude/settings.json'
		|| rel === '.claude/settings.local.json'
		|| rel.startsWith( '.claude/hooks/' )
		|| rel === '.git'
		|| rel.startsWith( '.git/' );
}

// Почему правка rel запрещена, или null. Общая проверка для Write/Edit и записи через Bash.
export function pathViolation( root, rel ) {
	if ( ! rel ) {
		return null;
	}
	const first = rel.split( '/' )[ 0 ];
	const isRootWp = ! rel.includes( '/' ) && rel.startsWith( 'wp-' ) && rel.endsWith( '.php' );
	if ( isRootWp || first === 'wp-admin' || first === 'wp-includes' ) {
		return `${ rel } — ядро WordPress / wp-config, не правим.`;
	}
	if ( isGuardrail( rel ) ) {
		return `${ rel } — защитные механизмы агента (хуки, настройки, .git) правит только человек.`;
	}
	if ( first !== 'wp-content' ) {
		return null;
	}
	const pkg = packageOf( rel );
	if ( ! pkg ) {
		return `${ rel } — в wp-content правим только своё: themes/<slug>, plugins/<slug>, mu-plugins/<slug>.`;
	}
	const project = loadProject( root );
	const configured = [ 'themes', 'plugins', 'mu-plugins' ].some( ( k ) => projectSlugs( project, k ).length );
	if ( configured && ! projectSlugs( project, pkg.kind ).includes( pkg.slug ) ) {
		return `${ pkg.kind }/${ pkg.slug } нет в project-base/project.json. Чужой пакет не правим; свой — добавь слаг и запусти gen-whitelist.mjs.`;
	}
	return null;
}

// Текст без содержимого кавычек: '>' внутри SQL или аргумента не считается перенаправлением.
export function unquoted( text ) {
	return text.replace( /"[^"]*"|'[^']*'/g, '""' );
}

// Есть ли перенаправление в файл (кроме /dev/null, 2>&1 и стрелок =>, ->).
export function hasFileRedirect( text ) {
	const t = unquoted( text )
		.replace( /\d*>&\d/g, '' )
		.replace( /&?\d*>>?\s*\/dev\/null/g, '' )
		.replace( /[=-]>/g, '' );
	return t.includes( '>' );
}

// Цели перенаправлений вида «> путь» / «>> путь».
export function redirectTargets( text ) {
	const t = unquoted( text ).replace( /\d*>&\d/g, '' ).replace( /[=-]>/g, '' );
	const out = [];
	for ( const m of t.matchAll( />>?\s*([^\s;&|>]+)/g ) ) {
		if ( m[ 1 ] !== '/dev/null' && m[ 1 ] !== '""' ) {
			out.push( m[ 1 ] );
		}
	}
	return out;
}

// Первое слово сегмента без присваиваний окружения (FOO=bar cmd).
export function firstWord( segment ) {
	return segment.trim().split( /\s+/ ).find( ( w ) => ! /^[A-Za-z_][A-Za-z0-9_]*=/.test( w ) ) || '';
}

// Сегменты цепочки/конвейера.
export function segmentsOf( text ) {
	return text.split( /&&|\|\||;|\||\n/ );
}

// Блокировка: stderr + exit 2 (Claude Code показывает текст агенту).
export function block( message ) {
	process.stderr.write( `${ message }\n` );
	process.exit( 2 );
}

// Обёртка: неожиданный сбой хука ход не блокирует.
export async function safe( fn ) {
	try {
		await fn();
	} catch ( err ) {
		process.stderr.write( `hook: ${ err instanceof Error ? err.message : String( err ) }\n` );
		process.exit( 0 );
	}
}
