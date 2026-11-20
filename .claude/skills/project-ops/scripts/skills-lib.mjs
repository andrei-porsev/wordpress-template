/**
 * Общее для skills-sync и template-update: хеш содержимого скилла, скачивание из апстрима по закреплённому коммиту,
 * проверка скачанного на опасные места. Сеть — только git (clone / fetch во временную папку).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const SKIP_NAMES = new Set( [ '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini' ] );

// Файлы каталога: posix-пути относительно dir, отсортированы.
export function listFiles( dir, prefix = '' ) {
	const out = [];
	for ( const entry of readdirSync( join( dir, prefix ), { withFileTypes: true } ) ) {
		if ( SKIP_NAMES.has( entry.name ) ) {
			continue;
		}
		const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name;
		if ( entry.isDirectory() ) {
			out.push( ...listFiles( dir, rel ) );
		} else if ( entry.isFile() ) {
			out.push( rel );
		}
	}
	return out.sort();
}

// CRLF → LF для текстовых файлов: git на Windows с autocrlf не должен давать «локальные правки».
export function fileHash( path ) {
	let buf = readFileSync( path );
	if ( ! buf.includes( 0 ) ) {
		buf = Buffer.from( buf.toString( 'latin1' ).replace( /\r\n/g, '\n' ), 'latin1' );
	}
	return createHash( 'sha256' ).update( buf ).digest( 'hex' );
}

export function fileMap( dir ) {
	const map = {};
	for ( const rel of listFiles( dir ) ) {
		map[ rel ] = fileHash( join( dir, rel ) );
	}
	return map;
}

export function dirHash( dir ) {
	const h = createHash( 'sha256' );
	for ( const [ rel, sum ] of Object.entries( fileMap( dir ) ) ) {
		h.update( `${ rel }\0${ sum }\n` );
	}
	return h.digest( 'hex' ).slice( 0, 16 );
}

export function git( args, options = {} ) {
	return execFileSync( 'git', [ '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', ...args ], {
		encoding: 'utf8',
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		timeout: 30000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...options,
	} ).trim();
}

export const tempDir = () => mkdtempSync( join( tmpdir(), 'skills-sync-' ) );

// Путь скилла «.» — скилл в корне репозитория.
export const treeRef = ( p, rev = 'HEAD' ) => ( p === '.' ? `${ rev }:` : `${ rev }:${ p }` );

const sparse = ( paths ) => paths.map( ( p ) => ( p === '.' ? '/*' : `/${ p }/` ) );

function treesOf( dir, paths ) {
	const trees = {};
	for ( const p of paths ) {
		try {
			trees[ p ] = git( [ '-C', dir, 'rev-parse', treeRef( p ) ] );
		} catch {
			trees[ p ] = null;
		}
	}
	return trees;
}

// Скилл из корня копируется вместе с папкой — служебный .git в копию не идёт.
function dropGit( dir, paths ) {
	if ( paths.includes( '.' ) ) {
		rmSync( join( dir, '.git' ), { recursive: true, force: true } );
	}
}

/**
 * Рабочая копия нужных путей на вершине ветки источника. Возвращает { dir, commit, trees }; dir удалить после работы.
 */
export function checkoutHead( src, paths, timeout ) {
	const dir = tempDir();
	const opt = timeout ? { timeout } : {};
	git( [ 'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', src.ref, src.repo, dir ], opt );
	git( [ '-C', dir, 'sparse-checkout', 'set', '--no-cone', ...sparse( paths ) ] );
	git( [ '-C', dir, 'checkout', '--quiet' ], opt );
	const trees = treesOf( dir, paths );
	const commit = git( [ '-C', dir, 'rev-parse', 'HEAD' ] );
	dropGit( dir, paths );
	return { dir, commit, trees };
}

/**
 * Рабочая копия нужных путей ровно на коммите commit. Коммита в апстриме нет — исключение.
 */
export function checkoutCommit( src, commit, paths ) {
	const dir = tempDir();
	try {
		git( [ 'init', '--quiet', dir ] );
		git( [ '-C', dir, 'remote', 'add', 'origin', src.repo ] );
		git( [ '-C', dir, 'sparse-checkout', 'set', '--no-cone', ...sparse( paths ) ] );
		git( [ '-C', dir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit ] );
		git( [ '-C', dir, 'checkout', '--quiet', 'FETCH_HEAD' ] );
		if ( git( [ '-C', dir, 'rev-parse', 'HEAD' ] ) !== commit ) {
			throw new Error( `получен не тот коммит, ждали ${ commit.slice( 0, 7 ) }` );
		}
	} catch ( e ) {
		rmSync( dir, { recursive: true, force: true } );
		throw e;
	}
	const trees = treesOf( dir, paths );
	dropGit( dir, paths );
	return { dir, commit, trees };
}

// Пути из skill.exclude (относительно папки скилла) удаляются из скачанной копии до сравнения и копирования.
export function pruneExcluded( dir, exclude = [] ) {
	for ( const rel of exclude ) {
		const target = resolve( dir, rel );
		if ( target.startsWith( resolve( dir ) + ( process.platform === 'win32' ? '\\' : '/' ) ) ) {
			rmSync( target, { recursive: true, force: true } );
		}
	}
}

/**
 * Скачивает скиллы ровно в закреплённой версии (commit) и сверяет tree и hash из манифеста.
 * Возвращает { ok: { имя: каталог }, failed: { имя: причина }, cleanup }; cleanup() удаляет временные папки.
 */
export function fetchPinned( m, names ) {
	const ok = {};
	const failed = {};
	const dirs = [];
	const groups = {};
	for ( const name of names ) {
		const skill = m.skills?.[ name ];
		const src = skill && m.sources?.[ skill.source ];
		if ( ! skill || ! src || ! skill.commit || ! skill.hash ) {
			failed[ name ] = 'в манифесте нет источника или закреплённой версии (commit, hash)';
			continue;
		}
		( groups[ `${ skill.source }@${ skill.commit }` ] ||= { src, commit: skill.commit, names: [] } ).names.push( name );
	}
	for ( const g of Object.values( groups ) ) {
		let got;
		try {
			got = checkoutCommit( g.src, g.commit, g.names.map( ( n ) => m.skills[ n ].path ) );
			dirs.push( got.dir );
		} catch ( e ) {
			for ( const n of g.names ) {
				failed[ n ] = `не скачан коммит ${ g.commit.slice( 0, 7 ) } из ${ g.src.repo }: ${ String( e.stderr || e.message || e ).trim().split( '\n' ).pop() }`;
			}
			continue;
		}
		for ( const n of g.names ) {
			const skill = m.skills[ n ];
			const dir = join( got.dir, skill.path );
			if ( ! got.trees[ skill.path ] || ! existsSync( dir ) ) {
				failed[ n ] = `в коммите ${ g.commit.slice( 0, 7 ) } нет ${ skill.path }`;
			} else if ( skill.tree && got.trees[ skill.path ] !== skill.tree ) {
				failed[ n ] = `tree не совпал с манифестом (${ got.trees[ skill.path ].slice( 0, 12 ) } ≠ ${ skill.tree.slice( 0, 12 ) })`;
			} else {
				pruneExcluded( dir, skill.exclude );
				const hash = dirHash( dir );
				if ( hash !== skill.hash ) {
					failed[ n ] = `hash содержимого не совпал с манифестом (${ hash } ≠ ${ skill.hash })`;
				} else {
					ok[ n ] = dir;
				}
			}
		}
	}
	return { ok, failed, cleanup: () => dirs.forEach( ( d ) => rmSync( d, { recursive: true, force: true } ) ) };
}

// Сравнение двух каталогов скилла: добавленные, удалённые, изменённые файлы.
export function diffDirs( oldDir, newDir ) {
	const a = oldDir && existsSync( oldDir ) ? fileMap( oldDir ) : {};
	const b = fileMap( newDir );
	const out = [];
	for ( const rel of Object.keys( b ) ) {
		if ( ! ( rel in a ) ) {
			out.push( `+ ${ rel }` );
		} else if ( a[ rel ] !== b[ rel ] ) {
			out.push( `~ ${ rel }` );
		}
	}
	for ( const rel of Object.keys( a ) ) {
		if ( ! ( rel in b ) ) {
			out.push( `- ${ rel }` );
		}
	}
	return out;
}

// --- Проверка содержимого скилла ---

const SCRIPT_EXT = new Set( [ '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.php', '.rb', '.pl' ] );
const EXEC_EXT = new Set( [ '.exe', '.dll', '.so', '.dylib', '.bin', '.phar', '.jar', '.wasm', '.node', '.msi', '.app' ] );
const MEDIA_EXT = new Set( [ '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf' ] );

// Во всех текстовых файлах: попытки изменить поведение агента и запуск скачанного кода.
const TEXT_RULES = [
	[ 'указание агенту обойти правила', /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|other|system|user'?s?)\s+(instructions|rules|prompts?|guidelines)/i ],
	[ 'скрыть действия от пользователя', /\b(do\s+not|don'?t|never)\s+(tell|inform|notify|alert)\s+the\s+user|\bwithout\s+(telling|informing|notifying)\s+the\s+user|\bwithout\s+the\s+user'?s\s+(knowledge|consent)/i ],
	[ 'обход защиты агента', /\b(bypass|circumvent|get\s+around)\s+(the\s+)?(hooks?|permissions?|safety|sandbox|guard(rail)?s?|approvals?)|\b(disable|turn\s+off|skip)\s+(the\s+)?(permissions?|sandbox|safety\s+checks?|approvals?)\b|--no-verify|dangerously-?skip-?permissions|dangerouslyDisableSandbox/i ],
	[ 'правка настроек Claude Code', /\.claude[\\/]settings(\.local)?\.json|\.claude[\\/]hooks[\\/]/i ],
	[ 'указание агенту по-русски', /игнорируй\s+(все\s+)?(прежние|предыдущие|остальные)?\s*(инструкции|правила)|не\s+(говори|сообщай)\s+пользователю|без\s+ведома\s+пользователя/i ],
	[ 'скачать и сразу выполнить', /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b|\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(iex|Invoke-Expression)\b/i ],
];

// Только в скриптах: сеть, запуск команд, удаление, секреты, закодированный код.
const SCRIPT_RULES = [
	[ 'сетевой запрос', /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b|\bfetch\s*\(|\brequests\.(get|post|put|patch|delete|request)\b|urllib\.request|\burlopen\s*\(|http\.client|\bhttps?\.(request|get)\s*\(|XMLHttpRequest|new\s+WebSocket|\bsocket\.(socket|connect)|file_get_contents\s*\(\s*['"]https?:/i ],
	[ 'запуск команд', /child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bsubprocess\b|os\.(system|popen|exec\w*)\s*\(|\beval\s*\(|new\s+Function\s*\(|Invoke-Expression|\biex\b|Start-Process|shell_exec|\bpassthru\s*\(|proc_open/i ],
	[ 'удаление файлов', /\brm\s+-[a-z]*[rf]|\brmSync\b|\brmdirSync\b|\bunlinkSync\b|shutil\.rmtree|os\.(remove|unlink|rmdir)\s*\(|Remove-Item|\bdel\s+\/[sqf]|\brd\s+\/s/i ],
	[ 'доступ к секретам', /(^|[^\w])\.env\b|(read\w*|open|file_get_contents|Get-Content|cat)\b[^\n]*wp-config|id_rsa|id_ed25519|[\\/]\.ssh[\\/]|ACCESS\.md|sftp\.json|ssh\.json|\.npmrc|\.git-credentials|credentials\.json/i ],
	[ 'закодированный код', /base64\s*(\.|-)?\s*(b64)?decode|\batob\s*\(|Buffer\.from\([^)]*['"]base64['"]|String\.fromCharCode\s*\((\s*\d+\s*,){8}|(\\x[0-9a-f]{2}){12}/i ],
];

// Невидимые символы: нулевой ширины, смена направления текста, теги Unicode.
const HIDDEN = /[​-‍⁠⁦-⁩‪-‮]|﻿(?!^)|\uDB40[\uDC00-\uDC7F]/;

/**
 * Проверка скилла. Возвращает { findings: [{ file, line, kind, text }], scripts: [пути] }.
 * findings — места, которые без «да» пользователя не подключаются; scripts — сведения о скриптах.
 */
export function scanSkill( dir ) {
	const findings = [];
	const scripts = [];
	for ( const rel of listFiles( dir ) ) {
		const ext = extname( rel ).toLowerCase();
		const buf = readFileSync( join( dir, rel ) );
		if ( EXEC_EXT.has( ext ) ) {
			findings.push( { file: rel, line: 0, kind: 'исполняемый файл', text: '' } );
			continue;
		}
		if ( buf.includes( 0 ) ) {
			if ( ! MEDIA_EXT.has( ext ) ) {
				findings.push( { file: rel, line: 0, kind: 'бинарный файл', text: '' } );
			}
			continue;
		}
		const isScript = SCRIPT_EXT.has( ext ) || buf.subarray( 0, 2 ).toString() === '#!';
		if ( isScript ) {
			scripts.push( rel );
		}
		const rules = isScript ? [ ...TEXT_RULES, ...SCRIPT_RULES ] : TEXT_RULES;
		const lines = buf.toString( 'utf8' ).split( /\r?\n/ );
		lines.forEach( ( text, i ) => {
			if ( HIDDEN.test( i === 0 ? text.replace( /^﻿/, '' ) : text ) ) {
				findings.push( { file: rel, line: i + 1, kind: 'скрытые символы', text: text.replace( HIDDEN, '⟨?⟩' ) } );
			}
			for ( const [ kind, re ] of rules ) {
				if ( re.test( text ) ) {
					findings.push( { file: rel, line: i + 1, kind, text } );
				}
			}
		} );
	}
	return { findings, scripts };
}

// Строки отчёта о находках (не больше max).
export function formatFindings( findings, max = 40 ) {
	const out = findings.slice( 0, max ).map( ( f ) => `  ! ${ f.kind }: ${ f.file }${ f.line ? `:${ f.line }` : '' }${ f.text ? ` — ${ f.text.trim().slice( 0, 160 ) }` : '' }` );
	if ( findings.length > max ) {
		out.push( `  … ещё ${ findings.length - max }` );
	}
	return out;
}

// Отпечаток набора находок: одинаковый набор в шаблоне и проекте — один и тот же отпечаток.
export function findingsKey( findings ) {
	const h = createHash( 'sha256' );
	for ( const f of findings ) {
		h.update( `${ f.file }\0${ f.kind }\0${ f.text.trim() }\n` );
	}
	return h.digest( 'hex' ).slice( 0, 16 );
}
