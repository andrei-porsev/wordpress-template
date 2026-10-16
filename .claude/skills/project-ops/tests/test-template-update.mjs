/**
 * Проверка template-update.mjs на поддельных шаблоне и проекте во временной папке:
 * первое обновление без метки, слияние, удаление, подключённые стеки, миграция разделов, повторный прогон,
 * конфликт с запоминанием предка, settings.json, отказ --protected без терминала.
 * node .claude/skills/project-ops/tests/test-template-update.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'template-update.mjs' );
const base = join( tmpdir(), 'wp-template-test-update' );
const tpl = join( base, 'tpl' );
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
};
const SCRIPT_REL = '.claude/skills/project-ops/scripts/template-update.mjs';
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ join( tpl, SCRIPT_REL ), proj, ...args ], { encoding: 'utf8', input: '' } );
	return { code: r.status, out: ( r.stdout || '' ) + ( r.stderr || '' ) };
};
const block = ( lines ) => `# >>> project.json (генерируется, не править вручную)\n${ lines }\n# <<< project.json\n`;
const lines = ( n, tag ) => Array.from( { length: n }, ( _, i ) => `строка ${ i + 1 }${ tag && i === n - 1 ? tag : '' }` ).join( '\n' ) + '\n';

// --- Старое состояние шаблона = опора проекта ---
mkdirSync( proj, { recursive: true } );
git( proj, 'init', '-q', '-b', 'main' );
put( proj, 'CLAUDE.md', lines( 20 ) );
put( proj, '.claude/rules/core.md', 'правило v1\n' );
put( proj, '.claude/rules/r-fse.md', 'fse v1\n' );
put( proj, '.claude/skills/sk-a/SKILL.md', 'скилл a v1\n' );
put( proj, '.claude/skills-optional/sk-a/SKILL.md', 'скилл a v1\n' );
put( proj, '.claude/skills-optional/sk-gone/SKILL.md', 'убран из шаблона\n' );
put( proj, '.claude/settings.json', JSON.stringify( { permissions: { allow: [ 'A' ], defaultMode: 'acceptEdits' } }, null, '\t' ) + '\n' );
put( proj, '.claude/hooks/h.mjs', 'хук v1\n' );
put( proj, '.gitignore', '/node_modules/\n' + block( '!/wp-content/\n/wp-content/themes/*\n!/wp-content/themes/my-theme/' ) + '**/*.log\n' );
put( proj, 'ACCESS.md', '# Доступы\n\nстарое вступление\n\n## SSH\n\n- Host: example.org\n- Port: 22\n\n## Сайт\n\n- URL: https://example.org\n- Своё поле: да\n' );
put( proj, 'wp-content/themes/my-theme/style.css', '/* тема */\n' );
commit( proj, 'перенос на шаблон' );

// Правки проекта после опоры.
put( proj, 'CLAUDE.md', 'проектная строка\n' + lines( 20 ) );
put( proj, '.claude/settings.json', JSON.stringify( { permissions: { allow: [ 'A', 'P-own' ], defaultMode: 'acceptEdits' } }, null, '\t' ) + '\n' );
commit( proj, 'правки проекта' );

// --- Новый шаблон ---
mkdirSync( tpl, { recursive: true } );
git( tpl, 'init', '-q', '-b', 'main' );
cpSync( SCRIPT, join( tpl, SCRIPT_REL ) );
put( tpl, '.claude/template/manifest.json', JSON.stringify( {
	version: '2026.01.01',
	repo: 'git@example.org:t.git',
	exclude: [ 'project-base/plans/**' ],
	protected: [ '.claude/hooks/**', '.claude/settings.json' ],
	project: [ 'ACCESS.md', 'wp-content/**' ],
	owned: [ '.claude/skills/project-ops/**', '.claude/skills-optional/**', '.claude/rules-optional/**', '.claude/rules/**', '.claude/template/**', '.claude/hooks/**' ],
	migrations: [ { id: '2026.01.01', doc: '.claude/template/migrations/2026.01.01.md', structured: { 'ACCESS.md': { aliases: { SSH: 'Сервер / SSH' } } } } ],
}, null, '\t' ) );
put( tpl, '.claude/template/migrations/2026.01.01.md', '# миграция\n' );
put( tpl, '.claude/skills.json', JSON.stringify( { core: [ 'project-ops' ], stacks: { fse: { skills: [ 'sk-a' ], rules: [ 'r-fse' ] }, woo: { skills: [ 'sk-woo' ] } }, skills: {} }, null, '\t' ) );
put( tpl, 'CLAUDE.md', lines( 20, ' — шаблон v2' ) );
put( tpl, '.claude/rules/core.md', 'правило v2\n' );
put( tpl, '.claude/rules/new.md', 'новое правило\n' );
put( tpl, '.claude/rules-optional/r-fse.md', 'fse v2\n' );
put( tpl, '.claude/skills-optional/sk-a/SKILL.md', 'скилл a v2\n' );
put( tpl, '.claude/skills-optional/sk-woo/SKILL.md', 'woo\n' );
put( tpl, '.claude/settings.json', JSON.stringify( { permissions: { allow: [ 'A', 'B' ], defaultMode: 'auto' }, hooks: { Stop: [] } }, null, '\t' ) + '\n' );
put( tpl, '.claude/hooks/h.mjs', 'хук v2\n' );
put( tpl, '.gitignore', '/node_modules/\n' + block( '!/wp-content/' ) + '**/*.log\n**/*.tmp\n' );
put( tpl, 'ACCESS.md', '# Доступы\n\nновое вступление\n\n## Сервер\n\n- Хостинг: —\n\n### SSH\n\n- Host: —\n- Port: —\n\n## Сайт\n\n- URL: —\n- Админка: —\n' );
put( tpl, 'project-base/plans/x.md', 'план шаблона\n' );
commit( tpl, 'шаблон v2' );

// 1. Пробный прогон ничего не меняет.
let r = run();
check( '1 пробный прогон', r.code === 0 && /без метки/.test( r.out ) && /объединить/.test( r.out ), r.out );
check( '1 стек fse определён по составу', /стеки скиллов: fse \(определены/.test( r.out ), r.out );
check( '1 хуки — шаг человека', /\.claude\/hooks\/h\.mjs — заменить/.test( r.out ) && /settings\.json — заменить/.test( r.out ), r.out );
check( '1 проект не тронут', git( proj, 'status', '--porcelain' ) === '' && ! existsSync( join( proj, '.claude/template.json' ) ) );

// 2. Применение.
r = run( '--apply' );
check( '2 apply', r.code === 0 && git( proj, 'rev-parse', '--abbrev-ref', 'HEAD' ) === 'template-update', r.out );
check( '2 тег отката', git( proj, 'tag' ).includes( 'before-template-update-2026.01.01' ) );
const claude = read( proj, 'CLAUDE.md' );
check( '2 слияние CLAUDE.md: правки проекта и шаблона', claude.startsWith( 'проектная строка' ) && claude.includes( 'шаблон v2' ), claude );
check( '2 замена неизменённого правила', read( proj, '.claude/rules/core.md' ) === 'правило v2\n' );
check( '2 новое правило добавлено', read( proj, '.claude/rules/new.md' ) === 'новое правило\n' );
check( '2 подключённые копии обновлены', read( proj, '.claude/skills/sk-a/SKILL.md' ) === 'скилл a v2\n' && read( proj, '.claude/rules/r-fse.md' ) === 'fse v2\n' );
check( '2 неподключённый стек не подключён', ! existsSync( join( proj, '.claude/skills/sk-woo' ) ) && existsSync( join( proj, '.claude/skills-optional/sk-woo/SKILL.md' ) ) );
check( '2 убранное из шаблона удалено', ! existsSync( join( proj, '.claude/skills-optional/sk-gone' ) ) );
check( '2 skills.json: active = fse', JSON.parse( read( proj, '.claude/skills.json' ) ).active.join() === 'fse' );
const gi = read( proj, '.gitignore' );
check( '2 .gitignore: блок проекта сохранён, шаблонные строки добавлены', gi.includes( 'my-theme' ) && gi.includes( '**/*.tmp' ), gi );
check( '2 хуки не тронуты', read( proj, '.claude/hooks/h.mjs' ) === 'хук v1\n' && read( proj, '.claude/settings.json' ).includes( 'P-own' ) && ! read( proj, '.claude/settings.json' ).includes( '"B"' ) );
check( '2 планы шаблона не попали в проект', ! existsSync( join( proj, 'project-base/plans' ) ) );
check( '2 проектный код не тронут', read( proj, 'wp-content/themes/my-theme/style.css' ) === '/* тема */\n' );
const access = read( proj, 'ACCESS.md' );
check( '2 миграция ACCESS.md: новые разделы, значения перенесены',
	/## Сервер\n\n- Хостинг: —/.test( access ) && /### SSH\n\n- Host: example\.org\n- Port: 22/.test( access ) && access.includes( '- Админка: —' ) && access.includes( '- Своё поле: да' ) && ! access.includes( 'старое вступление' ), access );
const label = JSON.parse( read( proj, '.claude/template.json' ) );
check( '2 метка', label.version === '2026.01.01' && label.migrations.length === 0 && Object.keys( label.files ).length > 5 );
check( '2 всё закоммичено', git( proj, 'status', '--porcelain' ) === '' );

// 3. Миграция отмечена, повторный прогон — без изменений.
run( '--done', '2026.01.01' );
commit( proj, 'миграция' );
r = run();
check( '3 повторный прогон: нечего менять', ! /заменить|добавить|удалить|объединить|КОНФЛИКТ/.test( r.out.split( 'защищённые' )[ 0 ] ) && ! /миграции:/.test( r.out ), r.out );

// 4. Новая версия: конфликт в CLAUDE.md, предок запоминается.
git( proj, 'checkout', '-q', 'main' );
git( proj, 'merge', '-q', '--ff-only', 'template-update' );
git( proj, 'branch', '-q', '-d', 'template-update' );
put( proj, 'CLAUDE.md', read( proj, 'CLAUDE.md' ).replace( 'строка 10', 'строка 10 — проект' ) );
commit( proj, 'правка CLAUDE.md' );
put( tpl, 'CLAUDE.md', read( tpl, 'CLAUDE.md' ).replace( 'строка 10', 'строка 10 — шаблон v3' ) );
put( tpl, '.claude/template/manifest.json', read( tpl, '.claude/template/manifest.json' ).replace( '"version": "2026.01.01"', '"version": "2026.01.02"' ) );
commit( tpl, 'шаблон v3' );
r = run( '--apply' );
check( '4 конфликт найден и не тронут', /CLAUDE\.md — слияние: конфликтов 1/.test( r.out ) && read( proj, 'CLAUDE.md' ).includes( 'строка 10 — проект' ), r.out );
r = run();
check( '4 конфликт виден и после применения', /CLAUDE\.md — слияние: конфликтов 1/.test( r.out ), r.out );
run( '--take', 'template', 'CLAUDE.md' );
check( '4 --take template', read( proj, 'CLAUDE.md' ).includes( 'шаблон v3' ) && ! JSON.parse( read( proj, '.claude/template.json' ) ).unresolved[ 'CLAUDE.md' ] );

// 5. settings.json: основа шаблона + добавленное проектом.
const { settingsMerge, structuredMerge, globRe } = await import( pathToFileURL( SCRIPT ).href );
const buf = ( o ) => Buffer.from( JSON.stringify( o ) );
const merged = JSON.parse( settingsMerge( buf( { permissions: { allow: [ 'A', 'P' ], defaultMode: 'acceptEdits' }, enabledPlugins: { x: true } } ), buf( { permissions: { allow: [ 'A' ], defaultMode: 'acceptEdits' } } ), buf( { permissions: { allow: [ 'A', 'B' ], defaultMode: 'auto' }, hooks: { Stop: [] } } ) ).toString() );
check( '5 settings: шаблон + свои правила проекта', merged.permissions.allow.join() === 'A,B,P' && merged.permissions.defaultMode === 'auto' && merged.enabledPlugins?.x === true && Array.isArray( merged.hooks.Stop ), JSON.stringify( merged ) );

// 6. Разметка: раздел без места в шаблоне уходит в конец.
const sm = structuredMerge( '# T\n\n## A\n\n- X: —\n', '# P\n\n## A\n\n- X: 1\n\n## Свой\n\nтекст\n' );
check( '6 structuredMerge: значение и свой раздел', sm.text.includes( '- X: 1' ) && sm.orphan.join() === 'Свой' && sm.text.trim().endsWith( 'текст' ), sm.text );
check( '6 glob [!_]', globRe( 'themes/[!_]*/**' ).test( 'themes/sitea/a.md' ) && ! globRe( 'themes/[!_]*/**' ).test( 'themes/_example/a.md' ) );

// 7. --protected без терминала — отказ.
r = run( '--protected' );
check( '7 --protected без терминала — отказ', r.code === 1 && /своём терминале/.test( r.out ), r.out );

console.log( failed ? `\nПровалов: ${ failed }` : '\nВсе проверки template-update прошли' );
process.exit( failed ? 1 : 0 );
