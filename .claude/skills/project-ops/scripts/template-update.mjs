/**
 * Обновление проекта до текущей версии шаблона (решение 032). Запуск из папки шаблона:
 *   node .claude/skills/project-ops/scripts/template-update.mjs "<проект>" [--base <коммит>]   пробный прогон, отчёт
 *   … "<проект>" --apply                         применить в ветке template-update (кроме хуков и settings.json)
 *   … "<проект>" --take template|project|merge <путь…>   решить конфликт после --apply
 *   … "<проект>" --done <миграция>               агентская часть миграции выполнена
 *   … "<проект>" --protected                     хуки и settings.json — запускает человек в своём терминале
 *   … . --protected                              ожидающие правки настроек самого шаблона
 * Шаблон берётся из последнего коммита, проект — из рабочей копии (должна быть закоммичена).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const TROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..', '..', '..', '..' );
const SELF = 'node .claude/skills/project-ops/scripts/template-update.mjs';
const LABEL = '.claude/template.json';
const MANIFEST = '.claude/template/manifest.json';
const PENDING = '.claude/template/pending-settings.json';
const BRANCH = 'template-update';
const MARK_START = '# >>> project.json';
const MARK_END = '# <<< project.json';

function fail( message ) {
	console.error( message );
	process.exit( 1 );
}

function git( cwd, args, input ) {
	return execFileSync( 'git', [ '-c', 'core.autocrlf=false', '-C', cwd, ...args ], {
		input,
		maxBuffer: 512 * 1024 * 1024,
		stdio: [ input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe' ],
	} );
}

const gitText = ( cwd, args ) => git( cwd, args ).toString( 'utf8' ).trim();

// Пути и sha файлов коммита.
function lsTree( cwd, commit ) {
	const map = new Map();
	for ( const rec of git( cwd, [ 'ls-tree', '-r', '-z', commit ] ).toString( 'utf8' ).split( '\0' ) ) {
		const m = rec.match( /^\d+ blob ([0-9a-f]+)\t(.+)$/ );
		if ( m ) {
			map.set( m[ 2 ], m[ 1 ] );
		}
	}
	return map;
}

// Содержимое блобов одним вызовом git cat-file --batch.
function readBlobs( cwd, shas ) {
	const uniq = [ ...new Set( shas ) ];
	const out = new Map();
	if ( ! uniq.length ) {
		return out;
	}
	const buf = git( cwd, [ 'cat-file', '--batch' ], uniq.join( '\n' ) + '\n' );
	let pos = 0;
	while ( pos < buf.length ) {
		const nl = buf.indexOf( 10, pos );
		const [ sha, , size ] = buf.subarray( pos, nl ).toString( 'utf8' ).split( ' ' );
		const start = nl + 1;
		out.set( sha, buf.subarray( start, start + Number( size ) ) );
		pos = start + Number( size ) + 1;
	}
	return out;
}

// Текст — CRLF → LF; бинарный файл как есть.
function norm( buf ) {
	if ( buf === null || buf.subarray( 0, 8000 ).includes( 0 ) ) {
		return buf;
	}
	return Buffer.from( buf.toString( 'latin1' ).replace( /\r\n/g, '\n' ), 'latin1' );
}

const same = ( a, b ) => a !== null && b !== null && norm( a ).equals( norm( b ) );
const hashOf = ( buf ) => createHash( 'sha256' ).update( norm( buf ) ).digest( 'hex' );

// Glob: *, **, ? и [!x].
function globRe( glob ) {
	let re = '';
	for ( let i = 0; i < glob.length; i++ ) {
		const c = glob[ i ];
		if ( glob.startsWith( '/**', i ) && i + 3 === glob.length ) {
			re += '(?:/.*)?';
			i += 2;
		} else if ( glob.startsWith( '**/', i ) ) {
			re += '(?:.*/)?';
			i += 2;
		} else if ( glob.startsWith( '**', i ) ) {
			re += '.*';
			i += 1;
		} else if ( c === '*' ) {
			re += '[^/]*';
		} else if ( c === '?' ) {
			re += '[^/]';
		} else if ( c === '[' && glob[ i + 1 ] === '!' ) {
			const end = glob.indexOf( ']', i );
			re += `[^${ glob.slice( i + 2, end ) }/]`;
			i = end;
		} else {
			re += c.replace( /[.+^${}()|\\]/g, '\\$&' );
		}
	}
	return new RegExp( `^${ re }$` );
}

const matcher = ( globs ) => {
	const list = ( globs || [] ).map( globRe );
	return ( p ) => list.some( ( r ) => r.test( p ) );
};

function readFile( root, rel ) {
	const abs = join( root, rel );
	return existsSync( abs ) ? readFileSync( abs ) : null;
}

function writeFile( root, rel, buf ) {
	const abs = join( root, rel );
	mkdirSync( dirname( abs ), { recursive: true } );
	writeFileSync( abs, norm( buf ) );
}

function removeFile( root, rel ) {
	const abs = join( root, rel );
	if ( ! existsSync( abs ) ) {
		return;
	}
	unlinkSync( abs );
	// Пустые каталоги после удаления.
	let dir = dirname( abs );
	while ( dir.startsWith( root ) && dir !== root && ! readdirSync( dir ).length ) {
		rmdirSync( dir );
		dir = dirname( dir );
	}
}

function walk( root, rel ) {
	const abs = join( root, rel );
	if ( ! existsSync( abs ) ) {
		return [];
	}
	const out = [];
	for ( const e of readdirSync( abs, { withFileTypes: true } ) ) {
		const r = `${ rel }/${ e.name }`;
		if ( e.isDirectory() ) {
			out.push( ...walk( root, r ) );
		} else if ( e.isFile() ) {
			out.push( r );
		}
	}
	return out;
}

const listDirs = ( root, rel ) =>
	existsSync( join( root, rel ) ) ? readdirSync( join( root, rel ), { withFileTypes: true } ).filter( ( e ) => e.isDirectory() ).map( ( e ) => e.name ) : [];

const readJson = ( buf, fallback = null ) => ( buf ? JSON.parse( norm( buf ).toString( 'utf8' ) ) : fallback );
const jsonBuf = ( data ) => Buffer.from( JSON.stringify( data, null, '\t' ) + '\n', 'utf8' );

// Трёхстороннее слияние: предок — файл проекта на опорном коммите.
function merge3( ours, base, theirs ) {
	const dir = mkdtempSync( join( tmpdir(), 'template-update-' ) );
	try {
		const f = ( name, buf ) => {
			writeFileSync( join( dir, name ), norm( buf ) );
			return join( dir, name );
		};
		const args = [ 'merge-file', '-p', '-L', 'проект', '-L', 'было', '-L', 'шаблон', f( 'ours', ours ), f( 'base', base ), f( 'theirs', theirs ) ];
		try {
			return { content: execFileSync( 'git', args, { maxBuffer: 64 * 1024 * 1024 } ), conflicts: 0 };
		} catch ( e ) {
			if ( typeof e.status === 'number' && e.status > 0 && e.stdout ) {
				return { content: e.stdout, conflicts: e.status };
			}
			throw e;
		}
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
}

// Блок whitelist из project.json в .gitignore — проектный, остальное — шаблонное.
function gitignoreBlock( buf ) {
	if ( ! buf ) {
		return null;
	}
	const text = norm( buf ).toString( 'utf8' );
	const a = text.indexOf( MARK_START );
	const b = text.indexOf( MARK_END );
	return a >= 0 && b > a ? text.slice( a, b + MARK_END.length ) : null;
}

function withBlock( buf, block ) {
	const own = gitignoreBlock( buf );
	if ( ! buf || ! own || ! block ) {
		return buf;
	}
	return Buffer.from( norm( buf ).toString( 'utf8' ).replace( own, block ), 'utf8' );
}

// --- Шаблон и проект ---

// worktree — рабочая копия шаблона вместо коммита (проверка до коммита).
function loadTemplate( worktree ) {
	const commit = gitText( TROOT, [ 'rev-parse', 'HEAD' ] );
	let tree;
	let file;
	if ( worktree ) {
		tree = new Map( gitText( TROOT, [ 'ls-files', '-co', '--exclude-standard' ] ).split( '\n' ).filter( ( r ) => r && existsSync( join( TROOT, r ) ) ).map( ( r ) => [ r, null ] ) );
		file = ( rel ) => ( tree.has( rel ) ? readFile( TROOT, rel ) : null );
	} else {
		tree = lsTree( TROOT, commit );
		const blobs = readBlobs( TROOT, [ ...tree.values() ] );
		file = ( rel ) => ( tree.has( rel ) ? blobs.get( tree.get( rel ) ) : null );
	}
	const manifest = readJson( file( MANIFEST ) );
	if ( ! manifest ) {
		fail( `В шаблоне нет ${ MANIFEST } в последнем коммите.` );
	}
	const excluded = matcher( manifest.exclude );
	for ( const rel of [ ...tree.keys() ] ) {
		if ( excluded( rel ) ) {
			tree.delete( rel );
		}
	}
	const dirty = gitText( TROOT, [ 'status', '--porcelain' ] ) !== '';
	return { commit, tree, file, manifest, dirty, worktree: Boolean( worktree ), skills: readJson( file( '.claude/skills.json' ), { core: [], stacks: {}, skills: {} } ) };
}

function loadProject( root, flags ) {
	try {
		gitText( root, [ 'rev-parse', '--git-dir' ] );
	} catch {
		fail( `${ root } — не git-репозиторий.` );
	}
	const label = readJson( readFile( root, LABEL ) );
	let base = flags.base;
	if ( ! base && label ) {
		base = gitText( root, [ 'log', '-1', '--format=%H', '--', LABEL ] );
	}
	if ( ! base ) {
		const added = gitText( root, [ 'log', '--diff-filter=A', '--format=%H', '--', '.claude/settings.json' ] ).split( '\n' ).filter( Boolean );
		base = added[ added.length - 1 ];
	}
	if ( ! base ) {
		fail( 'Не найден коммит переноса на шаблон. Укажи опору: --base <коммит>.' );
	}
	base = gitText( root, [ 'rev-parse', base ] );
	const baseTree = lsTree( root, base );
	const blobs = readBlobs( root, [ ...baseTree.values() ] );
	const baseFile = ( rel ) => ( baseTree.has( rel ) ? blobs.get( baseTree.get( rel ) ) : null );

	// С меткой предок — шаблон на коммите прошлого обновления (по пути в шаблоне), иначе — файл проекта на опоре.
	let templateBase = null;
	if ( label?.commit && ! flags.base ) {
		try {
			const tree = lsTree( TROOT, label.commit );
			const tblobs = readBlobs( TROOT, [ ...tree.values() ] );
			templateBase = ( rel ) => ( tree.has( rel ) ? tblobs.get( tree.get( rel ) ) : null );
		} catch {
			templateBase = null;
		}
	}
	const files = git( root, [ 'ls-files', '-z' ] ).toString( 'utf8' ).split( '\0' ).filter( Boolean );
	const status = gitText( root, [ 'status', '--porcelain' ] );
	const branch = gitText( root, [ 'rev-parse', '--abbrev-ref', 'HEAD' ] );
	return { root, label, base, baseFile, templateBase, files, clean: status === '', branch };
}

function blobAt( cwd, commit, rel ) {
	try {
		return git( cwd, [ 'show', `${ commit }:${ rel }` ] );
	} catch {
		return null;
	}
}

// Путь в шаблоне для файла проекта: подключённые копии лежат в шаблоне в *-optional.
function templatePathOf( rel, core ) {
	const m = rel.match( /^\.claude\/skills\/([^/]+)\/(.+)$/ );
	if ( m && ! core.has( m[ 1 ] ) ) {
		return `.claude/skills-optional/${ m[ 1 ] }/${ m[ 2 ] }`;
	}
	return rel;
}

// Файлы проекта под git в каталоге (игнорируемое — node_modules, .state — не в счёт).
const tracked = ( p, dir ) => p.files.filter( ( r ) => r.startsWith( dir + '/' ) );
const trackedDirs = ( p, dir ) => [ ...new Set( tracked( p, dir ).map( ( r ) => r.slice( dir.length + 1 ).split( '/' ) ).filter( ( parts ) => parts.length > 1 ).map( ( parts ) => parts[ 0 ] ) ) ];

// Подключённые стеки: из манифеста проекта или по составу .claude/skills и .claude/rules.
function activeStacks( t, p ) {
	const own = readJson( readFile( p.root, '.claude/skills.json' ) );
	if ( own && Array.isArray( own.active ) ) {
		return { active: own.active, inferred: false };
	}
	const skills = new Set( trackedDirs( p, '.claude/skills' ) );
	const rules = new Set( tracked( p, '.claude/rules' ).map( ( r ) => r.split( '/' ).pop().replace( /\.md$/, '' ) ) );
	const active = Object.entries( t.skills.stacks || {} )
		.filter( ( [ , s ] ) => {
			const items = [ ...( s.skills || [] ).map( ( n ) => skills.has( n ) ), ...( s.rules || [] ).map( ( n ) => rules.has( n ) ) ];
			return items.length > 0 && items.every( Boolean );
		} )
		.map( ( [ id ] ) => id );
	return { active, inferred: true };
}

// Пары «путь в проекте → путь в шаблоне» (null — в шаблоне нет, кандидат на удаление).
function pairs( t, p, stacks ) {
	const isProtected = matcher( t.manifest.protected );
	const isProject = matcher( t.manifest.project );
	const owned = matcher( t.manifest.owned );
	const core = new Set( t.skills.core || [] );
	const out = new Map();
	const add = ( rel, from, kind ) => out.set( rel, { rel, from, kind } );

	for ( const rel of t.tree.keys() ) {
		if ( rel === LABEL || isProject( rel ) ) {
			continue;
		}
		if ( rel.startsWith( '.claude/skills/' ) && ! core.has( rel.split( '/' )[ 2 ] ) ) {
			continue;
		}
		if ( rel.startsWith( '.claude/rules/' ) ) {
			add( rel, rel, 'template' );
			continue;
		}
		add( rel, rel, isProtected( rel ) ? 'protected' : rel === '.gitignore' ? 'gitignore' : rel === '.claude/skills.json' ? 'skills-json' : 'template' );
	}

	// Подключённые копии из *-optional: что есть в проекте + состав активных стеков.
	const optSkills = new Set( [ ...t.tree.keys() ].filter( ( r ) => r.startsWith( '.claude/skills-optional/' ) ).map( ( r ) => r.split( '/' )[ 2 ] ) );
	const optRules = new Set( [ ...t.tree.keys() ].filter( ( r ) => r.startsWith( '.claude/rules-optional/' ) ).map( ( r ) => r.split( '/' )[ 2 ].replace( /\.md$/, '' ) ) );
	const tRules = new Set( [ ...t.tree.keys() ].filter( ( r ) => r.startsWith( '.claude/rules/' ) ).map( ( r ) => r.split( '/' )[ 2 ].replace( /\.md$/, '' ) ) );
	const wantSkills = new Set( trackedDirs( p, '.claude/skills' ).filter( ( n ) => ! core.has( n ) ) );
	const wantRules = new Set( tracked( p, '.claude/rules' ).map( ( r ) => r.split( '/' ).pop().replace( /\.md$/, '' ) ).filter( ( n ) => ! tRules.has( n ) ) );
	for ( const id of stacks.active ) {
		const s = t.skills.stacks?.[ id ] || {};
		( s.skills || [] ).forEach( ( n ) => wantSkills.add( n ) );
		( s.rules || [] ).forEach( ( n ) => wantRules.add( n ) );
	}
	const notes = [];
	for ( const name of wantSkills ) {
		if ( optSkills.has( name ) ) {
			const prefix = `.claude/skills-optional/${ name }/`;
			for ( const rel of t.tree.keys() ) {
				if ( rel.startsWith( prefix ) ) {
					add( `.claude/skills/${ name }/${ rel.slice( prefix.length ) }`, rel, 'activated' );
				}
			}
			for ( const rel of tracked( p, `.claude/skills/${ name }` ) ) {
				if ( ! out.has( rel ) ) {
					add( rel, null, 'activated' );
				}
			}
		} else {
			tracked( p, `.claude/skills/${ name }` ).forEach( ( rel ) => add( rel, null, 'activated' ) );
		}
	}
	for ( const name of wantRules ) {
		const rel = `.claude/rules/${ name }.md`;
		if ( optRules.has( name ) ) {
			add( rel, `.claude/rules-optional/${ name }.md`, 'activated' );
		} else if ( existsSync( join( p.root, rel ) ) ) {
			notes.push( `правило ${ rel } — нет ни в rules/, ни в rules-optional/ шаблона: оставлено, проверить вручную` );
		}
	}

	// Файлы проекта в каталогах шаблона, которых в шаблоне больше нет.
	for ( const dir of [ '.claude/skills/project-init', '.claude/skills/project-ops', '.claude/skills/project-structure', '.claude/skills-optional', '.claude/rules-optional', '.claude/template', '.claude/hooks' ] ) {
		for ( const rel of tracked( p, dir ) ) {
			if ( ! out.has( rel ) && owned( rel ) ) {
				add( rel, null, rel.startsWith( '.claude/hooks/' ) ? 'protected' : 'template' );
			}
		}
	}
	return { list: [ ...out.values() ], notes };
}

// Действие по одной паре.
function decide( t, p, pair, ctx ) {
	const cur = readFile( p.root, pair.rel );
	let base;
	const open = p.label?.unresolved?.[ pair.rel ];
	// Хуки и settings.json после --apply, но до --protected — предок тот, что был до обновления.
	const pend = pair.kind === 'protected' && ! ctx.flagBase ? p.label?.protectedBase : null;
	if ( pend ) {
		base = pend.template ? blobAt( TROOT, pend.template, pair.from || pair.rel ) : blobAt( p.root, pend.project, pair.rel );
	} else if ( open ) {
		// Конфликт прошлого обновления не решён — предок тот, что был при нём.
		const from = pair.from || templatePathOf( pair.rel, ctx.core );
		base = open.template ? blobAt( TROOT, open.template, from ) : blobAt( p.root, open.project, pair.rel );
	} else if ( p.templateBase ) {
		const from = pair.from || ( pair.kind === 'activated' && pair.rel.startsWith( '.claude/rules/' ) ? pair.rel.replace( '.claude/rules/', '.claude/rules-optional/' ) : templatePathOf( pair.rel, ctx.core ) );
		base = pair.kind === 'skills-json' ? null : p.templateBase( from );
	} else {
		base = p.baseFile( pair.rel );
	}
	let theirs = pair.from ? t.file( pair.from ) : null;

	if ( pair.kind === 'skills-json' ) {
		theirs = skillsJson( t, cur, ctx.stacks );
	} else if ( pair.kind === 'gitignore' ) {
		const block = gitignoreBlock( cur );
		theirs = withBlock( theirs, block );
		base = withBlock( base, block );
	}
	const kept = [];
	if ( pair.rel === '.claude/settings.json' ) {
		theirs = settingsMerge( cur, base, theirs, kept );
	}

	// tpl — версия шаблона (для метки), theirs — что будет записано.
	const r = { ...pair, cur, base, theirs, tpl: theirs };
	if ( theirs === null ) {
		if ( cur === null ) {
			return { ...r, action: 'skip' };
		}
		return same( cur, base ) ? { ...r, action: 'remove' } : { ...r, action: 'conflict', reason: 'нет в шаблоне, но в проекте правился — удалить?' };
	}
	if ( cur === null ) {
		return base === null ? { ...r, action: 'add' } : { ...r, action: 'conflict', reason: 'в проекте нет (удалён или не попал при переносе), в шаблоне есть' };
	}
	if ( same( cur, theirs ) ) {
		return { ...r, action: 'same' };
	}
	if ( kept.length ) {
		return { ...r, action: 'merge', reason: `сохранено из проекта: ${ kept.join( ', ' ) }` };
	}
	if ( p.label?.files?.[ pair.rel ] === hashOf( cur ) || same( cur, base ) || pair.kind === 'skills-json' || pair.rel === '.claude/settings.json' ) {
		return { ...r, action: 'replace' };
	}
	if ( base === null ) {
		return { ...r, action: 'conflict', reason: 'появился и в проекте, и в шаблоне, содержимое разное' };
	}
	if ( same( base, theirs ) ) {
		// Шаблон с прошлой опоры не менялся — правки проекта остаются как есть.
		return { ...r, action: 'same' };
	}
	const m = merge3( cur, base, theirs );
	if ( ! m.conflicts && same( m.content, cur ) ) {
		return { ...r, action: 'same' };
	}
	return m.conflicts ? { ...r, action: 'conflict', reason: `слияние: конфликтов ${ m.conflicts }`, merged: m.content } : { ...r, action: 'merge', theirs: m.content };
}

// skills.json: манифест шаблона + подключённые стеки и отложенные обновления проекта.
function skillsJson( t, cur, stacks ) {
	const m = JSON.parse( JSON.stringify( t.skills ) );
	m.active = stacks.active.filter( ( id ) => m.stacks?.[ id ] );
	const own = readJson( cur, {} );
	for ( const [ name, s ] of Object.entries( own.skills || {} ) ) {
		if ( s.ignoredTree && m.skills?.[ name ] && m.skills[ name ].tree === s.tree ) {
			m.skills[ name ].ignoredTree = s.ignoredTree;
		}
	}
	return jsonBuf( m );
}

// settings.json: основа шаблона + то, что проект добавил сам после опоры; kept — что сохранено из проекта (для отчёта).
function settingsMerge( cur, base, theirs, kept = [] ) {
	const t = readJson( theirs );
	if ( ! t || ! cur ) {
		return theirs;
	}
	const c = readJson( cur, {} );
	const b = readJson( base, {} );
	const out = JSON.parse( JSON.stringify( t ) );
	out.permissions ||= {};
	const tAll = new Set( [ 'allow', 'ask', 'deny' ].flatMap( ( k ) => t.permissions?.[ k ] || [] ) );
	for ( const k of [ 'allow', 'ask', 'deny', 'additionalDirectories' ] ) {
		const was = new Set( b.permissions?.[ k ] || [] );
		const added = ( c.permissions?.[ k ] || [] ).filter( ( x ) => ! was.has( x ) && ! tAll.has( x ) && ! ( out.permissions[ k ] || [] ).includes( x ) );
		if ( added.length ) {
			out.permissions[ k ] = [ ...( out.permissions[ k ] || [] ), ...added ];
			kept.push( `permissions.${ k } +${ added.length }` );
		}
	}
	for ( const [ k, v ] of Object.entries( c.permissions || {} ) ) {
		if ( ! Array.isArray( v ) && JSON.stringify( v ) !== JSON.stringify( b.permissions?.[ k ] ) ) {
			out.permissions[ k ] = v;
			kept.push( `permissions.${ k }` );
		}
	}
	for ( const [ k, v ] of Object.entries( c ) ) {
		if ( k === 'permissions' || k === 'hooks' || JSON.stringify( v ) === JSON.stringify( b[ k ] ) ) {
			continue;
		}
		out[ k ] = v && typeof v === 'object' && ! Array.isArray( v ) && out[ k ] && typeof out[ k ] === 'object' ? { ...out[ k ], ...v } : v;
		kept.push( k );
	}
	// Порядок ключей — как в проекте, новые ключи шаблона — в конце: в diff видно только изменённое.
	const order = [ ...Object.keys( c ), ...Object.keys( out ) ].filter( ( k, i, a ) => k in out && a.indexOf( k ) === i );
	return jsonBuf( Object.fromEntries( order.map( ( k ) => [ k, out[ k ] ] ) ) );
}

// --- Миграции: механическая часть (разделы и поля markdown) ---

function parseMd( text ) {
	const lines = text.split( '\n' );
	const pre = [];
	const sections = [];
	let h2 = '';
	let fence = false;
	let cur = null;
	for ( const line of lines ) {
		if ( /^\s*```/.test( line ) ) {
			fence = ! fence;
		}
		const h = ! fence && line.match( /^(##|###) (.+?)\s*$/ );
		if ( h ) {
			const title = h[ 2 ];
			if ( h[ 1 ] === '##' ) {
				h2 = title;
			}
			cur = { head: line, path: h[ 1 ] === '##' ? title : `${ h2 } / ${ title }`, body: [] };
			sections.push( cur );
		} else if ( cur ) {
			cur.body.push( line );
		} else {
			pre.push( line );
		}
	}
	return { pre, sections };
}

const FIELD = /^- ([^:]+?):\s?(.*)$/;
const isDash = ( v ) => ! v.trim() || /^[—–-](\s|$)/.test( v.trim() );

function structuredMerge( templateText, projectText, aliases = {} ) {
	const t = parseMd( templateText );
	const p = parseMd( projectText );
	const byPath = new Map();
	for ( const s of p.sections ) {
		byPath.set( aliases[ s.path ] || s.path, s );
	}
	const used = new Set();
	const dropped = [];
	const out = [ ...t.pre ];
	for ( const s of t.sections ) {
		out.push( s.head );
		const ps = byPath.get( s.path );
		const isFields = s.body.some( ( l ) => {
			const m = l.match( FIELD );
			return m && isDash( m[ 2 ] );
		} );
		if ( ! ps ) {
			out.push( ...s.body );
			continue;
		}
		used.add( ps );
		if ( ! isFields ) {
			out.push( ...( ps.body.join( '\n' ).trim() ? ps.body : s.body ) );
			continue;
		}
		const pf = new Map();
		for ( const l of ps.body ) {
			const m = l.match( FIELD );
			if ( m ) {
				pf.set( m[ 1 ].trim(), l );
			}
		}
		const taken = new Set();
		const body = s.body.map( ( l ) => {
			const m = l.match( FIELD );
			const own = m && pf.get( m[ 1 ].trim() );
			if ( own && ! isDash( own.match( FIELD )[ 2 ] ) ) {
				taken.add( own );
				return own;
			}
			if ( own ) {
				taken.add( own );
			}
			return l;
		} );
		const tLines = new Set( s.body );
		const extra = [];
		for ( const l of ps.body ) {
			if ( taken.has( l ) || tLines.has( l ) || ! l.trim() ) {
				continue;
			}
			if ( /^(\s*[-*|]|\s{2,}\S|```)/.test( l ) ) {
				extra.push( l );
			} else {
				dropped.push( `${ s.path }: ${ l }` );
			}
		}
		while ( body.length && ! body[ body.length - 1 ].trim() ) {
			body.pop();
		}
		out.push( ...body, ...extra, '' );
	}
	const orphan = p.sections.filter( ( s ) => ! used.has( s ) );
	for ( const s of orphan ) {
		out.push( s.head, ...s.body );
	}
	return {
		text: out.join( '\n' ).replace( /\n{3,}/g, '\n\n' ).replace( /\n*$/, '\n' ),
		orphan: orphan.map( ( s ) => s.path ),
		dropped,
	};
}

function pendingMigrations( t, p ) {
	const done = new Set( p.label?.migrations || [] );
	return ( t.manifest.migrations || [] ).filter( ( m ) => ! done.has( m.id ) );
}

function migrationResults( t, p ) {
	const res = [];
	for ( const mig of pendingMigrations( t, p ) ) {
		for ( const [ rel, opt ] of Object.entries( mig.structured || {} ) ) {
			const cur = readFile( p.root, rel );
			const tpl = t.file( rel );
			if ( ! cur || ! tpl ) {
				continue;
			}
			const r = structuredMerge( norm( tpl ).toString( 'utf8' ), norm( cur ).toString( 'utf8' ), opt.aliases );
			res.push( { mig: mig.id, rel, ...r, changed: r.text !== norm( cur ).toString( 'utf8' ) } );
		}
	}
	return res;
}

// --- Отчёт ---

const ACTION_TEXT = { add: 'добавить', replace: 'заменить', merge: 'объединить', remove: 'удалить', conflict: 'конфликт' };

const GROUPS = [
	[ 'replace', 'заменить (в проекте не правились)' ],
	[ 'add', 'добавить' ],
	[ 'remove', 'удалить (нет в шаблоне, в проекте не правились)' ],
	[ 'merge', 'объединить (правки проекта сохранены)' ],
	[ 'conflict', 'КОНФЛИКТЫ — решить после применения' ],
];

function report( t, p, results, mig, stacks, notes, all ) {
	const version = t.manifest.version;
	console.log( `Шаблон ${ version } (${ t.commit.slice( 0, 7 ) }) → ${ p.root }` );
	console.log( `Проект: ${ p.label ? `версия ${ p.label.version }` : 'без метки' }, опора ${ p.base.slice( 0, 7 ) }, ветка ${ p.branch }${ p.clean ? '' : ', ЕСТЬ НЕЗАКОММИЧЕННОЕ' }` );
	if ( t.dirty ) {
		console.log( t.worktree ? 'Шаблон — рабочая копия (--worktree), не коммит.' : 'В шаблоне есть незакоммиченное — берётся последний коммит.' );
	}
	const main = results.filter( ( r ) => r.kind !== 'protected' );
	const prot = results.filter( ( r ) => r.kind === 'protected' && ! [ 'same', 'skip' ].includes( r.action ) );
	console.log( `\nсовпадают: ${ main.filter( ( r ) => r.action === 'same' ).length }` );
	for ( const [ action, title ] of GROUPS ) {
		const rows = main.filter( ( r ) => r.action === action );
		if ( ! rows.length ) {
			continue;
		}
		console.log( `${ title }: ${ rows.length }` );
		const shown = all || action === 'conflict' || action === 'merge' || action === 'remove' ? rows : rows.slice( 0, 15 );
		for ( const r of shown ) {
			console.log( `  ${ r.rel }${ r.reason ? ` — ${ r.reason }` : '' }` );
		}
		if ( shown.length < rows.length ) {
			console.log( `  … ещё ${ rows.length - shown.length } (--all — все)` );
		}
	}
	console.log( `\nстеки скиллов: ${ stacks.active.join( ', ' ) || 'нет' }${ stacks.inferred ? ' (определены по подключённым скиллам и правилам)' : '' }` );
	console.log( `защищённые (хуки, settings.json): ${ prot.length ? `изменятся ${ prot.length } — человек: ${ SELF } "<проект>" --protected` : 'без изменений' }` );
	for ( const r of prot ) {
		console.log( `  ${ r.rel } — ${ ACTION_TEXT[ r.action ] }${ r.reason ? ` (${ r.reason })` : '' }` );
	}
	const pend = pendingMigrations( t, p );
	if ( pend.length ) {
		console.log( `\nмиграции: ${ pend.map( ( m ) => m.id ).join( ', ' ) }` );
		for ( const m of mig ) {
			console.log( `  ${ m.rel }: ${ m.changed ? 'новая структура разделов, значения перенесены' : 'без изменений' }` +
				( m.orphan.length ? `; разделы без места в шаблоне (в конце файла): ${ m.orphan.join( '; ' ) }` : '' ) +
				( m.dropped.length ? `; строк текста без места: ${ m.dropped.length }` : '' ) );
			m.dropped.forEach( ( d ) => console.log( `    без места — ${ d }` ) );
		}
		for ( const m of pend ) {
			console.log( `  агенту после --apply: инструкция ${ m.doc }, затем ${ SELF } "<проект>" --done ${ m.id }` );
		}
	}
	for ( const n of notes ) {
		console.log( `заметка: ${ n }` );
	}
}

// --- Команды ---

function buildLabel( t, p, results ) {
	const files = { ...( p.label?.files || {} ) };
	for ( const r of results ) {
		const now = readFile( p.root, r.rel );
		if ( r.tpl && now && same( now, r.tpl ) ) {
			files[ r.rel ] = hashOf( now );
		} else {
			delete files[ r.rel ];
		}
	}
	return {
		$comment: `Метка версии шаблона (решение 032). Пишет ${ SELF.split( ' ' ).pop() }, вручную не править.`,
		version: t.manifest.version,
		commit: t.commit,
		source: { path: TROOT.replace( /\\/g, '/' ), repo: t.manifest.repo },
		updated: new Date().toISOString().slice( 0, 10 ),
		migrations: p.label?.migrations || [],
		protected: p.label?.protected || null,
		unresolved: {},
		files: Object.fromEntries( Object.entries( files ).sort() ),
	};
}

function cmdApply( t, p, results, mig ) {
	if ( ! p.clean ) {
		fail( 'В проекте есть незакоммиченное — закоммить и сверь с сервером до обновления.' );
	}
	// Ветка прошлого обновления, уже влитая в текущую, — удаляется; невлитая — стоп.
	if ( gitText( p.root, [ 'branch', '--list', BRANCH ] ) ) {
		if ( ! gitText( p.root, [ 'branch', '--merged', 'HEAD', '--list', BRANCH ] ) ) {
			fail( `Ветка ${ BRANCH } уже есть и не влита в ${ p.branch } — заверши или удали прошлое обновление.` );
		}
		git( p.root, [ 'branch', '-q', '-d', BRANCH ] );
		console.log( `Ветка прошлого обновления ${ BRANCH } уже влита — удалена.` );
	}
	let tag = `before-template-update-${ t.manifest.version }`;
	for ( let i = 2; gitText( p.root, [ 'tag', '--list', tag ] ); i++ ) {
		tag = `before-template-update-${ t.manifest.version }-${ i }`;
	}
	git( p.root, [ 'tag', tag ] );
	git( p.root, [ 'checkout', '-q', '-b', BRANCH ] );

	for ( const r of results ) {
		if ( r.kind === 'protected' ) {
			continue;
		}
		if ( [ 'add', 'replace', 'merge' ].includes( r.action ) ) {
			writeFile( p.root, r.rel, r.theirs );
		} else if ( r.action === 'remove' ) {
			removeFile( p.root, r.rel );
		}
	}
	for ( const m of mig ) {
		if ( m.changed ) {
			writeFile( p.root, m.rel, Buffer.from( m.text, 'utf8' ) );
		}
	}
	const label = buildLabel( t, p, results.filter( ( r ) => r.kind !== 'protected' ) );
	if ( results.some( ( r ) => r.kind === 'protected' && ! [ 'same', 'skip' ].includes( r.action ) ) ) {
		label.protectedBase = p.label?.protectedBase || ( p.templateBase ? { template: p.label.commit } : { project: p.base } );
	}
	for ( const r of results.filter( ( x ) => x.action === 'conflict' && x.kind !== 'protected' ) ) {
		label.unresolved[ r.rel ] = p.label?.unresolved?.[ r.rel ] || ( p.templateBase ? { template: p.label.commit } : { project: p.base } );
	}
	writeFile( p.root, LABEL, jsonBuf( label ) );
	git( p.root, [ 'add', '-A' ] );
	git( p.root, [ 'commit', '-q', '-m', `Шаблон: обновление до ${ t.manifest.version } (template-update.mjs; конфликты и миграции — следующими коммитами)` ] );

	const conflicts = results.filter( ( r ) => r.action === 'conflict' && r.kind !== 'protected' );
	console.log( `\nПрименено в ветке ${ BRANCH }, откат — тег ${ tag } (git checkout main && git branch -D ${ BRANCH }).` );
	if ( conflicts.length ) {
		console.log( `Конфликты (${ conflicts.length }) не тронуты — решить: ${ SELF } "<проект>" --take template|project|merge <путь…>` );
	}
	console.log( 'Дальше: миграции (инструкция выше), --protected (человек), перезапуск Claude Code, selftest, связь, сайт.' );
}

function cmdTake( t, p, results, how, paths ) {
	if ( p.branch !== BRANCH ) {
		fail( `--take — только в ветке ${ BRANCH } после --apply.` );
	}
	if ( ! [ 'template', 'project', 'merge' ].includes( how ) || ! paths.length ) {
		fail( '--take template|project|merge <путь…>' );
	}
	const label = p.label || {};
	label.files ||= {};
	for ( const rel of paths.map( ( x ) => x.replace( /\\/g, '/' ) ) ) {
		const r = results.find( ( x ) => x.rel === rel );
		if ( ! r || r.kind === 'protected' ) {
			fail( `${ rel } — не управляемый файл шаблона (хуки и settings.json — через --protected).` );
		}
		if ( how === 'template' ) {
			if ( r.tpl === null ) {
				removeFile( p.root, rel );
			} else {
				writeFile( p.root, rel, r.tpl );
				label.files[ rel ] = hashOf( r.tpl );
			}
		} else if ( how === 'merge' ) {
			writeFile( p.root, rel, r.merged || merge3( r.cur || Buffer.alloc( 0 ), r.base || Buffer.alloc( 0 ), r.tpl || Buffer.alloc( 0 ) ).content );
			console.log( `${ rel }: записан с маркерами <<<<<<< — поправить руками, затем --take project ${ rel }.` );
		}
		if ( how !== 'merge' && label.unresolved ) {
			delete label.unresolved[ rel ];
		}
		console.log( `${ rel }: ${ how === 'template' ? 'взят из шаблона' : how === 'project' ? 'оставлен проектный' : 'слияние с маркерами' }` );
	}
	writeFile( p.root, LABEL, jsonBuf( label ) );
}

function cmdDone( p, id ) {
	if ( ! p.label ) {
		fail( 'Метки нет — сначала --apply.' );
	}
	p.label.migrations = [ ...new Set( [ ...( p.label.migrations || [] ), id ] ) ];
	writeFile( p.root, LABEL, jsonBuf( p.label ) );
	console.log( `Миграция ${ id } отмечена выполненной.` );
}

async function confirm( question ) {
	const rl = createInterface( { input: process.stdin, output: process.stdout } );
	try {
		return /^(y|yes|д|да)$/i.test( ( await rl.question( `${ question } (y/n) ` ) ).trim() );
	} finally {
		rl.close();
	}
}

function setPath( obj, path, value ) {
	let o = obj;
	for ( const k of path.slice( 0, -1 ) ) {
		o = o[ k ] ||= {};
	}
	const was = o[ path[ path.length - 1 ] ];
	o[ path[ path.length - 1 ] ] = value;
	return was;
}

async function cmdProtectedTemplate() {
	const pending = readJson( readFile( TROOT, PENDING ), { edits: [] } );
	if ( ! pending.edits.length ) {
		console.log( 'Ожидающих правок настроек нет.' );
		return;
	}
	const files = new Map();
	for ( const e of pending.edits ) {
		if ( ! files.has( e.file ) ) {
			files.set( e.file, readJson( readFile( TROOT, e.file ) ) );
		}
		const data = files.get( e.file );
		const was = setPath( JSON.parse( JSON.stringify( data ) ), e.path, e.value );
		console.log( `${ e.file } → ${ e.path.join( '.' ) }: ${ JSON.stringify( was ) } → ${ JSON.stringify( e.value ) } (решение ${ e.decision || '—' })` );
		setPath( data, e.path, e.value );
	}
	if ( ! ( await confirm( 'Применить к шаблону?' ) ) ) {
		console.log( 'Отменено.' );
		return;
	}
	for ( const [ file, data ] of files ) {
		writeFile( TROOT, file, jsonBuf( data ) );
	}
	writeFile( TROOT, PENDING, jsonBuf( { ...pending, edits: [] } ) );
	console.log( 'Применено. Перезапусти Claude Code и попроси агента закоммитить.' );
}

async function cmdProtectedProject( t, p, results ) {
	const pending = readJson( t.file( PENDING ), { edits: [] } );
	if ( pending.edits.length ) {
		fail( `В шаблоне есть неприменённые правки настроек — сначала из папки шаблона: ${ SELF } . --protected, коммит.` );
	}
	const prot = results.filter( ( r ) => r.kind === 'protected' && ! [ 'same', 'skip' ].includes( r.action ) );
	if ( ! prot.length ) {
		console.log( 'Хуки и settings.json уже как в шаблоне.' );
		return;
	}
	const writes = [];
	for ( const r of prot ) {
		if ( r.action === 'conflict' ) {
			console.log( `${ r.rel } — ${ r.reason }` );
			const take = await confirm( '  взять версию шаблона (n — оставить проектную)?' );
			if ( take ) {
				writes.push( r );
			}
			continue;
		}
		console.log( `${ r.rel } — ${ { add: 'добавить', replace: 'заменить', merge: 'объединить', remove: 'удалить' }[ r.action ] }` );
		writes.push( r );
	}
	if ( ! writes.length || ! ( await confirm( `Применить (${ writes.length })?` ) ) ) {
		console.log( 'Отменено.' );
		return;
	}
	for ( const r of writes ) {
		if ( r.theirs === null ) {
			removeFile( p.root, r.rel );
		} else {
			writeFile( p.root, r.rel, r.theirs );
		}
	}
	const label = p.label || buildLabel( t, p, [] );
	label.protected = { version: t.manifest.version, commit: t.commit };
	delete label.protectedBase;
	writeFile( p.root, LABEL, jsonBuf( label ) );
	console.log( 'Готово. Перезапусти Claude Code в папке проекта (может попросить одобрить новые хуки), затем агенту: «проверь хуки» — selftest и коммит.' );
}

// --- Запуск ---

function parseArgs( argv ) {
	const flags = { positional: [] };
	for ( let i = 0; i < argv.length; i++ ) {
		const a = argv[ i ];
		if ( a === '--base' || a === '--done' || a === '--take' ) {
			flags[ a.slice( 2 ) ] = argv[ ++i ];
		} else if ( a.startsWith( '--' ) ) {
			flags[ a.slice( 2 ) ] = true;
		} else {
			flags.positional.push( a );
		}
	}
	return flags;
}

export { globRe, settingsMerge, structuredMerge };

async function main() {
	const flags = parseArgs( process.argv.slice( 2 ) );
	const target = flags.positional.shift();
	if ( ! target ) {
		fail( readFileSync( fileURLToPath( import.meta.url ), 'utf8' ).split( '*/' )[ 0 ].replace( /^\/\*\*?|^ \* ?/gm, '' ).trim() );
	}
	const root = resolve( target );

	if ( flags.protected && ! ( process.stdin.isTTY && process.stdout.isTTY ) ) {
		fail( '--protected запускает человек в своём терминале (нужен интерактивный ввод). Агент эту команду не выполняет.' );
	}
	if ( flags.protected && relative( root, TROOT ) === '' ) {
		await cmdProtectedTemplate();
		return;
	}
	if ( relative( root, TROOT ) === '' ) {
		fail( 'Путь указывает на сам шаблон. Для его ожидающих правок — --protected.' );
	}

	const t = loadTemplate( flags.worktree );
	const p = loadProject( root, flags );
	if ( flags.done ) {
		cmdDone( p, flags.done );
		return;
	}
	const stacks = activeStacks( t, p );
	const { list, notes } = pairs( t, p, stacks );
	const core = new Set( t.skills.core || [] );
	const results = list.map( ( pair ) => decide( t, p, pair, { stacks, core, flagBase: Boolean( flags.base ) } ) ).sort( ( a, b ) => a.rel.localeCompare( b.rel ) );

	if ( flags.take ) {
		cmdTake( t, p, results, flags.take, flags.positional );
	} else if ( flags.protected ) {
		await cmdProtectedProject( t, p, results );
	} else {
		const mig = migrationResults( t, p );
		report( t, p, results, mig, stacks, notes, flags.all );
		if ( flags.apply ) {
			cmdApply( t, p, results, mig );
		} else {
			console.log( `\nЭто пробный прогон. Применить: ${ SELF } "<проект>" --apply (после «да» пользователя).` );
		}
	}
}

// Импорт из теста не запускает команду.
if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {
	await main();
}
