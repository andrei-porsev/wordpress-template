/**
 * Проверка decisions-check.mjs: чистый журнал — без замечаний; цепочка, отменённая запись, расхождение таблицы,
 * несуществующий файл, образец в комментарии и блоке кода, строка-уточнение в файле типа.
 * node .claude/skills/project-ops/tests/test-decisions-check.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'decisions-check.mjs' );
const proj = join( tmpdir(), 'wp-template-test-decisions' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( proj, '.claude' ), { recursive: true } );
mkdirSync( join( proj, 'project-base', 'content-types' ), { recursive: true } );
// Проект, не шаблон: журнал шаблона не проверяется.
writeFileSync( join( proj, '.claude', 'template.json' ), '{}' );
writeFileSync( join( proj, 'CLAUDE.md' ), '' );

let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
const entry = ( num, title, status, extra = '' ) => `## ${ num } — 2026-11-01 — ${ title }\n\n- **Решение:** да.${ extra }\n- **Статус:** ${ status }\n\n`;
const journal = ( rows, cancelled, entries ) => [
	'# Решения проекта\n\n## Действующие\n\n| № | Дата | Решение |\n|---|------|---------|',
	...rows.map( ( n ) => `| ${ n } | 2026-11-01 | x |` ),
	'\n## Отменённые и объединённые\n\n| № | Дата | Что | Где |\n|---|---|---|---|',
	...cancelled.map( ( n ) => `| ${ n } | 2026-11-01 | x | 001 |` ),
	'\n---\n\n## Журнал\n\n```\n## 009 — ГГГГ-ММ-ДД — Образец\n- **Статус:** действует, уточняет 001\n```\n',
	'<!--\n## 008 — 2026-01-01 — Образец\n- **Статус:** отменено\n-->\n',
	...entries,
	'---\n\n## Что сюда писать\n',
].join( '\n' );
const file = join( proj, 'project-base', 'DECISIONS.md' );

writeFileSync( file, journal( [ '002', '001' ], [ '003' ], [ entry( '002', 'Второе', 'действует', ' См. `CLAUDE.md`.' ), entry( '001', 'Первое', 'действует' ) ] ) );
let r = run( '--strict' );
check( '1 чистый журнал — без замечаний', r.code === 0 && /замечаний нет/.test( r.out ), r.out );
check( '1 образцы в комментарии и коде — не записи', ! /008|009/.test( r.out ), r.out );

writeFileSync( file, journal( [ '002', '001', '004' ], [ '001' ], [
	entry( '003', 'Старое', 'отменено, заменено 002' ),
	entry( '002', 'Второе (уточняет 001)', 'действует', ' Файл `project-base/nope.md`.' ),
	entry( '001', 'Первое', 'действует' ),
] ) );
r = run( '--strict' );
check( '2 код выхода 1 при замечаниях', r.code === 1, r.out );
check( '2 цепочка найдена', /002: цепочка с 001/.test( r.out ), r.out );
check( '2 отменённая в журнале', /003: отменённая запись/.test( r.out ), r.out );
check( '2 нет файла', /002: нет файлов — project-base\/nope\.md/.test( r.out ), r.out );
check( '2 в таблице без записи', /004: в таблице «Действующие», записи в журнале нет/.test( r.out ), r.out );
check( '2 и в журнале, и в отменённых', /001: и в журнале, и в «Отменённые»/.test( r.out ), r.out );

r = run();
check( '3 без --strict код 0', r.code === 0, r.out );

writeFileSync( file, journal( [ '001' ], [], [ entry( '001', 'Первое', 'действует' ) ] ) );
writeFileSync( join( proj, 'project-base', 'content-types', 'post.md' ), '# Пост\n\n## Решения\n\n- 2026-11-01 — анонс до 160 знаков\n- 2026-11-02 — уточняет прошлую: до 140\n\n## Не делать\n\n- уточнение тут не в счёт\n' );
r = run();
check( '4 строка-уточнение в файле типа', /content-types\/post\.md:[\s\S]*строка-уточнение/.test( r.out ) && ! /не в счёт/.test( r.out ), r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `\nПровалено: ${ fails }` : '\nВсе проверки пройдены.' );
process.exit( fails ? 1 : 0 );
