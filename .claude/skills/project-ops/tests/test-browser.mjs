/**
 * Проверка browser.mjs без запуска браузера: закрытые команды, чужие домены, запрещённые флаги — отказ до playwright-cli.
 * node .claude/skills/project-ops/tests/test-browser.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'browser.mjs' );
const proj = join( tmpdir(), 'wp-template-test-browser' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( proj, '.vscode' ), { recursive: true } );

const write = ( p, d ) => writeFileSync( join( proj, p ), typeof d === 'string' ? d : JSON.stringify( d ) );
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};

let r = run( 'open', 'https://acme.example/' );
check( 'нет ACCESS.md — домен не проекта', r.code === 1 && /не заполнены/.test( r.out ), r.out );

write( 'ACCESS.md', [
	'- Публичный URL: https://www.acme.example',
	'- Stage / dev URL: https://acme.stage.example/ (пароль)',
	'- Файл URL: https://files.example/',
].join( '\n' ) );
write( '.vscode/local.json', { url: 'http://acme.local' } );

r = run( 'open', 'https://evil.example/' );
check( 'чужой домен — отказ', r.code === 1 && /evil\.example — не домен проекта/.test( r.out ), r.out );

r = run( 'goto', 'https://files.example/' );
check( 'поле «Файл URL» доменом проекта не считается', r.code === 1 && /не домен проекта/.test( r.out ), r.out );

r = run( 'goto', 'acme.example' );
check( 'адрес без схемы — отказ', r.code === 1 && /Не адрес/.test( r.out ), r.out );

r = run( 'goto' );
check( 'goto без адреса — отказ', r.code === 1 && /без адреса/.test( r.out ), r.out );

r = run( 'run-code', 'x' );
check( 'run-code закрыт', r.code === 1 && /«run-code» закрыта/.test( r.out ), r.out );

r = run( 'route', '**/*' );
check( 'route закрыт', r.code === 1 && /закрыта/.test( r.out ), r.out );

r = run( 'open', 'https://acme.example/', '-s=other' );
check( 'свой -s — отказ', r.code === 1 && /не передавать/.test( r.out ), r.out );

r = run( 'open', 'https://acme.example/', '--config=x.json' );
check( 'свой --config — отказ', r.code === 1 && /не передавать/.test( r.out ), r.out );

r = run();
check( 'без команды — подсказка', r.code === 1 && /Команда:/.test( r.out ), r.out );

r = run( 'list' );
check( 'list проходит проверки', ! /закрыта|не домен|не передавать/.test( r.out ), r.out );

r = run( 'open', 'https://acme.example/', '--browser=opera' );
check( 'неизвестный браузер — отказ', r.code === 1 && /«opera» не поддерживается/.test( r.out ), r.out );

r = run( 'open', 'https://evil.example/', '--browser', 'webkit' );
check( '--browser webkit: чужой домен — отказ', r.code === 1 && /evil\.example — не домен проекта/.test( r.out ), r.out );

r = run( 'list', '--browser=firefox' );
check( 'list --browser=firefox проходит проверки', ! /закрыта|не домен|не передавать|не поддерживается/.test( r.out ), r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `Провалено: ${ fails }` : 'Все проверки пройдены.' );
process.exit( fails ? 1 : 0 );
