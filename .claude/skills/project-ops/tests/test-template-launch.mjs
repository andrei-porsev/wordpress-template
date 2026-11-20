/**
 * Проверка запуска template-update.mjs из проекта: шаблон клонируется с «GitHub» (локальный репозиторий по file://),
 * метка нового проекта по версии (--init-label), пробный прогон запоминает коммит, --apply применяет ровно его,
 * без пробного прогона --apply отказывает, --local — только пробный прогон.
 * node .claude/skills/project-ops/tests/test-template-launch.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts' );
const REL = '.claude/skills/project-ops/scripts';
const base = join( tmpdir(), 'wp-template-test-launch' );
const up = join( base, 'github' );
const proj = join( base, 'proj' );
rmSync( base, { recursive: true, force: true } );

let failed = 0;
const check = ( name, ok, extra = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }` );
	if ( ! ok ) {
		failed++;
		if ( extra ) {
			console.log( String( extra ).slice( 0, 1500 ) );
		}
	}
};
const put = ( root, rel, text ) => {
	mkdirSync( dirname( join( root, rel ) ), { recursive: true } );
	writeFileSync( join( root, rel ), text );
};
const read = ( root, rel ) => ( existsSync( join( root, rel ) ) ? readFileSync( join( root, rel ), 'utf8' ) : null );
const git = ( cwd, ...args ) => execFileSync( 'git', [ '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', '-C', cwd, ...args ], { encoding: 'utf8' } ).trim();
const commit = ( cwd, msg ) => {
	git( cwd, 'add', '-A' );
	git( cwd, 'commit', '-q', '-m', msg );
	return git( cwd, 'rev-parse', 'HEAD' );
};
// Запуск без TEMPLATE_UPDATE_CLONE: скрипт сам клонирует шаблон.
const run = ( script, ...args ) => {
	const env = { ...process.env };
	delete env.TEMPLATE_UPDATE_CLONE;
	delete env.TEMPLATE_UPDATE_LAUNCHER;
	const r = spawnSync( process.execPath, [ script, ...args ], { cwd: proj, encoding: 'utf8', input: '', env } );
	return { code: r.status, out: ( r.stdout || '' ) + ( r.stderr || '' ) };
};
const repo = pathToFileURL( up ).href;
const manifest = ( version ) =>
	JSON.stringify( { version, repo, exclude: [], protected: [], project: [ 'ACCESS.md' ], owned: [ '.claude/rules/**', '.claude/template/**' ], migrations: [ { id: '2026.01.01', doc: 'm.md' } ] }, null, '\t' ) + '\n';

// --- «GitHub»: v1, правка без поднятия версии, v2 ---
mkdirSync( up, { recursive: true } );
git( up, 'init', '-q', '-b', 'main' );
for ( const f of [ 'template-update.mjs', 'skills-lib.mjs' ] ) {
	cpSync( join( SCRIPTS, f ), join( up, REL, f ) );
}
put( up, '.claude/template/manifest.json', manifest( '2026.01.01' ) );
put( up, '.claude/rules/core.md', 'правило v1\n' );
put( up, '.claude/settings.json', '{}\n' );
put( up, 'CLAUDE.md', 'ядро v1\n' );
commit( up, 'v1' );
put( up, '.claude/rules/core.md', 'правило v1.1\n' );
const c1b = commit( up, 'правка без версии' );

// Проект «Use this template»: один коммит без истории шаблона, на состоянии c1b.
mkdirSync( proj, { recursive: true } );
git( proj, 'init', '-q', '-b', 'main' );
cpSync( up, proj, { recursive: true, filter: ( src ) => ! src.includes( `${ up }${ process.platform === 'win32' ? '\\' : '/' }.git` ) } );
put( proj, 'ACCESS.md', '# доступы проекта\n' );
commit( proj, 'проект из шаблона' );

put( up, '.claude/template/manifest.json', manifest( '2026.01.02' ) );
put( up, '.claude/rules/core.md', 'правило v2\n' );
const c2 = commit( up, 'v2' );

const projScript = join( proj, REL, 'template-update.mjs' );

// 1 метка нового проекта — по версии, последний коммит перед следующим поднятием
let r = run( projScript, '.', '--init-label' );
const label = JSON.parse( read( proj, '.claude/template.json' ) || '{}' );
check( '1 --init-label: метка записана', r.code === 0 && label.version === '2026.01.01', r.out );
check( '1 коммит метки — последний с этой версией', label.commit === c1b, `${ label.commit } ≠ ${ c1b }\n${ r.out }` );
check( '1 миграции версии отмечены, адрес шаблона', ( label.migrations || [] ).includes( '2026.01.01' ) && label.source?.repo === repo && ! label.source?.path );
check( '1 метка закоммичена', git( proj, 'status', '--porcelain' ) === '' );

// 2 без пробного прогона --apply отказывает
r = run( projScript, '.', '--apply' );
check( '2 --apply без пробного прогона — отказ', r.code === 1 && /Сначала пробный прогон/.test( r.out ), r.out );

// 3 пробный прогон с «GitHub»: версия 2, проект не тронут
r = run( projScript, '.' );
check( '3 пробный прогон: шаблон с GitHub, v2', r.code === 0 && r.out.includes( `Шаблон с ${ repo }` ) && /Шаблон 2026\.01\.02/.test( r.out ), r.out );
check( '3 опора — метка, без угадывания и конфликтов', /версия 2026\.01\.01/.test( r.out ) && /\.claude\/rules\/core\.md/.test( r.out ) && ! /конфликт/i.test( r.out ), r.out );
check( '3 проект не тронут', git( proj, 'status', '--porcelain' ) === '' );
check( '3 команда применения — скрипт проекта', r.out.includes( `${ projScript.replace( /\\/g, '/' ) }" "` ), r.out );

// 4 в «GitHub» пушнули ещё — --apply берёт показанный коммит
put( up, '.claude/rules/core.md', 'правило v3, не показанное\n' );
commit( up, 'после пробного прогона' );
r = run( projScript, '.', '--apply' );
const after = JSON.parse( read( proj, '.claude/template.json' ) || '{}' );
check( '4 --apply: ровно показанный коммит', r.code === 0 && after.commit === c2 && read( proj, '.claude/rules/core.md' ) === 'правило v2\n', r.out );
check( '4 ветка и метка', git( proj, 'rev-parse', '--abbrev-ref', 'HEAD' ) === 'template-update' && after.version === '2026.01.02' );

// 5 --local из папки шаблона — только пробный прогон
r = run( join( up, REL, 'template-update.mjs' ), proj, '--local', '--apply' );
check( '5 --local --apply — отказ', r.code === 1 && /только пробный прогон/.test( r.out ), r.out );
r = run( join( up, REL, 'template-update.mjs' ), proj, '--local' );
check( '5 --local — пробный прогон по папке', r.code === 0 && /--local/.test( r.out ) && ! r.out.includes( 'Шаблон с ' ), r.out );

// 6 нет доступа к шаблону — понятная ошибка
put( proj, '.claude/template/manifest.json', manifest( '2026.01.02' ).replace( repo, pathToFileURL( join( base, 'нет' ) ).href ) );
r = run( projScript, '.' );
check( '6 недоступный адрес — «шаблон не скачан»', r.code === 1 && /Шаблон не скачан/.test( r.out ), r.out );

rmSync( base, { recursive: true, force: true } );
console.log( failed ? `\nНе прошло: ${ failed }` : '\nВсе проверки template-launch прошли' );
process.exit( failed ? 1 : 0 );
