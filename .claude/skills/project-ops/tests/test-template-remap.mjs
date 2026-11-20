/**
 * Проверка template-update.mjs --remap: хеши шаблона в метке проекта (commit, protected, protectedBase, unresolved)
 * меняются по таблице и коммитятся; суммы файлов не трогаются; повторный запуск — «менять нечего»; неизвестный хеш — предупреждение.
 * node .claude/skills/project-ops/tests/test-template-remap.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'template-update.mjs' );
const SCRIPT_REL = '.claude/skills/project-ops/scripts/template-update.mjs';
const base = join( tmpdir(), 'wp-template-test-remap' );
const tpl = join( base, 'tpl' );
const proj = join( base, 'proj' );
rmSync( base, { recursive: true, force: true } );

let failed = 0;
const check = ( name, ok, extra = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + String( extra ).slice( 0, 800 ) }` );
	failed += ok ? 0 : 1;
};
const git = ( cwd, ...args ) => execFileSync( 'git', [ '-c', 'core.autocrlf=false', '-C', cwd, ...args ], { encoding: 'utf8' } ).trim();
const init = ( dir ) => {
	mkdirSync( dir, { recursive: true } );
	git( dir, 'init', '-q', '-b', 'main' );
	git( dir, 'config', 'user.name', 't' );
	git( dir, 'config', 'user.email', 't@t' );
};
const put = ( root, rel, text ) => {
	mkdirSync( dirname( join( root, rel ) ), { recursive: true } );
	writeFileSync( join( root, rel ), text );
};
const commit = ( cwd, msg ) => {
	git( cwd, 'add', '-A' );
	git( cwd, 'commit', '-q', '-m', msg );
};
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ join( tpl, SCRIPT_REL ), proj, ...args ], { encoding: 'utf8', input: '' } );
	return { code: r.status, out: ( r.stdout || '' ) + ( r.stderr || '' ) };
};
const label = () => JSON.parse( readFileSync( join( proj, '.claude/template.json' ), 'utf8' ) );

// Шаблон: два коммита — «новые» хеши после переписывания.
init( tpl );
cpSync( SCRIPT, join( tpl, SCRIPT_REL ) );
cpSync( join( dirname( SCRIPT ), 'skills-lib.mjs' ), join( tpl, dirname( SCRIPT_REL ), 'skills-lib.mjs' ) );
put( tpl, 'a.md', 'v1\n' );
commit( tpl, 'v1' );
const new1 = git( tpl, 'rev-parse', 'HEAD' );
put( tpl, 'a.md', 'v2\n' );
commit( tpl, 'v2' );
const new2 = git( tpl, 'rev-parse', 'HEAD' );

const old1 = 'a'.repeat( 40 );
const old2 = 'b'.repeat( 40 );
const lost = 'c'.repeat( 40 );
const fileHash = 'd'.repeat( 40 );

init( proj );
put( proj, '.claude/template.json', JSON.stringify( {
	version: '2026.01.02',
	commit: old2,
	protected: { version: '2026.01.01', commit: old1 },
	protectedBase: { template: old1 },
	unresolved: { 'x.md': { template: old2 }, 'y.md': { template: lost } },
	files: { 'a.md': fileHash },
}, null, '\t' ) + '\n' );
commit( proj, 'проект' );

const map = join( base, 'commit-map' );
writeFileSync( map, `old                                      new\n${ old1 } ${ new1 }\n${ old2 } ${ new2 }\n\n` );

let r = run( '--remap', map );
const l = label();
check( '1 commit — новый', l.commit === new2, r.out );
check( '1 protected.commit и protectedBase — новые', l.protected.commit === new1 && l.protectedBase.template === new1, JSON.stringify( l ) );
check( '1 unresolved — новый, неизвестный не тронут', l.unresolved[ 'x.md' ].template === new2 && l.unresolved[ 'y.md' ].template === lost, JSON.stringify( l.unresolved ) );
check( '1 суммы файлов не тронуты', l.files[ 'a.md' ] === fileHash, JSON.stringify( l.files ) );
check( '1 неизвестный хеш — предупреждение', /Не найдены[^\n]*ccccccc/.test( r.out ), r.out );
check( '1 метка закоммичена', git( proj, 'status', '--porcelain' ) === '' && /--remap/.test( git( proj, 'log', '-1', '--format=%s' ) ), git( proj, 'log', '-1', '--format=%s' ) );

r = run( '--remap', map );
check( '2 повторно — менять нечего', r.code === 0 && /менять нечего/.test( r.out ) && git( proj, 'rev-list', '--count', 'HEAD' ) === '2', r.out );

r = run( '--remap', join( base, 'nope' ) );
check( '3 нет файла таблицы — ошибка', r.code === 1 && /файла нет/.test( r.out ), r.out );

rmSync( base, { recursive: true, force: true } );
console.log( failed ? `\nПровалено: ${ failed }` : '\nВсе проверки пройдены.' );
process.exit( failed ? 1 : 0 );
