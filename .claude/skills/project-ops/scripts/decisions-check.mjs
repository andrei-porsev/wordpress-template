/**
 * Проверка журналов решений (решение 064): одна тема — одна запись.
 * Цепочки «уточняет / дополняет», отменённые записи в журнале, расхождение таблицы «Действующие» и журнала,
 * ссылки на несуществующие файлы; в `content-types/*.md` и `qa/QA.md` — строки-уточнения в разделе «Решения».
 * Только чтение.
 *   node .claude/skills/project-ops/scripts/decisions-check.mjs [файл…] [--strict]
 * Без файлов — `project-base/DECISIONS.md`, `content-types/*.md`, `qa/QA.md`; в самом шаблоне (нет `.claude/template.json`) — и `.claude/template/DECISIONS.md`.
 * `--strict` — код выхода 1, если есть замечания.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CHAIN = /уточня|уточнен|дополня|дополнен/i;
const CANCELLED = /^(отмен|заменен|объедин)/i;
const PATH_START = /^(\.claude|project-base|\.vscode|wp-content|markup)\//;
const ROOT_FILES = new Set( [ 'CLAUDE.md', 'ACCESS.md', 'phpcs.xml.dist', '.mcp.json', '.gitignore', '.stylelintrc.json' ] );
// Создаются в проекте, в самом шаблоне их нет.
const PROJECT_MADE = /^(\.claude\/\.state|\.claude\/template\.json|\.claude\/product-marketing\.md|project-base\/(design|content-types|qa|tasks|screenshots|dumps|themes\/[^_]|plugins\/[^_])|\.vscode\/(sftp-stage|ssh-stage|local|sftp-ftp)\.json|markup\/|wp-content\/)/;
// Строка говорит об удалённом — путь в ней ссылкой не считается.
const GONE = /удал|убран|больше нет|раньше|прежн|вместо/i;

const strict = process.argv.includes( '--strict' );
const args = process.argv.slice( 2 ).filter( ( a ) => ! a.startsWith( '--' ) );
const root = process.cwd();
const isTemplate = ! existsSync( join( root, '.claude', 'template.json' ) );

const rel = ( p ) => relative( root, p ).split( '\\' ).join( '/' );

/** Раздел `## <имя>` до следующего заголовка второго уровня. */
function section( text, name ) {
	const parts = text.split( /^## /m );
	const hit = parts.find( ( p ) => p.startsWith( name ) );
	return hit ? hit.slice( name.length ) : '';
}

/** Номера из первой колонки таблицы. */
function tableNumbers( block ) {
	return new Set( [ ...block.matchAll( /^\|\s*(\d{3})\s*\|/gm ) ].map( ( m ) => m[ 1 ] ) );
}

/** Записи журнала `## NNN — дата — название`. */
function journal( text ) {
	const entries = [];
	const re = /^## (\d{3}) — (\S+) — (.+)$/gm;
	const heads = [ ...text.matchAll( re ) ];
	heads.forEach( ( m, i ) => {
		const end = i + 1 < heads.length ? heads[ i + 1 ].index : text.length;
		const body = text.slice( m.index, end ).split( /^(?:---|## (?!\d{3} ))/m )[ 0 ];
		const status = ( body.match( /^- \*\*Статус:\*\*\s*(.+)$/m ) || [] )[ 1 ] || '';
		entries.push( { num: m[ 1 ], title: m[ 3 ].trim(), body, status: status.trim() } );
	} );
	return entries;
}

function missingPaths( body, templateJournal ) {
	const found = new Set();
	for ( const line of body.split( '\n' ) ) {
		if ( GONE.test( line ) ) {
			continue;
		}
		for ( const m of line.matchAll( /`([^`\s]+)`/g ) ) {
			const p = m[ 1 ].replace( /[.,;:]+$/, '' ).replace( /\/$/, '' );
			if ( ! ( PATH_START.test( p ) || ROOT_FILES.has( p ) ) || /[<>{}*…|[\]]/.test( p ) ) {
				continue;
			}
			if ( templateJournal && PROJECT_MADE.test( p ) ) {
				continue;
			}
			if ( ! existsSync( join( root, p ) ) ) {
				found.add( p );
			}
		}
	}
	return [ ...found ];
}

function checkDecisions( file, templateJournal ) {
	// Образцы записи в комментарии и блоке кода — не записи.
	const text = readFileSync( file, 'utf8' ).replace( /<!--[\s\S]*?-->/g, '' ).replace( /^```[\s\S]*?^```/gm, '' );
	const notes = [];
	const entries = journal( text );
	const active = new Set();
	for ( const e of entries ) {
		if ( CANCELLED.test( e.status ) ) {
			notes.push( `${ e.num }: отменённая запись в журнале — убрать, строку оставить в «Отменённые и объединённые»` );
			continue;
		}
		active.add( e.num );
		if ( CHAIN.test( e.title ) || CHAIN.test( e.status ) ) {
			const refs = [ ...`${ e.title } ${ e.status }`.matchAll( /\b(\d{3})\b/g ) ].map( ( m ) => m[ 1 ] ).filter( ( n ) => n !== e.num );
			notes.push( `${ e.num }: цепочка${ refs.length ? ` с ${ refs.join( ', ' ) }` : '' } — склеить в одну запись` );
		}
		const gone = missingPaths( e.body, templateJournal );
		if ( gone.length ) {
			notes.push( `${ e.num }: нет файлов — ${ gone.join( ', ' ) }` );
		}
	}
	const listed = tableNumbers( section( text, 'Действующие' ) );
	const dropped = tableNumbers( section( text, 'Отменённые' ) );
	for ( const n of active ) {
		if ( ! listed.has( n ) ) {
			notes.push( `${ n }: есть в журнале, нет в таблице «Действующие»` );
		}
		if ( dropped.has( n ) ) {
			notes.push( `${ n }: и в журнале, и в «Отменённые» — оставить одно` );
		}
	}
	for ( const n of listed ) {
		if ( ! active.has( n ) ) {
			notes.push( `${ n }: в таблице «Действующие», записи в журнале нет` );
		}
	}
	return { notes, count: active.size };
}

function checkLog( file ) {
	const block = section( readFileSync( file, 'utf8' ), 'Решения' );
	const notes = [];
	block.split( '\n' ).filter( ( l ) => /^- /.test( l ) && CHAIN.test( l ) ).forEach( ( l ) => {
		notes.push( `строка-уточнение в «Решения» — переписать прежнюю строку: ${ l.slice( 2, 90 ) }` );
	} );
	return { notes, count: 0 };
}

function defaultFiles() {
	const files = [];
	if ( isTemplate ) {
		files.push( join( root, '.claude', 'template', 'DECISIONS.md' ) );
	}
	files.push( join( root, 'project-base', 'DECISIONS.md' ) );
	const types = join( root, 'project-base', 'content-types' );
	if ( existsSync( types ) ) {
		readdirSync( types ).filter( ( n ) => n.endsWith( '.md' ) && n !== 'README.md' ).forEach( ( n ) => files.push( join( types, n ) ) );
	}
	files.push( join( root, 'project-base', 'qa', 'QA.md' ) );
	return files.filter( ( f ) => existsSync( f ) );
}

const files = args.length ? args.map( ( a ) => join( root, a ) ) : defaultFiles();
let total = 0;
const out = [];
for ( const file of files ) {
	if ( ! existsSync( file ) ) {
		out.push( `${ rel( file ) }: файла нет` );
		total++;
		continue;
	}
	const name = rel( file );
	const isJournal = /(^|\/)DECISIONS\.md$/.test( name );
	const { notes } = isJournal ? checkDecisions( file, name === '.claude/template/DECISIONS.md' ) : checkLog( file );
	if ( notes.length ) {
		out.push( `${ name }:` );
		notes.forEach( ( n ) => out.push( `  ${ n }` ) );
		total += notes.length;
	}
}
console.log( total ? `Решения — замечаний ${ total } (решение 064, правило consistency → «Решения»):\n${ out.join( '\n' ) }` : `Решения: замечаний нет (${ files.length } файл.).` );
process.exit( strict && total ? 1 : 0 );
